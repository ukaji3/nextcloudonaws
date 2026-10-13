import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * Properties for {@link ExecSessionAudit}.
 */
export interface ExecSessionAuditProps {
  /** How long the session transcripts are kept. */
  readonly retention: logs.RetentionDays;
}

/**
 * Audit trail of ECS Exec sessions: a dedicated, KMS-encrypted log group that
 * receives the commands run inside the containers and their output.
 *
 * Without this, the cluster uses the `DEFAULT` logging mode, which writes the
 * transcripts to the awslogs group of the task definition. They then sit in the
 * same log group as the application logs, under stream names
 * (`ecs-execute-command-<id>`) that do not say which service or container was
 * entered, and they are not encrypted with a customer managed key.
 *
 * The KMS key is also used to encrypt the data between the client and the
 * container, so the principal running `ecs execute-command` needs
 * `kms:GenerateDataKey` on it.
 */
export class ExecSessionAudit extends Construct {
  /** Log group receiving the session transcripts. */
  public readonly logGroup: logs.LogGroup;

  /** Key encrypting the log group and the session data. */
  public readonly key: kms.Key;

  /**
   * @param scope - Parent construct.
   * @param id - Construct id.
   * @param props - Retention of the transcripts.
   */
  public constructor(scope: Construct, id: string, props: ExecSessionAuditProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    this.key = new kms.Key(this, 'Key', {
      description: 'ECS Exec session transcripts and client/container traffic',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // CloudWatch Logs encrypts with the key on behalf of this log group only.
    this.key.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal(`logs.${stack.region}.amazonaws.com`)],
      actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
      resources: ['*'],
      conditions: {
        ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:*` },
      },
    }));

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      retention: props.retention,
      encryptionKey: this.key,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }

  /**
   * Cluster configuration that sends every ECS Exec session to this log group.
   *
   * @returns Value for the `executeCommandConfiguration` of the cluster.
   */
  public clusterConfiguration(): ecs.ExecuteCommandConfiguration {
    return {
      kmsKey: this.key,
      logging: ecs.ExecuteCommandLogging.OVERRIDE,
      logConfiguration: {
        cloudWatchLogGroup: this.logGroup,
        cloudWatchEncryptionEnabled: true,
      },
    };
  }
}
