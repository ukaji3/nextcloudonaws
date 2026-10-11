import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

/**
 * Properties for {@link AlarmNotifications}.
 */
export interface AlarmNotificationsProps {
  /**
   * E-mail addresses subscribed to the alarm topic.
   * Each address must confirm the subscription from the AWS e-mail.
   * When empty, the topic is created without subscribers.
   */
  readonly emailAddresses: readonly string[];
}

/**
 * KMS-encrypted SNS topic that receives ALARM and OK transitions of
 * CloudWatch alarms registered through {@link AlarmNotifications.watch}.
 */
export class AlarmNotifications extends Construct {
  /** Topic receiving alarm state changes. */
  public readonly topic: sns.Topic;

  /** Customer managed key used to encrypt the topic. */
  public readonly key: kms.Key;

  private readonly action: cloudwatchActions.SnsAction;

  /**
   * @param scope - Parent construct.
   * @param id - Construct id.
   * @param props - Notification settings.
   */
  public constructor(scope: Construct, id: string, props: AlarmNotificationsProps) {
    super(scope, id);

    this.key = new kms.Key(this, 'TopicKey', {
      description: 'Encrypts the Nextcloud alarm notification topic',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // CloudWatch must be able to publish to the encrypted topic.
    this.key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchAlarmsToUseKey',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'aws:SourceAccount': cdk.Stack.of(this).account },
      },
    }));

    this.topic = new sns.Topic(this, 'Topic', {
      displayName: 'Nextcloud alarms',
      masterKey: this.key,
      enforceSSL: true,
    });

    for (const address of props.emailAddresses) {
      this.topic.addSubscription(new subscriptions.EmailSubscription(address));
    }

    this.action = new cloudwatchActions.SnsAction(this.topic);
  }

  /**
   * Send ALARM and OK transitions of the given alarm to the topic.
   *
   * @param alarm - Alarm to watch.
   */
  public watch(alarm: cloudwatch.IAlarm): void {
    if (alarm instanceof cloudwatch.Alarm) {
      alarm.addAlarmAction(this.action);
      alarm.addOkAction(this.action);
    }
  }
}
