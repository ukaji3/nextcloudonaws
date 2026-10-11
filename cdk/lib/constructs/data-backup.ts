import * as cdk from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as events from 'aws-cdk-lib/aws-events';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as rds from 'aws-cdk-lib/aws-rds';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Properties for {@link DataBackup}.
 */
export interface DataBackupProps {
  /** EFS file system holding config.php, apps and themes. */
  readonly fileSystem: efs.IFileSystem;
  /** Aurora cluster holding the Nextcloud database. */
  readonly dbCluster: rds.IDatabaseCluster;
  /** Retention of daily recovery points, in days. */
  readonly dailyRetentionDays: number;
  /** Retention of weekly recovery points, in days. */
  readonly weeklyRetentionDays: number;
}

/**
 * AWS Backup plan for the stateful resources that S3 versioning does not cover.
 *
 * - Daily at 03:00 JST, kept for {@link DataBackupProps.dailyRetentionDays}.
 * - Weekly on Sunday 03:00 JST, kept for {@link DataBackupProps.weeklyRetentionDays}.
 *
 * The vault and its key are retained when the stack is deleted, so recovery
 * points survive an accidental stack removal.
 */
export class DataBackup extends Construct {
  /** Backup vault storing the recovery points. */
  public readonly vault: backup.BackupVault;

  /** Backup plan containing the daily and weekly rules. */
  public readonly plan: backup.BackupPlan;

  /**
   * @param scope - Parent construct.
   * @param id - Construct id.
   * @param props - Backup targets and retention.
   */
  public constructor(scope: Construct, id: string, props: DataBackupProps) {
    super(scope, id);

    const key = new kms.Key(this, 'VaultKey', {
      description: 'Encrypts the Nextcloud AWS Backup vault',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.vault = new backup.BackupVault(this, 'Vault', {
      encryptionKey: key,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.plan = new backup.BackupPlan(this, 'Plan', {
      backupVault: this.vault,
      backupPlanRules: [
        new backup.BackupPlanRule({
          ruleName: 'Daily',
          // 18:00 UTC = 03:00 JST
          scheduleExpression: events.Schedule.cron({ minute: '0', hour: '18' }),
          startWindow: cdk.Duration.hours(1),
          completionWindow: cdk.Duration.hours(8),
          deleteAfter: cdk.Duration.days(props.dailyRetentionDays),
        }),
        new backup.BackupPlanRule({
          ruleName: 'Weekly',
          // Saturday 18:00 UTC = Sunday 03:00 JST
          scheduleExpression: events.Schedule.cron({ minute: '0', hour: '18', weekDay: 'SAT' }),
          startWindow: cdk.Duration.hours(1),
          completionWindow: cdk.Duration.hours(8),
          deleteAfter: cdk.Duration.days(props.weeklyRetentionDays),
        }),
      ],
    });

    this.plan.addSelection('Selection', {
      resources: [
        backup.BackupResource.fromEfsFileSystem(props.fileSystem),
        backup.BackupResource.fromRdsDatabaseCluster(props.dbCluster),
      ],
    });

    NagSuppressions.addResourceSuppressionsByPath(
      cdk.Stack.of(this),
      `${this.node.path}/Plan/Selection/Role/Resource`,
      [{
        id: 'AwsSolutions-IAM4',
        reason: 'AWSBackupServiceRolePolicyForBackup is the AWS-documented service role policy that AWS Backup requires to snapshot EFS and Aurora',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup'],
      }],
    );
  }
}
