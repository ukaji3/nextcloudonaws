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
      expect(serialized).toContain('sudo');
      expect(serialized).toContain('www-data');
      expect(serialized).toContain('maintenance:mode');
    });
  });

  describe('Upgrade approval queue', () => {
    test('トークン配送用 SQS キューが DLQ 付きで存在する', () => {
      template.hasResourceProperties('AWS::SQS::Queue', Match.objectLike({
        RedrivePolicy: Match.objectLike({ maxReceiveCount: 10 }),
      }));
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
});
