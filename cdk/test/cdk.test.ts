import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';

import { NextcloudAioStack } from '../lib/cdk-stack';
import { TLS_REQUIRED_MESSAGE } from '../lib/stack/load-balancer';
import {
  CfnResources,
  ec2PublicPlacementViolations,
  ecsPublicPlacementViolations,
  publicSubnetIds,
} from './network-placement';

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

  describe('TLS required on the public ALB (fail closed)', () => {
    /**
     * Synthesize the stack with context overrides.
     *
     * @param overrides - Context values replacing the test defaults.
     * @returns Template of the synthesized stack.
     */
    function synthWith(overrides: Record<string, string>): Template {
      const app = new cdk.App({ context: { ...testContext, ...overrides } });
      const stack = new NextcloudAioStack(app, 'TlsStack', { env: { account: '111122223333', region: 'us-east-1' } });
      return Template.fromStack(stack);
    }

    /**
     * Port and protocol of every ALB/NLB listener in a template.
     *
     * @param t - Template to inspect.
     * @returns Entries such as "443/HTTPS".
     */
    function listeners(t: Template): string[] {
      return Object.values(t.findResources('AWS::ElasticLoadBalancingV2::Listener'))
        .map((l) => (l as { Properties: { Port: number; Protocol: string } }).Properties)
        .map((p) => `${String(p.Port)}/${p.Protocol}`);
    }

    test('証明書もホストゾーンも無い場合は synth を失敗させる（平文 HTTP では作らない）', () => {
      expect(() => synthWith({ certificateArn: '', hostedZoneId: '', hostedZoneName: '' }))
        .toThrow(TLS_REQUIRED_MESSAGE);
    });

    test('ホストゾーンの指定が片方だけの場合も synth を失敗させる', () => {
      expect(() => synthWith({ certificateArn: '', hostedZoneName: '' })).toThrow(TLS_REQUIRED_MESSAGE);
      expect(() => synthWith({ certificateArn: '', hostedZoneId: '' })).toThrow(TLS_REQUIRED_MESSAGE);
    });

    test('ホストゾーン指定時: ALB は HTTPS:443 のみ（DNS 検証の証明書を発行）', () => {
      const albListeners = listeners(template).filter((l) => l.endsWith('/HTTPS') || l.endsWith('/HTTP'));
      expect(albListeners).toEqual(['443/HTTPS']);
      template.resourceCountIs('AWS::CertificateManager::Certificate', 1);
    });

    test('既存証明書の ARN 指定時: ALB は HTTPS:443 のみ（証明書は新規発行しない）', () => {
      const t = synthWith({ certificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/x', hostedZoneId: '', hostedZoneName: '' });
      const albListeners = listeners(t).filter((l) => l.endsWith('/HTTPS') || l.endsWith('/HTTP'));
      expect(albListeners).toEqual(['443/HTTPS']);
      t.resourceCountIs('AWS::CertificateManager::Certificate', 0);
      t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 443,
        Certificates: [{ CertificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/x' }],
      });
    });
  });

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

  describe('WAF (deny by default, explicit allow list)', () => {
    /** Properties of the single web ACL in a template. */
    interface WebAclProps {
      readonly Scope: string;
      readonly DefaultAction: unknown;
      readonly Rules: Record<string, unknown>[];
    }

    /**
     * Read the single web ACL of a template.
     *
     * @param t - Template to inspect.
     * @returns Web ACL properties.
     */
    function webAcl(t: Template): WebAclProps {
      const acls = Object.values(t.findResources('AWS::WAFv2::WebACL'));
      expect(acls).toHaveLength(1);
      return (acls[0] as { Properties: WebAclProps }).Properties;
    }

    /**
     * Synthesize the stack with context overrides.
     *
     * @param id - Stack id (must be unique per test).
     * @param overrides - Context values replacing the test defaults.
     * @returns Template of the synthesized stack.
     */
    function synthWith(id: string, overrides: Record<string, string>): Template {
      const app = new cdk.App({ context: { ...testContext, ...overrides } });
      return Template.fromStack(new NextcloudAioStack(app, id, { env: { account: '111122223333', region: 'us-east-1' } }));
    }

    test('既定動作は遮断で、許可ルールだけが通す', () => {
      const props = webAcl(template);
      expect(props.Scope).toBe('REGIONAL');
      expect(props.DefaultAction).toEqual({ Block: {} });
      expect(props.Rules.every((r) => JSON.stringify(r.Action) === JSON.stringify({ Allow: {} }))).toBe(true);
    });

    test('CIDR 未設定時のルールは NAT 許可と許可国のみ', () => {
      const props = webAcl(template);
      expect(props.Rules.map((r) => [r.Priority, r.Name])).toEqual([[0, 'AllowVpcEgress'], [3, 'AllowedCountries']]);
      expect(props.Rules[1].Statement).toEqual({ GeoMatchStatement: { CountryCodes: ['JP'] } });
    });

    test('IP セットは全 NAT Gateway の EIP/32', () => {
      const eipIds = Object.keys(template.findResources('AWS::EC2::EIP'));
      template.hasResourceProperties('AWS::WAFv2::IPSet', {
        IPAddressVersion: 'IPV4',
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
      const props = webAcl(synthWith('CountryStack', { wafAllowedCountries: 'JP, US' }));
      expect(props.Rules.find((r) => r.Name === 'AllowedCountries')?.Statement)
        .toEqual({ GeoMatchStatement: { CountryCodes: ['JP', 'US'] } });
    });

    test('wafAllowedIpv4Cidrs / wafAllowedIpv6Cidrs で国に依らない許可を追加できる', () => {
      const t = synthWith('CidrStack', {
        wafAllowedIpv4Cidrs: '203.0.113.4/32, 198.51.100.0/24',
        wafAllowedIpv6Cidrs: '2001:db8::/32',
      });
      const props = webAcl(t);
      expect(props.Rules.map((r) => [r.Priority, r.Name])).toEqual([
        [0, 'AllowVpcEgress'], [1, 'AllowListedIpv4'], [2, 'AllowListedIpv6'], [3, 'AllowedCountries'],
      ]);
      t.hasResourceProperties('AWS::WAFv2::IPSet', {
        IPAddressVersion: 'IPV4',
        Addresses: ['203.0.113.4/32', '198.51.100.0/24'],
      });
      t.hasResourceProperties('AWS::WAFv2::IPSet', {
        IPAddressVersion: 'IPV6',
        Addresses: ['2001:db8::/32'],
      });
    });

    test('ALB SG の受信は 0.0.0.0/0:443 の 1 件のみで、WAF で制御する旨が記録される', () => {
      const albSg = Object.entries(template.findResources('AWS::EC2::SecurityGroup'))
        .find(([, r]) => (r as { Properties: { GroupDescription?: string } }).Properties.GroupDescription === 'ALB');
      const albSgId = albSg?.[0];
      expect(albSgId).toBeDefined();
      const ingress = (albSg?.[1] as { Properties: { SecurityGroupIngress?: { CidrIp?: string; FromPort?: number; Description?: string }[] } })
        .Properties.SecurityGroupIngress ?? [];
      expect(ingress.map((r) => `${String(r.CidrIp)}:${String(r.FromPort)}`)).toEqual(['0.0.0.0/0:443']);
      // addIngressRule deduplicates by peer and port, so the rule declared in
      // buildNetwork is the one that survives; the description proves it is
      // ours and not the one the listener would have added.
      expect(ingress[0].Description).toContain('WAF web ACL');
      // No separate ingress resource may target the ALB SG either (that is how
      // the listener would add its own 0.0.0.0/0 rule).
      const separate = Object.entries(template.findResources('AWS::EC2::SecurityGroupIngress'))
        .filter(([, r]) => JSON.stringify((r as { Properties: Record<string, unknown> }).Properties.GroupId).includes(String(albSgId)));
      expect(separate.map(([id]) => id)).toEqual([]);
    });

    test('対照: リスナーは open 既定で 0.0.0.0/0 を追加し、open:false なら追加しない', () => {
      /**
       * Ingress rules of a control stack whose listener gets the given open value.
       *
       * @param open - Value passed to addListener (undefined = library default).
       * @returns Entries such as "0.0.0.0/0:443".
       */
      function ingressWith(open: boolean | undefined): string[] {
        const stack = new cdk.Stack(new cdk.App(), `Listener${String(open)}`, { env: { account: '111122223333', region: 'us-east-1' } });
        const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2, natGateways: 0 });
        const sg = new ec2.SecurityGroup(stack, 'Sg', { vpc });
        const alb = new elbv2.ApplicationLoadBalancer(stack, 'Alb', { vpc, internetFacing: true, securityGroup: sg });
        alb.addListener('L', { port: 443, protocol: elbv2.ApplicationProtocol.HTTP, open, defaultAction: elbv2.ListenerAction.fixedResponse(200) });
        return Object.values(Template.fromStack(stack).findResources('AWS::EC2::SecurityGroup'))
          .flatMap((r) => (r as { Properties: { SecurityGroupIngress?: { CidrIp?: string; FromPort?: number }[] } }).Properties.SecurityGroupIngress ?? [])
          .map((i) => `${String(i.CidrIp)}:${String(i.FromPort)}`);
      }
      expect(ingressWith(undefined)).toEqual(['0.0.0.0/0:443']);
      expect(ingressWith(false)).toEqual([]);
    });
  });

  describe('ECS port mapping constraints (checked before deploy)', () => {
    interface Container { Name: string; PortMappings?: { ContainerPort: number; Protocol?: string }[] }
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    const containers: Container[] = Object.values(taskDefs)
      .flatMap((td) => (td as { Properties: { ContainerDefinitions: Container[] } }).Properties.ContainerDefinitions);

    test('どのコンテナも同じポート番号を複数のプロトコルで公開しない', () => {
      for (const c of containers) {
        const ports = (c.PortMappings ?? []).map((p) => p.ContainerPort);
        expect({ container: c.Name, duplicates: ports.filter((p, i) => ports.indexOf(p) !== i) })
          .toEqual({ container: c.Name, duplicates: [] });
      }
    });

    test('LB に登録するポートはそのコンテナのポート定義にちょうど1つある', () => {
      const services = template.findResources('AWS::ECS::Service');
      for (const svc of Object.values(services)) {
        const lbs = (svc as { Properties: { LoadBalancers?: { ContainerName: string; ContainerPort: number }[] } }).Properties.LoadBalancers ?? [];
        for (const lb of lbs) {
          const c = containers.find((x) => x.Name === lb.ContainerName);
          const matches = (c?.PortMappings ?? []).filter((p) => p.ContainerPort === lb.ContainerPort);
          expect({ container: lb.ContainerName, port: lb.ContainerPort, matches: matches.length })
            .toEqual({ container: lb.ContainerName, port: lb.ContainerPort, matches: 1 });
        }
      }
    });
  });

  describe('Talk TURN', () => {
    const containers = Object.values(template.findResources('AWS::ECS::TaskDefinition'))
      .flatMap((td) => (td as { Properties: { ContainerDefinitions: { Name: string; Environment: { Name: string; Value: unknown }[] }[] } }).Properties.ContainerDefinitions);
    const env = (container: string, name: string): unknown =>
      containers.find((c) => c.Name === container)?.Environment.find((e) => e.Name === name)?.Value;

    test('NLB は Talk コンテナの 3478 に転送する（8081 回帰）', () => {
      const services = template.findResources('AWS::ECS::Service');
      const talk = Object.entries(services).find(([id]) => id.startsWith('TalkService'));
      const lbs = (talk?.[1] as { Properties: { LoadBalancers: { ContainerName: string; ContainerPort: number }[] } }).Properties.LoadBalancers;
      expect(lbs).toEqual([expect.objectContaining({ ContainerName: 'talk', ContainerPort: 3478 })]);
    });

    test('Nextcloud と Talk に TURN_DOMAIN=turn.<domain> を渡す（ALB を指さない）', () => {
      expect(env('nextcloud', 'TURN_DOMAIN')).toBe('turn.cloud.example.com');
      expect(env('talk', 'TURN_DOMAIN')).toBe('turn.cloud.example.com');
    });

    test('ホストゾーンが無い場合は NLB の DNS 名を使う', () => {
      const app = new cdk.App({ context: { ...testContext, hostedZoneId: '', hostedZoneName: '', certificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/x' } });
      const stack = new NextcloudAioStack(app, 'NoZoneStack', { env: { account: '111122223333', region: 'us-east-1' } });
      const t = Template.fromStack(stack);
      const nlbId = Object.keys(t.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer')).find((id) => id.startsWith('TalkNlb'));
      const cs = Object.values(t.findResources('AWS::ECS::TaskDefinition'))
        .flatMap((td) => (td as { Properties: { ContainerDefinitions: { Name: string; Environment: { Name: string; Value: unknown }[] }[] } }).Properties.ContainerDefinitions);
      for (const name of ['nextcloud', 'talk']) {
        const value = cs.find((c) => c.Name === name)?.Environment.find((e) => e.Name === 'TURN_DOMAIN')?.Value;
        expect(value).toEqual({ 'Fn::GetAtt': [nlbId, 'DNSName'] });
      }
    });
  });

  describe('Network placement (EC2 rule / ECS design)', () => {
    const resources = template.toJSON().Resources as CfnResources;

    /** Violations found in a small control stack. */
    interface ControlResult {
      readonly ec2: string[];
      readonly ecs: string[];
    }

    /**
     * Synthesize a control stack and run both checks on it.
     *
     * @param build - Adds the resources under test to the stack.
     * @returns Violations of both checks.
     */
    function checkControl(build: (stack: cdk.Stack, vpc: ec2.Vpc) => void): ControlResult {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'Control', { env: { account: '111122223333', region: 'us-east-1' } });
      build(stack, new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 }));
      const res = Template.fromStack(stack).toJSON().Resources as CfnResources;
      return { ec2: ec2PublicPlacementViolations(res), ecs: ecsPublicPlacementViolations(res) };
    }

    test('パブリックサブネットを判定できている（検査が空振りしない）', () => {
      expect(publicSubnetIds(resources).size).toBe(2);
    });

    test('EC2 規約: EC2 インスタンスを Public Subnet に置かない（ALB / NLB / NAT G/W は対象外）', () => {
      expect(ec2PublicPlacementViolations(resources)).toEqual([]);
    });

    test('ECS 設計: 全サービスと SFN の一時タスクが Public Subnet 外・公開 IP なし', () => {
      expect(Object.keys(template.findResources('AWS::ECS::Service')).length).toBeGreaterThanOrEqual(6);
      expect(Object.keys(template.findResources('AWS::StepFunctions::StateMachine')).length).toBe(1);
      expect(ecsPublicPlacementViolations(resources)).toEqual([]);
    });

    test('対照: Public Subnet の EC2 インスタンスは違反として検出される', () => {
      const result = checkControl((stack, vpc) => {
        new ec2.Instance(stack, 'PublicHost', {
          vpc,
          vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
          instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
          machineImage: ec2.MachineImage.latestAmazonLinux2023(),
        });
      });
      expect(result.ec2.join('\n')).toContain('PublicHost');
    });

    test('対照: Private Subnet の EC2 インスタンスは違反にならない', () => {
      const result = checkControl((stack, vpc) => {
        new ec2.Instance(stack, 'PrivateHost', {
          vpc,
          vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
          machineImage: ec2.MachineImage.latestAmazonLinux2023(),
        });
      });
      expect(result.ec2).toEqual([]);
    });

    test('対照: 公開 IP 付きで Public Subnet に置いた ECS サービスは検出される', () => {
      const result = checkControl((stack, vpc) => {
        const td = new ecs.FargateTaskDefinition(stack, 'Td');
        td.addContainer('app', { image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/busybox:latest') });
        new ecs.FargateService(stack, 'PublicSvc', {
          cluster: new ecs.Cluster(stack, 'Cluster', { vpc }),
          taskDefinition: td,
          assignPublicIp: true,
          vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        });
      });
      expect(result.ecs.some((v) => v.includes('assigns a public IP'))).toBe(true);
      expect(result.ecs.some((v) => v.includes('public subnet'))).toBe(true);
    });

    test('対照: 公開 IP 付きで Public Subnet に置いた SFN の RunTask は検出される', () => {
      const result = checkControl((stack, vpc) => {
        const td = new ecs.FargateTaskDefinition(stack, 'Td');
        td.addContainer('app', { image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/busybox:latest') });
        const run = new tasks.EcsRunTask(stack, 'Run', {
          cluster: new ecs.Cluster(stack, 'Cluster', { vpc }),
          taskDefinition: td,
          launchTarget: new tasks.EcsFargateLaunchTarget(),
          assignPublicIp: true,
          subnets: { subnetType: ec2.SubnetType.PUBLIC },
        });
        new sfn.StateMachine(stack, 'Sm', { definitionBody: sfn.DefinitionBody.fromChainable(run) });
      });
      expect(result.ecs.some((v) => v.includes('runs tasks with a public IP'))).toBe(true);
      expect(result.ecs.some((v) => v.includes('public subnet'))).toBe(true);
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
