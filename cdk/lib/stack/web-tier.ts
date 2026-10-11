import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { StackConfig } from './config';
import { addEfsVolume, createFargateService, ServiceContext } from './service-factory';
import { FileSystemResources } from './storage';

/**
 * Roles and log group shared by every task definition.
 */
export interface TaskCommon {
  readonly taskRole: iam.IRole;
  readonly executionRole: iam.IRole;
  readonly logGroup: logs.ILogGroup;
}

/**
 * Inputs of {@link buildTalkService}.
 */
export interface TalkProps {
  readonly vpc: ec2.IVpc;
  readonly cluster: ecs.ICluster;
  readonly namespace: servicediscovery.INamespace;
  readonly ecsSg: ec2.ISecurityGroup;
  readonly executionRole: iam.IGrantable;
  readonly hostedZone?: route53.IHostedZone;
  readonly talkSecret: secretsmanager.ISecret;
  readonly signalingSecret: secretsmanager.ISecret;
  readonly talkInternalSecret: secretsmanager.ISecret;
  /** TURN host Janus hands out to clients (same value as Nextcloud's TURN_DOMAIN). */
  readonly turnDomain: string;
}

/**
 * Talk task definition and its TURN load balancer.
 */
export interface TalkResources {
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly nlb: elbv2.NetworkLoadBalancer;
}

/**
 * Container health check settings. The commands are placeholders ("exit 0"):
 * readiness is decided by the ALB target group and by the AIO scripts.
 *
 * @param timeoutSeconds - Health check timeout.
 * @param retries - Retries before unhealthy.
 * @param startPeriodSeconds - Optional grace period.
 * @returns Health check definition.
 */
function placeholderHealthCheck(timeoutSeconds: number, retries: number, startPeriodSeconds?: number): ecs.HealthCheck {
  return {
    command: ['CMD-SHELL', 'exit 0'],
    interval: cdk.Duration.seconds(30),
    timeout: cdk.Duration.seconds(timeoutSeconds),
    retries,
    ...(startPeriodSeconds === undefined ? {} : { startPeriod: cdk.Duration.seconds(startPeriodSeconds) }),
  };
}

/**
 * AIO image reference on ghcr.io.
 *
 * @param name - Image name without the "aio-" prefix.
 * @param tag - Image tag.
 * @returns Container image.
 */
function aioImage(name: string, tag: string): ecs.ContainerImage {
  return ecs.ContainerImage.fromRegistry(`ghcr.io/nextcloud-releases/aio-${name}:${tag}`);
}

/**
 * Create the Apache (reverse proxy) task definition.
 *
 * @param scope - Stack the resources belong to.
 * @param config - Deployment parameters.
 * @param common - Roles and log group.
 * @param files - EFS file system and access points.
 * @returns Task definition.
 */
export function buildApacheTask(
  scope: Construct,
  config: StackConfig,
  common: TaskCommon,
  files: FileSystemResources,
): ecs.FargateTaskDefinition {
  const td = new ecs.FargateTaskDefinition(scope, 'ApacheTd', {
    cpu: 512, memoryLimitMiB: 1024,
    taskRole: common.taskRole, executionRole: common.executionRole,
  });
  addEfsVolume(td, 'nextcloud-html', files.fileSystem.fileSystemId, files.apNextcloudHtml.accessPointId);
  addEfsVolume(td, 'apache-data', files.fileSystem.fileSystemId, files.apApacheData.accessPointId);

  const container = td.addContainer('apache', {
    image: aioImage('apache', config.aioImageTag),
    logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'apache', logGroup: common.logGroup }),
    portMappings: [{ containerPort: config.apachePort }],
    healthCheck: placeholderHealthCheck(30, 3, 60),
    environment: {
      APACHE_PORT: String(config.apachePort),
      APACHE_MAX_SIZE: '17179869184',
      APACHE_MAX_TIME: '3600',
      NC_DOMAIN: config.domain,
      APACHE_HOST: 'nextcloud-aio-apache.nextcloud.local',
      NEXTCLOUD_HOST: 'nextcloud-aio-nextcloud.nextcloud.local',
      NOTIFY_PUSH_HOST: 'nextcloud-aio-notify-push.nextcloud.local',
      ONLYOFFICE_HOST: config.enableOnlyOffice ? 'nextcloud-aio-onlyoffice.nextcloud.local' : 'localhost',
      TALK_HOST: config.enableTalk ? 'nextcloud-aio-talk.nextcloud.local' : 'localhost',
      COLLABORA_HOST: 'localhost',
      WHITEBOARD_HOST: 'localhost',
      HARP_HOST: 'localhost',
      TZ: 'Asia/Tokyo',
    },
  });
  container.addMountPoints(
    { sourceVolume: 'nextcloud-html', containerPath: '/var/www/html', readOnly: true },
    { sourceVolume: 'apache-data', containerPath: '/mnt/data', readOnly: false },
  );
  return td;
}

/**
 * Create the notify-push task definition.
 *
 * The AIO image (2026-01 and later) runs
 * `notify_push --port 7867 /var/www/html/config/config.php`: database, Redis
 * and the Nextcloud URL are read from the main config.php. Its literal
 * `redis.cluster` entry (TLS seeds) makes notify_push use a cluster-mode
 * client, which ElastiCache Serverless requires. No database or Redis
 * credentials are passed to the container.
 *
 * @param scope - Stack the resources belong to.
 * @param config - Deployment parameters.
 * @param common - Roles and log group.
 * @param files - EFS file system and access points.
 * @returns Task definition.
 */
export function buildNotifyPushTask(
  scope: Construct,
  config: StackConfig,
  common: TaskCommon,
  files: FileSystemResources,
): ecs.FargateTaskDefinition {
  const td = new ecs.FargateTaskDefinition(scope, 'NotifyPushTd', {
    cpu: 256, memoryLimitMiB: 512,
    taskRole: common.taskRole, executionRole: common.executionRole,
  });
  addEfsVolume(td, 'nextcloud-html', files.fileSystem.fileSystemId, files.apNextcloudHtml.accessPointId);
  const container = td.addContainer('notify-push', {
    image: aioImage('notify-push', config.aioNotifyPushImageTag),
    logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'notify-push', logGroup: common.logGroup }),
    portMappings: [{ containerPort: 7867 }],
    healthCheck: placeholderHealthCheck(30, 3, 60),
    environment: {
      // start.sh waits for <NEXTCLOUD_HOST>:9001 before starting
      NEXTCLOUD_HOST: 'nextcloud-aio-nextcloud.nextcloud.local',
      AIO_LOG_LEVEL: 'warn',
      TZ: 'Asia/Tokyo',
    },
  });
  container.addMountPoints({ sourceVolume: 'nextcloud-html', containerPath: '/var/www/html', readOnly: true });
  return td;
}

/**
 * Create the OnlyOffice document server (task definition, data access point, service).
 *
 * @param ctx - Shared service placement.
 * @param config - Deployment parameters.
 * @param common - Roles and log group.
 * @param files - EFS file system.
 * @param jwtSecret - JWT secret shared with Nextcloud.
 */
export function buildOnlyOfficeService(
  ctx: ServiceContext,
  config: StackConfig,
  common: TaskCommon,
  files: FileSystemResources,
  jwtSecret: secretsmanager.ISecret,
): void {
  const apOnlyoffice = files.fileSystem.addAccessPoint('OnlyofficeData', {
    path: '/onlyoffice-data',
    posixUser: { uid: '104', gid: '104' },
    createAcl: { ownerUid: '104', ownerGid: '104', permissions: '777' },
  });
  const td = new ecs.FargateTaskDefinition(ctx.scope, 'OnlyofficeTd', {
    cpu: 2048, memoryLimitMiB: 4096,
    taskRole: common.taskRole, executionRole: common.executionRole,
  });
  addEfsVolume(td, 'onlyoffice-data', files.fileSystem.fileSystemId, apOnlyoffice.accessPointId);
  const container = td.addContainer('onlyoffice', {
    image: aioImage('onlyoffice', config.aioImageTag),
    logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'onlyoffice', logGroup: common.logGroup }),
    portMappings: [{ containerPort: 80 }],
    healthCheck: placeholderHealthCheck(30, 9, 120),
    environment: {
      JWT_ENABLED: 'true',
      JWT_HEADER: 'AuthorizationJwt',
      TZ: 'Asia/Tokyo',
    },
    secrets: {
      JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret),
    },
  });
  container.addMountPoints({ sourceVolume: 'onlyoffice-data', containerPath: '/var/lib/onlyoffice', readOnly: false });
  createFargateService(ctx, 'onlyoffice', td);
  NagSuppressions.addResourceSuppressions(td, [
    { id: 'AwsSolutions-ECS2', reason: 'Non-sensitive configuration values (feature flags) passed as environment variables' },
  ]);
}

/**
 * Create the Imaginary preview generator (task definition and service).
 *
 * @param ctx - Shared service placement.
 * @param config - Deployment parameters.
 * @param common - Roles and log group.
 * @param imaginarySecret - Shared key between Nextcloud and Imaginary.
 * @returns Task definition.
 */
export function buildImaginaryService(
  ctx: ServiceContext,
  config: StackConfig,
  common: TaskCommon,
  imaginarySecret: secretsmanager.ISecret,
): ecs.FargateTaskDefinition {
  const td = new ecs.FargateTaskDefinition(ctx.scope, 'ImaginaryTd', {
    cpu: 512, memoryLimitMiB: 1024,
    taskRole: common.taskRole, executionRole: common.executionRole,
  });
  td.addContainer('imaginary', {
    image: aioImage('imaginary', config.aioImageTag),
    logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'imaginary', logGroup: common.logGroup }),
    portMappings: [{ containerPort: 9000 }],
    healthCheck: placeholderHealthCheck(30, 3),
    environment: { TZ: 'Asia/Tokyo' },
    secrets: { IMAGINARY_SECRET: ecs.Secret.fromSecretsManager(imaginarySecret) },
  });
  createFargateService(ctx, 'imaginary', td);
  return td;
}

/**
 * Create the Talk task definition (signaling, Janus, TURN).
 *
 * @param scope - Stack the resources belong to.
 * @param config - Deployment parameters.
 * @param common - Roles and log group.
 * @param props - Talk secrets.
 * @returns Task definition.
 */
function buildTalkTask(scope: Construct, config: StackConfig, common: TaskCommon, props: TalkProps): ecs.FargateTaskDefinition {
  const td = new ecs.FargateTaskDefinition(scope, 'TalkTd', {
    cpu: 512, memoryLimitMiB: 1024,
    taskRole: common.taskRole, executionRole: common.executionRole,
  });
  td.addContainer('talk', {
    image: aioImage('talk', config.aioImageTag),
    logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'talk', logGroup: common.logGroup }),
    // ECS cannot expose one container port for two protocols (API PortMapping:
    // "You can't expose the same container port for multiple protocols"; a service
    // registering such a port with a load balancer fails with "Container port 3478
    // is used in more than one port mapping"). In awsvpc mode the mappings do not
    // filter traffic, so UDP 3478 still reaches eturnal; access is controlled by
    // the security group and the NLB TCP_UDP listener.
    portMappings: [
      { containerPort: 8081, protocol: ecs.Protocol.TCP },
      { containerPort: 3478, protocol: ecs.Protocol.TCP },
    ],
    healthCheck: placeholderHealthCheck(5, 3),
    environment: {
      NC_DOMAIN: config.domain,
      TALK_HOST: 'nextcloud-aio-talk.nextcloud.local',
      TALK_PORT: '3478',
      // Janus turn_server; without it start.sh falls back to NC_DOMAIN (the ALB, no 3478 listener)
      TURN_DOMAIN: props.turnDomain,
      TZ: 'Asia/Tokyo',
    },
    secrets: {
      TURN_SECRET: ecs.Secret.fromSecretsManager(props.talkSecret),
      SIGNALING_SECRET: ecs.Secret.fromSecretsManager(props.signalingSecret),
      INTERNAL_SECRET: ecs.Secret.fromSecretsManager(props.talkInternalSecret),
    },
  });
  return td;
}

/**
 * Create the internet-facing NLB relaying TURN (TCP+UDP 3478) to Talk,
 * and the turn.<domain> alias when a hosted zone is configured.
 *
 * @param scope - Stack the resources belong to.
 * @param config - Deployment parameters.
 * @param props - Network and DNS.
 * @param talkSvc - Talk service registered as target.
 * @returns The load balancer.
 */
function buildTurnLoadBalancer(
  scope: Construct,
  config: StackConfig,
  props: TalkProps,
  talkSvc: ecs.FargateService,
): elbv2.NetworkLoadBalancer {
  const nlb = new elbv2.NetworkLoadBalancer(scope, 'TalkNlb', {
    vpc: props.vpc,
    internetFacing: true,
    crossZoneEnabled: true,
  });
  nlb.addListener('Turn', { port: 3478, protocol: elbv2.Protocol.TCP_UDP })
    .addTargets('TurnTarget', {
      port: 3478,
      protocol: elbv2.Protocol.TCP_UDP,
      // Register the task's 3478 (TCP_UDP target group, ip targets). Without an
      // explicit container port ECS registers the first mapping, 8081 (signaling).
      // Health is still checked on 8081.
      targets: [talkSvc.loadBalancerTarget({ containerName: 'talk', containerPort: 3478 })],
      healthCheck: { protocol: elbv2.Protocol.TCP, port: '8081' },
    });
  new cdk.CfnOutput(scope, 'TalkNlbDns', { value: nlb.loadBalancerDnsName });

  if (props.hostedZone) {
    new route53.ARecord(scope, 'TurnDnsRecord', {
      zone: props.hostedZone,
      recordName: `turn.${config.domain}`,
      target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(nlb)),
    });
  }
  return nlb;
}

/**
 * Create Nextcloud Talk: security group, task definition, service and TURN NLB.
 *
 * @param scope - Stack the resources belong to.
 * @param config - Deployment parameters.
 * @param common - Roles and log group.
 * @param props - Placement, DNS and secrets.
 * @returns Task definition and NLB.
 */
export function buildTalkService(scope: Construct, config: StackConfig, common: TaskCommon, props: TalkProps): TalkResources {
  const talkSg = new ec2.SecurityGroup(scope, 'TalkSg', { vpc: props.vpc, description: 'Talk TURN' });
  talkSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3478), 'TURN TCP');
  talkSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(3478), 'TURN UDP');
  talkSg.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(8081), 'NLB health check');

  const taskDefinition = buildTalkTask(scope, config, common, props);

  const talkSvc = new ecs.FargateService(scope, 'TalkService', {
    cluster: props.cluster,
    taskDefinition,
    desiredCount: 1,
    securityGroups: [props.ecsSg, talkSg],
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    cloudMapOptions: {
      name: 'nextcloud-aio-talk',
      cloudMapNamespace: props.namespace,
      dnsRecordType: servicediscovery.DnsRecordType.A,
      dnsTtl: cdk.Duration.seconds(10),
    },
    enableExecuteCommand: true,
  });

  const nlb = buildTurnLoadBalancer(scope, config, props, talkSvc);

  [props.talkSecret, props.signalingSecret, props.talkInternalSecret].forEach((s) => s.grantRead(props.executionRole));
  NagSuppressions.addResourceSuppressions(talkSg, [
    { id: 'AwsSolutions-EC23', reason: 'TURN server requires public access on port 3478 for WebRTC relay' },
  ]);
  return { taskDefinition, nlb };
}
