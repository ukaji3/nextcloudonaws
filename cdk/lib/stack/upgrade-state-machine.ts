import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { ServiceBaselineCounts } from './service-factory';

/**
 * Inputs of {@link buildUpgradeStateMachine}.
 */
export interface UpgradeStateMachineProps {
  readonly cluster: ecs.ICluster;
  readonly ecsSg: ec2.ISecurityGroup;
  readonly nextcloudTaskDefinition: ecs.FargateTaskDefinition;
  readonly nextcloudContainer: ecs.ContainerDefinition;
  readonly taskRole: iam.IRole;
  readonly executionRole: iam.IRole;
  readonly dbCluster: rds.IDatabaseCluster;
  readonly bucket: s3.IBucket;
  readonly apacheTargetGroup: elbv2.IApplicationTargetGroup;
  readonly nextcloudService: ecs.IBaseService;
  readonly apacheService: ecs.IBaseService;
  readonly notifyService: ecs.IBaseService;
  readonly baseline: ServiceBaselineCounts;
}

/**
 * State machine, its role and the approval queue.
 */
export interface UpgradeStateMachineResources {
  readonly stateMachine: sfn.StateMachine;
  readonly sfnRole: iam.Role;
  readonly upgradeQueue: sqs.Queue;
}

/**
 * Chain end points of one step (task + ExitCode check).
 */
interface UpgradeStepChain {
  readonly entry: sfn.IChainable;
  readonly exit: sfn.INextable;
}

/**
 * Poll loop: describe -> choice(done ? ok : wait -> describe).
 */
interface PollLoop {
  readonly entry: sfn.IChainable & sfn.INextable;
  readonly done: sfn.INextable;
}

/**
 * occ prefix: occ must run as the owner of config.php. su-exec is used (as in
 * upstream AIO); it keeps the environment, like the former "sudo -E -u".
 */
const OCC = ['su-exec', 'www-data', 'php', '/var/www/html/occ'];

/**
 * Builds the reusable step types of the upgrade workflow.
 */
class UpgradeStepFactory {
  /**
   * @param scope - Stack owning the states (keeps state ids stable).
   * @param props - Cluster, task definition and networking of the one-off tasks.
   */
  public constructor(
    private readonly scope: Construct,
    private readonly props: UpgradeStateMachineProps,
  ) {}

  /**
   * Run a command in a one-off Fargate task and require ExitCode == 0.
   *
   * RUN_JOB (runTask.sync) waits for the task to stop; a Choice then checks
   * Containers[0].ExitCode. The family's latest ACTIVE revision is started,
   * so steps after the deploy run the new image.
   *
   * @param id - State id prefix.
   * @param command - Container command override.
   * @returns Chain end points.
   */
  public occStep(id: string, command: string[]): UpgradeStepChain {
    const run = new tasks.EcsRunTask(this.scope, id, {
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      cluster: this.props.cluster,
      taskDefinition: this.props.nextcloudTaskDefinition,
      launchTarget: new tasks.EcsFargateLaunchTarget(),
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.props.ecsSg],
      assignPublicIp: false,
      containerOverrides: [{ containerDefinition: this.props.nextcloudContainer, command }],
      taskTimeout: sfn.Timeout.duration(cdk.Duration.minutes(30)),
      resultPath: `$.${id}Result`,
    });
    const ok = new sfn.Pass(this.scope, `${id}Ok`);
    const failed = new sfn.Fail(this.scope, `${id}Failed`, {
      error: `${id}NonZeroExit`,
      cause: `${id}: one-off task container exited with non-zero code`,
    });
    run.next(
      new sfn.Choice(this.scope, `${id}ExitCheck`)
        .when(sfn.Condition.numberEquals(`$.${id}Result.Containers[0].ExitCode`, 0), ok)
        .otherwise(failed),
    );
    return { entry: run, exit: ok };
  }

  /**
   * Set the desired count of an ECS service (CloudFormation-generated name).
   *
   * @param id - State id.
   * @param service - Service to scale.
   * @param count - Desired count.
   * @returns The task state.
   */
  public scale(id: string, service: ecs.IBaseService, count: number): tasks.CallAwsService {
    return new tasks.CallAwsService(this.scope, id, {
      service: 'ecs',
      action: 'updateService',
      parameters: {
        Cluster: this.props.cluster.clusterArn,
        Service: service.serviceName,
        DesiredCount: count,
      },
      iamResources: ['*'],
      resultPath: sfn.JsonPath.DISCARD,
    });
  }

  /**
   * Scale the three web services in parallel.
   *
   * @param id - Parallel state id.
   * @param prefix - Prefix of the branch state ids.
   * @param counts - Desired counts per service.
   * @returns The parallel state.
   */
  public scaleAll(id: string, prefix: string, counts: ServiceBaselineCounts): sfn.Parallel {
    return new sfn.Parallel(this.scope, id, { resultPath: sfn.JsonPath.DISCARD })
      .branch(this.scale(`${prefix}Nextcloud`, this.props.nextcloudService, counts.nextcloud))
      .branch(this.scale(`${prefix}Apache`, this.props.apacheService, counts.apache))
      .branch(this.scale(`${prefix}Notify`, this.props.notifyService, counts.notifyPush));
  }

  /**
   * Poll an API call until a condition holds (no fixed sleeps).
   *
   * @param ids - State ids of the loop.
   * @param ids.wait - Wait state id.
   * @param ids.done - Pass state id reached when the condition holds.
   * @param ids.check - Choice state id.
   * @param describe - Task that refreshes the polled state.
   * @param seconds - Interval between polls.
   * @param condition - Completion condition.
   * @returns Loop end points.
   */
  public poll(
    ids: { wait: string; done: string; check: string },
    describe: tasks.CallAwsService,
    seconds: number,
    condition: sfn.Condition,
  ): PollLoop {
    const wait = new sfn.Wait(this.scope, ids.wait, { time: sfn.WaitTime.duration(cdk.Duration.seconds(seconds)) });
    const done = new sfn.Pass(this.scope, ids.done);
    const check = new sfn.Choice(this.scope, ids.check).when(condition, done).otherwise(wait);
    wait.next(describe);
    describe.next(check);
    return { entry: describe, done };
  }
}

/**
 * Create the state machine role (iam:PassRole and snapshot permissions).
 *
 * @param scope - Stack the role belongs to.
 * @param props - Roles and cluster.
 * @returns The role.
 */
function buildSfnRole(scope: Construct, props: UpgradeStateMachineProps): iam.Role {
  const stack = cdk.Stack.of(scope);
  const sfnRole = new iam.Role(scope, 'SfnRole', {
    assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
  });
  sfnRole.addToPolicy(new iam.PolicyStatement({
    actions: ['iam:PassRole'],
    resources: [props.taskRole.roleArn, props.executionRole.roleArn],
  }));
  sfnRole.addToPolicy(new iam.PolicyStatement({
    actions: ['rds:CreateDBClusterSnapshot', 'rds:DescribeDBClusterSnapshots'],
    resources: [props.dbCluster.clusterArn, `arn:aws:rds:${stack.region}:${stack.account}:cluster-snapshot:*`],
  }));
  return sfnRole;
}

/**
 * Step 3: poll until every web task has stopped.
 *
 * @param scope - Stack owning the states.
 * @param factory - Step factory.
 * @param props - Services to watch.
 * @returns Loop end points.
 */
function waitServicesStopped(scope: Construct, factory: UpgradeStepFactory, props: UpgradeStateMachineProps): PollLoop {
  const describe = new tasks.CallAwsService(scope, 'DescribeAfterScaleDown', {
    service: 'ecs',
    action: 'describeServices',
    parameters: {
      Cluster: props.cluster.clusterArn,
      Services: [props.nextcloudService.serviceName, props.apacheService.serviceName, props.notifyService.serviceName],
    },
    iamResources: ['*'],
    resultPath: '$.scaleDownStatus',
  });
  return factory.poll({ wait: 'WaitTasksStopping', done: 'AllTasksStopped', check: 'CheckTasksStopped' }, describe, 15,
    sfn.Condition.and(
      sfn.Condition.numberEquals('$.scaleDownStatus.Services[0].RunningCount', 0),
      sfn.Condition.numberEquals('$.scaleDownStatus.Services[1].RunningCount', 0),
      sfn.Condition.numberEquals('$.scaleDownStatus.Services[2].RunningCount', 0),
    ));
}

/**
 * Step 4: create the pre-upgrade Aurora snapshot and poll until available.
 *
 * @param scope - Stack owning the states.
 * @param factory - Step factory.
 * @param dbCluster - Cluster to snapshot.
 * @returns Create state and poll loop.
 */
function snapshotDatabase(
  scope: Construct,
  factory: UpgradeStepFactory,
  dbCluster: rds.IDatabaseCluster,
): { create: tasks.CallAwsService; loop: PollLoop } {
  const snapshotId = "States.Format('pre-upgrade-{}', $.executionId)";
  const create = new tasks.CallAwsService(scope, 'CreateSnapshot', {
    service: 'rds',
    action: 'createDBClusterSnapshot',
    parameters: {
      'DbClusterIdentifier': dbCluster.clusterIdentifier,
      'DbClusterSnapshotIdentifier.$': snapshotId,
    },
    iamResources: ['*'],
    resultPath: sfn.JsonPath.DISCARD,
  });
  const describe = new tasks.CallAwsService(scope, 'DescribeSnapshot', {
    service: 'rds',
    action: 'describeDBClusterSnapshots',
    parameters: { 'DbClusterSnapshotIdentifier.$': snapshotId },
    iamResources: ['*'],
    resultPath: '$.snapshotStatus',
  });
  const loop = factory.poll({ wait: 'WaitSnapshotAvailable', done: 'SnapshotAvailable', check: 'CheckSnapshotStatus' }, describe, 30,
    sfn.Condition.stringEquals('$.snapshotStatus.DbClusterSnapshots[0].Status', 'available'));
  return { create, loop };
}

/**
 * Step 5: back up config.php to EFS, and to S3 when the image has aws-cli.
 * Runs on the old image (before the deploy), which may lack aws-cli.
 *
 * @param factory - Step factory.
 * @param bucket - Backup destination bucket.
 * @returns Chain end points.
 */
function backupConfig(factory: UpgradeStepFactory, bucket: s3.IBucket): UpgradeStepChain {
  return factory.occStep('BackupConfig', [
    'sh', '-c',
    [
      'set -e',
      'TS=$(date +%Y%m%d%H%M%S)',
      'cp /var/www/html/config/config.php "/mnt/ncdata/config.php.backup.$TS"',
      'if command -v aws >/dev/null 2>&1; then',
      `  aws s3 cp "/mnt/ncdata/config.php.backup.$TS" "s3://${bucket.bucketName}/backups/config.php.$TS"`,
      'else',
      '  echo "aws-cli not present in this image; EFS backup only"',
      'fi',
    ].join('\n'),
  ]);
}

/**
 * Step 6: deliver the task token over SQS and wait for the operator's deploy.
 *
 * @param scope - Stack owning the queues and the state.
 * @returns Queue and wait state.
 */
function waitForOperatorDeploy(scope: Construct): { queue: sqs.Queue; wait: tasks.SqsSendMessage } {
  const dlq = new sqs.Queue(scope, 'UpgradeApprovalDlq', {
    enforceSSL: true,
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    retentionPeriod: cdk.Duration.days(14),
  });
  NagSuppressions.addResourceSuppressions(dlq, [
    { id: 'AwsSolutions-SQS3', reason: 'This queue is itself the dead-letter queue for the upgrade approval queue.' },
  ]);
  const queue = new sqs.Queue(scope, 'UpgradeApprovalQueue', {
    enforceSSL: true,
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    retentionPeriod: cdk.Duration.days(4),
    visibilityTimeout: cdk.Duration.minutes(5),
    deadLetterQueue: { queue: dlq, maxReceiveCount: 10 },
  });
  const wait = new tasks.SqsSendMessage(scope, 'WaitForDeploy', {
    queue,
    integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
    messageBody: sfn.TaskInput.fromObject({
      action: 'NEXTCLOUD_UPGRADE_READY',
      executionId: sfn.JsonPath.stringAt('$.executionId'),
      taskToken: sfn.JsonPath.taskToken,
      instruction: [
        '1) cdk.json の nextcloudImageUri を新イメージに更新',
        '2) npx cdk deploy NextcloudAioStack',
        '3) aws stepfunctions send-task-success --task-token <taskToken> --task-output {}',
        '中止する場合: aws stepfunctions send-task-failure --task-token <taskToken>',
      ].join(' / '),
    }),
    taskTimeout: sfn.Timeout.duration(cdk.Duration.hours(3)),
    resultPath: sfn.JsonPath.DISCARD,
  });
  return { queue, wait };
}

/**
 * Step 8: poll the ALB target group until the first target is healthy.
 * Health goes through /status.php, so healthy proves apache -> nextcloud
 * connectivity and a finished upgrade before the occ verification runs.
 *
 * @param scope - Stack owning the states.
 * @param factory - Step factory.
 * @param targetGroup - Apache target group.
 * @returns Loop end points.
 */
function waitTargetsHealthy(
  scope: Construct,
  factory: UpgradeStepFactory,
  targetGroup: elbv2.IApplicationTargetGroup,
): PollLoop {
  const describe = new tasks.CallAwsService(scope, 'DescribeTargetHealth', {
    service: 'elasticloadbalancingv2',
    action: 'describeTargetHealth',
    parameters: { TargetGroupArn: targetGroup.targetGroupArn },
    iamAction: 'elasticloadbalancing:DescribeTargetHealth',
    iamResources: ['*'],
    resultPath: '$.tgHealth',
  });
  return factory.poll({ wait: 'WaitTargetsHealthy', done: 'TargetsHealthy', check: 'CheckTargetsHealthy' }, describe, 20,
    sfn.Condition.and(
      sfn.Condition.isPresent('$.tgHealth.TargetHealthDescriptions[0].TargetHealth.State'),
      sfn.Condition.stringEquals('$.tgHealth.TargetHealthDescriptions[0].TargetHealth.State', 'healthy'),
    ));
}

/**
 * Best-effort rollback: restore desired counts and turn maintenance off.
 * The database is recovered from the pre-upgrade snapshot if needed.
 *
 * @param scope - Stack owning the states.
 * @param factory - Step factory.
 * @param baseline - Desired counts to restore.
 * @returns Rollback entry state.
 */
function buildRollback(scope: Construct, factory: UpgradeStepFactory, baseline: ServiceBaselineCounts): sfn.Parallel {
  const rollbackScaleUp = factory.scaleAll('RollbackScaleUp', 'Rollback', baseline);
  const maintenanceOffRollback = factory.occStep('MaintenanceOffRollback', [...OCC, 'maintenance:mode', '--off']);
  const upgradeFailed = new sfn.Fail(scope, 'UpgradeFailed', {
    cause: 'Upgrade failed. Desired counts restored (best effort). Recover DB from the pre-upgrade snapshot if needed.',
  });
  rollbackScaleUp.next(maintenanceOffRollback.entry);
  maintenanceOffRollback.exit.next(upgradeFailed);
  return rollbackScaleUp;
}

/**
 * Create the two-phase upgrade state machine (waitForTaskToken).
 *
 * Phase 1: maintenance ON -> scale web services to 0 -> Aurora snapshot -> config.php backup.
 * The operator then deploys the new image and resumes with the task token.
 * Phase 2: restore desired counts -> wait for healthy targets -> occ status -> maintenance OFF.
 * Any failure triggers the best-effort rollback.
 *
 * @param scope - Stack the resources belong to.
 * @param props - Services, task definition and data stores.
 * @returns State machine, role and approval queue.
 */
export function buildUpgradeStateMachine(scope: Construct, props: UpgradeStateMachineProps): UpgradeStateMachineResources {
  const sfnRole = buildSfnRole(scope, props);
  const factory = new UpgradeStepFactory(scope, props);

  const extractId = new sfn.Pass(scope, 'ExtractExecutionId', {
    parameters: { 'executionId.$': '$$.Execution.Name' },
  });
  const maintenanceOn = factory.occStep('MaintenanceOn', [...OCC, 'maintenance:mode', '--on']);
  const scaleDownAll = factory.scaleAll('ScaleDownAll', 'ScaleDown', { nextcloud: 0, apache: 0, notifyPush: 0 });
  const stopped = waitServicesStopped(scope, factory, props);
  const snapshot = snapshotDatabase(scope, factory, props.dbCluster);
  const backup = backupConfig(factory, props.bucket);
  const approval = waitForOperatorDeploy(scope);
  // cdk deploy only updates services whose task definition changed, so the
  // desired counts lowered by this workflow are restored explicitly.
  const restoreBaseline = factory.scaleAll('RestoreBaseline', 'Restore', props.baseline);
  const healthy = waitTargetsHealthy(scope, factory, props.apacheTargetGroup);
  const verifyUpgrade = factory.occStep('VerifyUpgrade', [...OCC, 'status']);
  const maintenanceOffFinal = factory.occStep('MaintenanceOffFinal', [...OCC, 'maintenance:mode', '--off']);
  const upgradeSucceeded = new sfn.Succeed(scope, 'UpgradeSucceeded');

  maintenanceOn.exit.next(scaleDownAll);
  scaleDownAll.next(stopped.entry);
  stopped.done.next(snapshot.create);
  snapshot.create.next(snapshot.loop.entry);
  snapshot.loop.done.next(backup.entry);
  backup.exit.next(approval.wait);
  approval.wait.next(restoreBaseline);
  restoreBaseline.next(healthy.entry);
  healthy.done.next(verifyUpgrade.entry);
  verifyUpgrade.exit.next(maintenanceOffFinal.entry);
  maintenanceOffFinal.exit.next(upgradeSucceeded);

  const rollback = buildRollback(scope, factory, props.baseline);
  const mainChain = new sfn.Parallel(scope, 'MainChain', { resultPath: sfn.JsonPath.DISCARD });
  mainChain.branch(maintenanceOn.entry);
  mainChain.addCatch(rollback, { resultPath: '$.error' });

  const sfnLogGroup = new logs.LogGroup(scope, 'SfnLogs', {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const stateMachine = new sfn.StateMachine(scope, 'UpgradeStateMachine', {
    definitionBody: sfn.DefinitionBody.fromChainable(extractId.next(mainChain)),
    timeout: cdk.Duration.hours(6),
    role: sfnRole,
    stateMachineName: 'nextcloud-upgrade',
    tracingEnabled: true,
    logs: { destination: sfnLogGroup, level: sfn.LogLevel.ALL },
  });
  new cdk.CfnOutput(scope, 'UpgradeQueueUrl', { value: approval.queue.queueUrl });

  return { stateMachine, sfnRole, upgradeQueue: approval.queue };
}
