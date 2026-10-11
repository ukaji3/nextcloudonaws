import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { NextcloudAioStack } from '../lib/cdk-stack';

/**
 * テスト用の CDK context。
 * cdk.json.example と同等の構成（全オプション機能を有効化）で synth する。
 */
const testContext: Record<string, string> = {
  domain: 'cloud.example.com',
  hostedZoneId: 'Z0123456789ABCDEFGHIJ',
  hostedZoneName: 'example.com',
  nextcloudImageUri: '111122223333.dkr.ecr.us-east-1.amazonaws.com/aio-nextcloud:test',
  enableOnlyOffice: 'true',
  enableTalk: 'true',
  enableFulltextsearch: 'true',
  enableImaginary: 'true',
  enableClamav: 'false',
};

/**
 * スタックを synth して Template を返す。
 *
 * @returns アサーション用の CloudFormation テンプレート
 */
function synthTemplate(): Template {
  const app = new cdk.App({ context: testContext });
  const stack = new NextcloudAioStack(app, 'TestStack', {
    env: { account: '111122223333', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

describe('NextcloudAioStack', () => {
  const template = synthTemplate();

  describe('Upgrade State Machine', () => {
    test('nextcloud-upgrade ステートマシンが存在する', () => {
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', Match.objectLike({
        StateMachineName: 'nextcloud-upgrade',
      }));
    });

    test('定義に waitForTaskToken ステップと ExitCode 検査が含まれる', () => {
      const machines = template.findResources('AWS::StepFunctions::StateMachine');
      const serialized = JSON.stringify(machines);
      expect(serialized).toContain('WaitForDeploy');
      expect(serialized).toContain('sendMessage.waitForTaskToken');
      expect(serialized).toContain('MaintenanceOnExitCheck');
      expect(serialized).toContain('VerifyUpgradeExitCheck');
      expect(serialized).toContain('BackupConfigExitCheck');
    });

    test('v3 回帰: 成功パスに desired 復元と ALB ターゲット健全化ポーリングがある', () => {
      const machines = template.findResources('AWS::StepFunctions::StateMachine');
      const serialized = JSON.stringify(machines);
      // 成功パスの復元ステップ（cdk deploy は無変更サービスの desired を復元しないため必須）
      expect(serialized).toContain('RestoreBaseline');
      expect(serialized).toContain('RestoreApache');
      // occ 検証前の ALB ターゲット健全化ゲート（二重アップグレード防止）
      expect(serialized).toContain('CheckTargetsHealthy');
      expect(serialized).toContain('describeTargetHealth');
      // WaitForDeploy → RestoreBaseline → TG健全化 → VerifyUpgrade の順序
      const defOrder = serialized.indexOf('RestoreBaseline');
      expect(serialized.indexOf('CheckTargetsHealthy')).toBeGreaterThan(-1);
      expect(defOrder).toBeGreaterThan(-1);
    });

    test('D-1 回帰: UpdateService が Cloud Map 名を参照しない（CFN 参照を使う）', () => {
      const machines = template.findResources('AWS::StepFunctions::StateMachine');
      const serialized = JSON.stringify(machines);
      // Cloud Map のサービスディスカバリ名の直書きが定義に含まれてはならない
      expect(serialized).not.toContain('nextcloud-aio-nextcloud');
      expect(serialized).not.toContain('nextcloud-aio-apache');
      expect(serialized).not.toContain('nextcloud-aio-notify-push');
      // 実サービス名は Fn::GetAtt(Name) で参照される
      expect(serialized).toContain('"Fn::GetAtt"');
    });

    test('occ は www-data ユーザーで実行される（D-4 回帰）', () => {
      const machines = template.findResources('AWS::StepFunctions::StateMachine');
      const serialized = JSON.stringify(machines);
      expect(serialized).toContain('su-exec');
      expect(serialized).not.toContain('sudo');
      expect(serialized).toContain('www-data');
      expect(serialized).toContain('maintenance:mode');
    });
  });

  describe('notify-push', () => {
    const containers = Object.values(template.findResources('AWS::ECS::TaskDefinition'))
      .flatMap((td) => (td as { Properties: { ContainerDefinitions: Record<string, unknown>[] } }).Properties.ContainerDefinitions);
    const notify = containers.find((c) => c.Name === 'notify-push');

    test('config.php を読むため /var/www/html を読み取り専用でマウントする', () => {
      expect(notify?.MountPoints).toEqual([{ ContainerPath: '/var/www/html', ReadOnly: true, SourceVolume: 'nextcloud-html' }]);
    });

    test('DB / Redis の資格情報を渡さない（config.php から読む）', () => {
      expect(notify?.Secrets).toBeUndefined();
      const names = (notify?.Environment as { Name: string }[]).map((e) => e.Name);
      expect(names).not.toContain('POSTGRES_PASSWORD');
      expect(names).not.toContain('REDIS_HOST');
      expect(names).toContain('NEXTCLOUD_HOST');
    });
  });

  describe('Desired count ownership', () => {
    const services = template.findResources('AWS::ECS::Service');
    const byName = (fragment: string): Record<string, unknown> | undefined => {
      const entry = Object.entries(services).find(([id]) => id.startsWith(fragment));
      return entry ? (entry[1] as { Properties: Record<string, unknown> }).Properties : undefined;
    };

    test.each(['nextcloudService', 'apacheService', 'notifypushService'])(
      '並行起動回帰: SFN が台数を管理する %s は DesiredCount を持たない',
      (id) => {
        const props = byName(id);
        expect(props).toBeDefined();
        expect(props?.DesiredCount).toBeUndefined();
      },
    );

    test('SFN 管理外のサービスは DesiredCount を持つ', () => {
      expect(byName('onlyofficeService')?.DesiredCount).toBe(1);
    });
  });

  describe('Trusted proxies', () => {
    test('AWS_TRUSTED_PROXIES に全 NAT Gateway の EIP を渡す', () => {
      const eipIds = Object.keys(template.findResources('AWS::EC2::EIP'));
      expect(eipIds.length).toBe(2);
      const containers = Object.values(template.findResources('AWS::ECS::TaskDefinition'))
        .flatMap((td) => (td as { Properties: { ContainerDefinitions: { Name: string; Environment: { Name: string; Value: unknown }[] }[] } }).Properties.ContainerDefinitions);
      const env = containers.find((c) => c.Name === 'nextcloud')?.Environment.find((e) => e.Name === 'AWS_TRUSTED_PROXIES');
      expect(env?.Value).toEqual({
        'Fn::Join': [' ', eipIds.map((id) => ({ 'Fn::GetAtt': [id, 'PublicIp'] }))],
      });
    });
  });

  describe('WAF (geo restriction)', () => {
    test('日本以外を遮断し、NAT Gateway の IP は常に許可する', () => {
      const acls = Object.values(template.findResources('AWS::WAFv2::WebACL'));
      expect(acls).toHaveLength(1);
      const props = (acls[0] as { Properties: { Scope: string; DefaultAction: unknown; Rules: Record<string, unknown>[] } }).Properties;
      expect(props.Scope).toBe('REGIONAL');
      expect(props.DefaultAction).toEqual({ Allow: {} });
      const [first, second] = props.Rules;
      expect(first.Name).toBe('AllowVpcEgress');
      expect(first.Action).toEqual({ Allow: {} });
      expect(second.Name).toBe('BlockOutsideAllowedCountries');
      expect(second.Action).toEqual({ Block: {} });
      expect(second.Statement).toEqual({
        NotStatement: { Statement: { GeoMatchStatement: { CountryCodes: ['JP'] } } },
      });
    });

    test('IP セットは全 NAT Gateway の EIP/32', () => {
      const eipIds = Object.keys(template.findResources('AWS::EC2::EIP'));
      template.hasResourceProperties('AWS::WAFv2::IPSet', {
        Addresses: eipIds.map((id) => ({ 'Fn::Join': ['', [{ 'Fn::GetAtt': [id, 'PublicIp'] }, '/32']] })),
      });
    });

    test('ALB に関連付けられる', () => {
      template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
      const assoc = Object.values(template.findResources('AWS::WAFv2::WebACLAssociation'))[0] as { Properties: { ResourceArn: { Ref: string } } };
      const albId = Object.keys(template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'))
        .find((id) => id.startsWith('Alb'));
      expect(assoc.Properties.ResourceArn).toEqual({ Ref: albId });
    });

    test('遮断ログのみ記録し、資格情報ヘッダを伏せる', () => {
      template.hasResourceProperties('AWS::WAFv2::LoggingConfiguration', {
        RedactedFields: [
          { SingleHeader: { Name: 'authorization' } },
          { SingleHeader: { Name: 'cookie' } },
          { SingleHeader: { Name: 'requesttoken' } },
        ],
        LoggingFilter: Match.objectLike({ DefaultBehavior: 'DROP' }),
      });
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: 'aws-waf-logs-TestStack',
      });
    });

    test('wafAllowedCountries で許可国を変更できる', () => {
      const app = new cdk.App({ context: { ...testContext, wafAllowedCountries: 'JP, US' } });
      const stack = new NextcloudAioStack(app, 'CountryStack', { env: { account: '111122223333', region: 'us-east-1' } });
      Template.fromStack(stack).hasResourceProperties('AWS::WAFv2::WebACL', Match.objectLike({
        Rules: Match.arrayWith([Match.objectLike({
          Statement: { NotStatement: { Statement: { GeoMatchStatement: { CountryCodes: ['JP', 'US'] } } } },
        })]),
      }));
    });
  });

  describe('Nextcloud container health check', () => {
    test('php-fpm の待受を見る実ヘルスチェック（exit 0 固定ではない）', () => {
      const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
      const nextcloud = Object.values(taskDefs)
        .flatMap((td) => (td as { Properties: { ContainerDefinitions: { Name: string; HealthCheck: Record<string, unknown> }[] } }).Properties.ContainerDefinitions)
        .find((c) => c.Name === 'nextcloud');
      expect(nextcloud?.HealthCheck).toEqual({
        Command: ['CMD-SHELL', '/aws-healthcheck.sh'],
        Interval: 120,
        Timeout: 10,
        Retries: 10,
        StartPeriod: 300,
      });
    });
  });

  describe('Upgrade approval queue', () => {
    test('トークン配送用 SQS キューが DLQ 付きで存在する', () => {
      template.hasResourceProperties('AWS::SQS::Queue', Match.objectLike({
        RedrivePolicy: Match.objectLike({ maxReceiveCount: 10 }),
      }));
    });
  });

  describe('Audit log forwarder', () => {
    test('P1-a 回帰: Lambda がログストリームを自動作成する', () => {
      const fns = template.findResources('AWS::Lambda::Function');
      const serialized = JSON.stringify(fns);
      expect(serialized).toContain('create_log_stream');
      expect(serialized).toContain('ResourceAlreadyExistsException');
    });
  });

  describe('Idempotency regressions', () => {
    test('タスク定義に非決定値 DEPLOY_TS が含まれない（P3 回帰）', () => {
      const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
      expect(JSON.stringify(taskDefs)).not.toContain('DEPLOY_TS');
    });

    test('Aurora のエンジンバージョンが実機と一致する（16.11）', () => {
      template.hasResourceProperties('AWS::RDS::DBCluster', Match.objectLike({
        EngineVersion: '16.11',
      }));
    });
  });

  describe('Alarm notifications', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    // Application Auto Scaling の TargetTracking アラームは CFN 外なので対象はスタック定義の全アラーム
    const alarmEntries = Object.entries(alarms);

    test('KMS 暗号化された SNS トピックが存在する', () => {
      template.hasResourceProperties('AWS::SNS::Topic', Match.objectLike({
        KmsMasterKeyId: Match.anyValue(),
      }));
    });

    test('全アラームが ALARM と OK を SNS に通知する', () => {
      expect(alarmEntries.length).toBeGreaterThanOrEqual(11);
      for (const [, alarm] of alarmEntries) {
        const props = (alarm as { Properties: Record<string, unknown> }).Properties;
        expect(props.AlarmActions).toHaveLength(1);
        expect(props.OKActions).toHaveLength(1);
      }
    });

    test('全アラームが TreatMissingData を明示している（ResponseTime フラップ回帰）', () => {
      for (const [, alarm] of alarmEntries) {
        const props = (alarm as { Properties: Record<string, unknown> }).Properties;
        expect(props.TreatMissingData).toBeDefined();
      }
      template.hasResourceProperties('AWS::CloudWatch::Alarm', Match.objectLike({
        MetricName: 'TargetResponseTime',
        TreatMissingData: 'notBreaching',
      }));
    });

    test('alarmEmails を指定するとメール購読が作成される', () => {
      const app = new cdk.App({ context: { ...testContext, alarmEmails: 'ops@example.com, oncall@example.com' } });
      const stack = new NextcloudAioStack(app, 'MailStack', {
        env: { account: '111122223333', region: 'us-east-1' },
      });
      const t = Template.fromStack(stack);
      t.resourceCountIs('AWS::SNS::Subscription', 2);
      t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
    });
  });

  describe('Data protection', () => {
    test('Aurora の自動バックアップ保持期間が既定 7 日', () => {
      template.hasResourceProperties('AWS::RDS::DBCluster', Match.objectLike({
        BackupRetentionPeriod: 7,
      }));
    });

    test('AWS Backup プランが日次 35 日・週次 90 日で存在する', () => {
      template.hasResourceProperties('AWS::Backup::BackupPlan', Match.objectLike({
        BackupPlan: Match.objectLike({
          BackupPlanRule: Match.arrayWith([
            Match.objectLike({ RuleName: 'Daily', Lifecycle: { DeleteAfterDays: 35 } }),
            Match.objectLike({ RuleName: 'Weekly', Lifecycle: { DeleteAfterDays: 90 } }),
          ]),
        }),
      }));
    });

    test('バックアップ対象に EFS と Aurora が含まれる', () => {
      const selections = JSON.stringify(template.findResources('AWS::Backup::BackupSelection'));
      expect(selections).toContain('elasticfilesystem');
      expect(selections).toContain(':cluster:');
    });

    test('Backup Vault は KMS 暗号化され、スタック削除時も保持される', () => {
      template.hasResource('AWS::Backup::BackupVault', Match.objectLike({
        DeletionPolicy: 'Retain',
        Properties: Match.objectLike({ EncryptionKeyArn: Match.anyValue() }),
      }));
    });
  });

  describe('Image scanning', () => {
    test('aio-nextcloud がプッシュ時スキャン対象', () => {
      template.hasResourceProperties('AWS::ECR::RegistryScanningConfiguration', {
        ScanType: 'BASIC',
        Rules: [{
          ScanFrequency: 'SCAN_ON_PUSH',
          RepositoryFilters: [{ Filter: 'aio-nextcloud', FilterType: 'WILDCARD' }],
        }],
      });
    });
  });
});
