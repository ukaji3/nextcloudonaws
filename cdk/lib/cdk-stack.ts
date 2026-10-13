import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { DataBackup } from './constructs/data-backup';
import { GeoRestrictedWebAcl } from './constructs/geo-restricted-web-acl';
import { ImageScanning } from './constructs/image-scanning';
import { loadStackConfig, StackConfig } from './stack/config';
import { buildCache, buildDatabase } from './stack/database';
import { buildFeatureSecrets, buildSearchDomain, FeatureSecrets } from './stack/feature-secrets';
import { buildLogging, buildTaskRoles } from './stack/iam-and-logging';
import { buildDnsRecord, buildLoadBalancer } from './stack/load-balancer';
import { buildAlarms, buildDashboard, buildErrorMetric } from './stack/monitoring';
import { applyNagSuppressions } from './stack/nag-suppressions';
import { buildNetwork, NetworkResources } from './stack/network';
import { buildNextcloudTask } from './stack/nextcloud-task';
import { createFargateService, ServiceBaselineCounts, ServiceContext } from './stack/service-factory';
import { buildBuckets, buildFileSystem, FileSystemResources } from './stack/storage';
import { buildUpgradeStateMachine } from './stack/upgrade-state-machine';
import {
  buildApacheTask,
  buildImaginaryService,
  buildNotifyPushTask,
  buildOnlyOfficeService,
  buildTalkService,
  TaskCommon,
} from './stack/web-tier';

/** Normal-operation desired counts (shared with the upgrade state machine). */
const SERVICE_BASELINE: ServiceBaselineCounts = { nextcloud: 1, apache: 2, notifyPush: 1 };

/**
 * Inputs of the optional services (OnlyOffice, Imaginary, Talk).
 */
interface OptionalServicesInput {
  readonly config: StackConfig;
  readonly ctx: ServiceContext;
  readonly common: TaskCommon;
  readonly files: FileSystemResources;
  readonly network: NetworkResources;
  readonly featureSecrets: FeatureSecrets;
  readonly onlyofficeSecret: secretsmanager.ISecret;
  readonly hostedZone?: route53.IHostedZone;
  /** TURN/STUN host for clients (see the constructor). */
  readonly turnDomain: string;
}

/**
 * Optional resources created by {@link NextcloudAioStack.buildOptionalServices}.
 */
interface OptionalServices {
  readonly taskDefinitions: ecs.TaskDefinition[];
  readonly talkNlb?: elbv2.NetworkLoadBalancer;
}

/**
 * Nextcloud on AWS: ECS Fargate (AIO containers) with Aurora Serverless v2,
 * ElastiCache Serverless, S3, EFS and optional OpenSearch / OnlyOffice /
 * Imaginary / Talk. Every resource is created by the builders in ./stack and
 * ./constructs with this stack as scope, so logical IDs stay stable.
 */
export class NextcloudAioStack extends cdk.Stack {
  /**
   * @param scope - Parent construct.
   * @param id - Stack id.
   * @param props - Stack properties.
   */
  public constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const config = loadStackConfig(this);
    const hostedZone = this.resolveHostedZone(config);

    const network = buildNetwork(this, config.apachePort);
    const files = buildFileSystem(this, network.vpc, network.efsSg);
    const { dbSecret, dbCluster } = buildDatabase(this, {
      vpc: network.vpc,
      dbSg: network.dbSg,
      minAcu: config.auroraMinAcu,
      maxAcu: config.auroraMaxAcu,
      backupRetentionDays: config.auroraBackupRetentionDays,
    });
    const { cacheSecret, cache } = buildCache(this, network.vpc, network.cacheSg);
    const { accessLogBucket, bucket } = buildBuckets(this);
    const featureSecrets = buildFeatureSecrets(this, {
      fulltextsearch: config.enableFulltextsearch,
      imaginary: config.enableImaginary,
      talk: config.enableTalk,
    });
    const osDomain = buildSearchDomain(this, { vpc: network.vpc, ecsSg: network.ecsSg, osSecret: featureSecrets.osSecret });

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc: network.vpc, containerInsights: true });
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', { name: 'nextcloud.local', vpc: network.vpc });
    const ctx: ServiceContext = { scope: this, cluster, namespace, ecsSg: network.ecsSg };

    const { taskRole, executionRole, adminSecret, onlyofficeSecret } = buildTaskRoles(this, { bucket, dbSecret, cacheSecret, featureSecrets });
    const { logGroup, auditFn } = buildLogging(this);
    const common: TaskCommon = { taskRole, executionRole, logGroup };

    // TURN/STUN host handed to clients. With a hosted zone it is turn.<domain>
    // (alias to the Talk NLB); otherwise the NLB DNS name, which only exists
    // once Talk is built, hence the lazy value.
    const talkNlb: { dnsName?: string } = {};
    const turnDomain = hostedZone
      ? `turn.${config.domain}`
      : cdk.Lazy.string({ produce: () => talkNlb.dnsName ?? config.domain });

    const nextcloud = buildNextcloudTask(this, {
      config, taskRole, executionRole, logGroup, files, bucket, dbCluster, dbSecret, cache,
      adminSecret, onlyofficeSecret, featureSecrets, osDomain, trustedProxies: network.natPublicIps, turnDomain,
    });
    // nextcloud / apache / notify-push: the upgrade state machine owns their
    // desired count (scale to 0, restore SERVICE_BASELINE), so CloudFormation
    // must not change it on update.
    const nextcloudSvc = createFargateService(ctx, 'nextcloud', nextcloud.taskDefinition, {
      desiredCount: SERVICE_BASELINE.nextcloud, minCapacity: 1, maxCapacity: 10, managedDesiredCount: true,
    });

    const apacheTd = buildApacheTask(this, config, common, files);
    const apacheSvc = createFargateService(ctx, 'apache', apacheTd, {
      desiredCount: SERVICE_BASELINE.apache, minCapacity: 2, maxCapacity: 5, managedDesiredCount: true,
    });
    apacheSvc.node.addDependency(nextcloudSvc);

    const notifyTd = buildNotifyPushTask(this, config, common, files);
    const notifySvc = createFargateService(ctx, 'notify-push', notifyTd, {
      desiredCount: SERVICE_BASELINE.notifyPush, managedDesiredCount: true,
    });
    notifySvc.node.addDependency(nextcloudSvc);

    const optional = this.buildOptionalServices({
      config, ctx, common, files, network, featureSecrets, onlyofficeSecret, hostedZone, turnDomain,
    });
    talkNlb.dnsName = optional.talkNlb?.loadBalancerDnsName;

    const { alb, apacheTargetGroup } = buildLoadBalancer(this, config, {
      vpc: network.vpc, albSg: network.albSg, accessLogBucket, apacheService: apacheSvc, hostedZone,
    });
    new GeoRestrictedWebAcl(this, 'AlbWebAcl', {
      loadBalancer: alb,
      allowedCountries: config.wafAllowedCountries,
      alwaysAllowedIpv4: network.natPublicIps,
      allowedIpv4Cidrs: config.wafAllowedIpv4Cidrs,
      allowedIpv6Cidrs: config.wafAllowedIpv6Cidrs,
    });

    const { stateMachine, sfnRole } = buildUpgradeStateMachine(this, {
      cluster, ecsSg: network.ecsSg,
      nextcloudTaskDefinition: nextcloud.taskDefinition, nextcloudContainer: nextcloud.container,
      taskRole, executionRole, dbCluster, bucket, apacheTargetGroup,
      nextcloudService: nextcloudSvc, apacheService: apacheSvc, notifyService: notifySvc,
      baseline: SERVICE_BASELINE,
    });

    const monitoringTargets = {
      nextcloudService: nextcloudSvc, apacheService: apacheSvc, notifyService: notifySvc,
      alb, dbCluster, logGroup, auroraMaxAcu: config.auroraMaxAcu, alarmEmails: config.alarmEmails,
    };
    const errorMetric = buildErrorMetric(this, logGroup);
    buildAlarms(this, monitoringTargets, errorMetric);
    new DataBackup(this, 'DataBackup', {
      fileSystem: files.fileSystem,
      dbCluster,
      dailyRetentionDays: config.backupDailyRetentionDays,
      weeklyRetentionDays: config.backupWeeklyRetentionDays,
    });
    new ImageScanning(this, 'ImageScanning', { repositoryNames: config.ecrScanRepositories });
    buildDashboard(this, monitoringTargets, errorMetric);

    new cdk.CfnOutput(this, 'AlbDns', { value: alb.loadBalancerDnsName });
    if (hostedZone) {
      buildDnsRecord(this, config, hostedZone, alb);
    }
    new cdk.CfnOutput(this, 'S3Bucket', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'AuroraEndpoint', { value: dbCluster.clusterEndpoint.hostname });
    new cdk.CfnOutput(this, 'CacheEndpoint', { value: cache.attrEndpointAddress });
    new cdk.CfnOutput(this, 'EfsId', { value: files.fileSystem.fileSystemId });
    if (osDomain) {
      new cdk.CfnOutput(this, 'OsEndpoint', { value: osDomain.domainEndpoint });
    }
    new cdk.CfnOutput(this, 'UpgradeStateMachineArn', { value: stateMachine.stateMachineArn });

    applyNagSuppressions({
      albSg: network.albSg, executionRole, taskRole, sfnRole, auditFn,
      secrets: this.collectSecrets([dbSecret, cacheSecret, adminSecret, onlyofficeSecret], featureSecrets),
      taskDefinitions: [nextcloud.taskDefinition, apacheTd, notifyTd, ...optional.taskDefinitions],
      accessLogBucket, dbCluster, osDomain, talkNlb: optional.talkNlb,
    });
  }

  /**
   * Import the Route 53 hosted zone when both id and name are configured.
   *
   * @param config - Deployment parameters.
   * @returns Hosted zone, or undefined.
   */
  private resolveHostedZone(config: StackConfig): route53.IHostedZone | undefined {
    if (!config.hostedZoneId || !config.hostedZoneName) {
      return undefined;
    }
    return route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: config.hostedZoneId,
      zoneName: config.hostedZoneName,
    });
  }

  /**
   * Create OnlyOffice, Imaginary and Talk according to the feature flags.
   *
   * @param input - Shared resources and feature flags.
   * @returns Task definitions needing the ECS2 exception, and the Talk NLB.
   */
  private buildOptionalServices(input: OptionalServicesInput): OptionalServices {
    const { config, ctx, common, featureSecrets: s } = input;
    const taskDefinitions: ecs.TaskDefinition[] = [];
    let talkNlb: elbv2.NetworkLoadBalancer | undefined;

    if (config.enableOnlyOffice) {
      buildOnlyOfficeService(ctx, config, common, input.files, input.onlyofficeSecret);
    }
    if (config.enableImaginary && s.imaginarySecret) {
      taskDefinitions.push(buildImaginaryService(ctx, config, common, s.imaginarySecret));
    }
    if (config.enableTalk && s.talkSecret && s.signalingSecret && s.talkInternalSecret) {
      const talk = buildTalkService(this, config, common, {
        vpc: input.network.vpc,
        cluster: ctx.cluster,
        namespace: ctx.namespace,
        ecsSg: ctx.ecsSg,
        executionRole: common.executionRole,
        hostedZone: input.hostedZone,
        talkSecret: s.talkSecret,
        signalingSecret: s.signalingSecret,
        talkInternalSecret: s.talkInternalSecret,
        turnDomain: input.turnDomain,
      });
      taskDefinitions.push(talk.taskDefinition);
      talkNlb = talk.nlb;
    }
    return { taskDefinitions, talkNlb };
  }

  /**
   * Secrets subject to the rotation (SMG4) exception.
   *
   * @param base - Secrets that always exist.
   * @param s - Optional feature secrets.
   * @returns All existing secrets.
   */
  private collectSecrets(base: secretsmanager.ISecret[], s: FeatureSecrets): secretsmanager.ISecret[] {
    const optional = [s.osSecret, s.imaginarySecret, s.talkSecret, s.signalingSecret, s.talkInternalSecret];
    return [...base, ...optional.filter((secret): secret is secretsmanager.Secret => secret !== undefined)];
  }
}
