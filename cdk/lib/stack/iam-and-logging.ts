import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as logsDestinations from 'aws-cdk-lib/aws-logs-destinations';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { FeatureSecrets } from './feature-secrets';

/**
 * Inputs of {@link buildTaskRoles}.
 */
export interface TaskRolesProps {
  readonly bucket: s3.IBucket;
  readonly dbSecret: secretsmanager.ISecret;
  readonly cacheSecret: secretsmanager.ISecret;
  readonly featureSecrets: FeatureSecrets;
}

/**
 * ECS task / execution roles and the application secrets read at task start.
 */
export interface TaskRolesResources {
  readonly taskRole: iam.Role;
  readonly executionRole: iam.Role;
  readonly adminSecret: secretsmanager.Secret;
  readonly onlyofficeSecret: secretsmanager.Secret;
}

/**
 * Application and audit log groups plus the audit log forwarder.
 */
export interface LoggingResources {
  readonly logGroup: logs.LogGroup;
  readonly auditLogGroup: logs.LogGroup;
  readonly auditFn: lambda.Function;
}

/**
 * Python source of the audit log forwarder.
 * Copies admin_audit events into the long-retention audit log group.
 */
const AUDIT_FORWARDER_SOURCE = `
import base64, gzip, json, os, boto3
client = boto3.client('logs')
LOG_GROUP = os.environ['AUDIT_LOG_GROUP']
_known_streams = set()

def _ensure_stream(name):
    """転送先ロググループにストリームが無ければ作成する（warm 実行間でキャッシュ）。"""
    if name in _known_streams:
        return
    try:
        client.create_log_stream(logGroupName=LOG_GROUP, logStreamName=name)
    except client.exceptions.ResourceAlreadyExistsException:
        pass
    _known_streams.add(name)

def handler(event, context):
    data = json.loads(gzip.decompress(base64.b64decode(event['awslogs']['data'])))
    stream = data['logStream']
    _ensure_stream(stream)
    events = [{'timestamp': e['timestamp'], 'message': e['message']} for e in data['logEvents']]
    events.sort(key=lambda e: e['timestamp'])
    # PutLogEvents の上限（1バッチ10,000件/1MB）に対する保守的な分割
    for i in range(0, len(events), 1000):
        client.put_log_events(
            logGroupName=LOG_GROUP,
            logStreamName=stream,
            logEvents=events[i:i+1000],
        )
`;

/**
 * Create the task and execution roles and grant access to the secrets.
 * Grant order is significant: it defines the statement order of the policies.
 *
 * @param scope - Stack the resources belong to.
 * @param props - Bucket and secrets to grant.
 * @returns Roles and application secrets.
 */
export function buildTaskRoles(scope: Construct, props: TaskRolesProps): TaskRolesResources {
  const taskRole = new iam.Role(scope, 'TaskRole', {
    assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
  });
  props.bucket.grantReadWrite(taskRole);

  const executionRole = new iam.Role(scope, 'ExecRole', {
    assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')],
  });
  props.dbSecret.grantRead(executionRole);
  props.cacheSecret.grantRead(executionRole);
  props.featureSecrets.osSecret?.grantRead(executionRole);
  const adminSecret = new secretsmanager.Secret(scope, 'AdminSecret', {
    generateSecretString: { excludePunctuation: false, passwordLength: 24 },
  });
  adminSecret.grantRead(executionRole);
  const onlyofficeSecret = new secretsmanager.Secret(scope, 'OnlyofficeSecret', {
    generateSecretString: { excludePunctuation: true, passwordLength: 32 },
  });
  onlyofficeSecret.grantRead(executionRole);
  props.featureSecrets.imaginarySecret?.grantRead(executionRole);

  return { taskRole, executionRole, adminSecret, onlyofficeSecret };
}

/**
 * Create the ECS log group, the 1-year audit log group and the forwarder
 * subscribed to admin_audit events.
 *
 * @param scope - Stack the resources belong to.
 * @returns Logging resources.
 */
export function buildLogging(scope: Construct): LoggingResources {
  const logGroup = new logs.LogGroup(scope, 'EcsLogs', {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  // Audit log: separate log group with 365-day retention
  const auditLogGroup = new logs.LogGroup(scope, 'AuditLogs', {
    retention: logs.RetentionDays.ONE_YEAR,
  });

  const auditFn = new lambda.Function(scope, 'AuditLogForwarder', {
    runtime: lambda.Runtime.PYTHON_3_14,
    handler: 'index.handler',
    code: lambda.Code.fromInline(AUDIT_FORWARDER_SOURCE),
    environment: { AUDIT_LOG_GROUP: auditLogGroup.logGroupName },
    timeout: cdk.Duration.seconds(30),
  });
  auditLogGroup.grantWrite(auditFn);

  new logs.SubscriptionFilter(scope, 'AuditFilter', {
    logGroup,
    destination: new logsDestinations.LambdaDestination(auditFn),
    filterPattern: logs.FilterPattern.literal('admin_audit'),
  });

  return { logGroup, auditLogGroup, auditFn };
}
