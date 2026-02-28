import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';

import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { NagSuppressions } from 'cdk-nag';

export class NextcloudAioStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Context Parameters ---
    const domain = this.node.tryGetContext('domain') || 'cloud.example.com';
    const certificateArn = this.node.tryGetContext('certificateArn') || '';
    const hostedZoneId = this.node.tryGetContext('hostedZoneId') || '';
    const hostedZoneName = this.node.tryGetContext('hostedZoneName') || '';
    const aioImageTag = this.node.tryGetContext('aioImageTag') || '20260218_123804';
    const nextcloudImageUri = this.node.tryGetContext('nextcloudImageUri') || `ghcr.io/nextcloud-releases/aio-nextcloud:${aioImageTag}`;
    const apachePort = this.node.tryGetContext('apachePort') || 11000;
    const enableOnlyOffice = this.node.tryGetContext('enableOnlyOffice') === 'true';
    const enableTalk = this.node.tryGetContext('enableTalk') === 'true';
    const enableFulltextsearch = this.node.tryGetContext('enableFulltextsearch') === 'true';
    const enableImaginary = this.node.tryGetContext('enableImaginary') === 'true';
    const enableClamav = this.node.tryGetContext('enableClamav') === 'true';
    const auroraMinAcu = this.node.tryGetContext('auroraMinAcu') || 0.5;
    const auroraMaxAcu = this.node.tryGetContext('auroraMaxAcu') || 16;
    const githubOwner = this.node.tryGetContext('githubOwner') || 'ukaji3';
    const githubRepo = this.node.tryGetContext('githubRepo') || 'nextcloud-all-in-one';
    const githubBranch = this.node.tryGetContext('githubBranch') || 'main';

    // ========================================
    // 1. VPC
    // ========================================
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    vpc.addFlowLog('FlowLog');

    // ========================================
    // 2. Security Groups
    // ========================================
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc, description: 'ALB' });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));

    const ecsSg = new ec2.SecurityGroup(this, 'EcsSg', { vpc, description: 'ECS Tasks' });
    ecsSg.addIngressRule(albSg, ec2.Port.tcp(apachePort));
    ecsSg.addIngressRule(ecsSg, ec2.Port.allTcp()); // inter-service

    const dbSg = new ec2.SecurityGroup(this, 'DbSg', { vpc, description: 'Aurora' });
    dbSg.addIngressRule(ecsSg, ec2.Port.tcp(5432));

    const cacheSg = new ec2.SecurityGroup(this, 'CacheSg', { vpc, description: 'ElastiCache' });
    cacheSg.addIngressRule(ecsSg, ec2.Port.tcp(6379));

    const efsSg = new ec2.SecurityGroup(this, 'EfsSg', { vpc, description: 'EFS' });
    efsSg.addIngressRule(ecsSg, ec2.Port.tcp(2049));

    // ========================================
    // 3. EFS
    // ========================================
    const fileSystem = new efs.FileSystem(this, 'Efs', {
      vpc,
      securityGroup: efsSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      encrypted: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const apNextcloudHtml = fileSystem.addAccessPoint('NextcloudHtml', {
      path: '/nextcloud-html',
      posixUser: { uid: '33', gid: '33' },
      createAcl: { ownerUid: '33', ownerGid: '33', permissions: '755' },
    });
    const apApacheData = fileSystem.addAccessPoint('ApacheData', {
      path: '/apache-data',
      posixUser: { uid: '33', gid: '33' },
      createAcl: { ownerUid: '33', ownerGid: '33', permissions: '755' },
    });

    // ========================================
    // 4. Aurora Serverless v2
    // ========================================
    const dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'nextcloud' }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });

    const dbCluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      credentials: rds.Credentials.fromSecret(dbSecret),
      defaultDatabaseName: 'nextcloud_database',
      serverlessV2MinCapacity: auroraMinAcu,
      serverlessV2MaxCapacity: auroraMaxAcu,
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        enablePerformanceInsights: true,
        performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      storageEncrypted: true,
      iamAuthentication: true,
      monitoringInterval: cdk.Duration.seconds(60),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ========================================
    // 5. ElastiCache Serverless (Valkey)
    // ========================================
    const cacheSecret = new secretsmanager.Secret(this, 'CacheSecret', {
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
    });

    const cache = new elasticache.CfnServerlessCache(this, 'ValkeyCache', {
      engine: 'valkey',
      serverlessCacheName: `${cdk.Names.uniqueId(this)}-cache`.substring(0, 40).toLowerCase(),
      securityGroupIds: [cacheSg.securityGroupId],
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });

    // ========================================
    // 6. S3
    // ========================================
    const accessLogBucket = new s3.Bucket(this, 'AccessLogBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const bucket = new s3.Bucket(this, 'DataBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogBucket,
      serverAccessLogsPrefix: 'data-bucket/',
      intelligentTieringConfigurations: [{
        name: 'default',
        archiveAccessTierTime: undefined,
        deepArchiveAccessTierTime: undefined,
      }],
      lifecycleRules: [{
        transitions: [{
          storageClass: s3.StorageClass.INTELLIGENT_TIERING,
          transitionAfter: cdk.Duration.days(0),
        }],
        noncurrentVersionTransitions: [{
          storageClass: s3.StorageClass.INTELLIGENT_TIERING,
          transitionAfter: cdk.Duration.days(0),
        }],
      }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ========================================
    // 7. OpenSearch Service (optional)
    // ========================================
    let osDomain: opensearch.Domain | undefined;
    const osSecret = enableFulltextsearch ? new secretsmanager.Secret(this, 'OsSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludePunctuation: false,
        includeSpace: false,
        passwordLength: 16,
        requireEachIncludedType: true,
      },
    }) : undefined;

    if (enableFulltextsearch) {
      const osSg = new ec2.SecurityGroup(this, 'OsSg', { vpc, description: 'OpenSearch' });
      osSg.addIngressRule(ecsSg, ec2.Port.tcp(443));

      osDomain = new opensearch.Domain(this, 'OsDomain', {
        version: opensearch.EngineVersion.OPENSEARCH_2_17,
        vpc,
        vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
        securityGroups: [osSg],
        zoneAwareness: { enabled: false },
        capacity: {
          dataNodeInstanceType: 't3.small.search',
          dataNodes: 1,
          multiAzWithStandbyEnabled: false,
        },
        ebs: { volumeSize: 20, volumeType: ec2.EbsDeviceVolumeType.GP3 },
        nodeToNodeEncryption: true,
        encryptionAtRest: { enabled: true },
        enforceHttps: true,
        fineGrainedAccessControl: {
          masterUserName: 'admin',
          masterUserPassword: osSecret!.secretValueFromJson('password'),
        },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
    }

    // ========================================
    // 8. ECS Cluster + Cloud Map
    // ========================================
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, containerInsights: true });

    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      name: 'nextcloud.local',
      vpc,
    });

    // ========================================
    // 9. IAM - Task Roles
    // ========================================
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    bucket.grantReadWrite(taskRole);

    const executionRole = new iam.Role(this, 'ExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')],
    });
    dbSecret.grantRead(executionRole);
    cacheSecret.grantRead(executionRole);
    if (osSecret) osSecret.grantRead(executionRole);

    // ========================================
    // 10. Log Groups
    // ========================================
    const logGroup = new logs.LogGroup(this, 'EcsLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ========================================
    // Helper: create ECS Fargate Service
    // ========================================
    const createService = (
      name: string,
      taskDef: ecs.FargateTaskDefinition,
      port: number,
      opts?: { desiredCount?: number; minCapacity?: number; maxCapacity?: number },
    ) => {
      const svc = new ecs.FargateService(this, `${name}Service`, {
        cluster,
        taskDefinition: taskDef,
        desiredCount: opts?.desiredCount ?? 1,
        securityGroups: [ecsSg],
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        cloudMapOptions: {
          name: `nextcloud-aio-${name}`,
          cloudMapNamespace: namespace,
          dnsRecordType: servicediscovery.DnsRecordType.A,
          dnsTtl: cdk.Duration.seconds(10),
        },
        enableExecuteCommand: true,
      });

      if (opts?.maxCapacity) {
        const scaling = svc.autoScaleTaskCount({ minCapacity: opts.minCapacity ?? 1, maxCapacity: opts.maxCapacity });
        scaling.scaleOnCpuUtilization(`${name}CpuScaling`, { targetUtilizationPercent: 70 });
      }
      return svc;
    };

    // ========================================
    // 11. Nextcloud Task Definition
    // ========================================
    const nextcloudTd = new ecs.FargateTaskDefinition(this, 'NextcloudTd', {
      cpu: 1024, memoryLimitMiB: 2048,
      taskRole, executionRole,
    });

    nextcloudTd.addVolume({
      name: 'nextcloud-html',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: apNextcloudHtml.accessPointId },
      },
    });

    const nextcloudContainer = nextcloudTd.addContainer('nextcloud', {
      image: ecs.ContainerImage.fromRegistry(nextcloudImageUri),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'nextcloud', logGroup }),
      portMappings: [{ containerPort: 9000 }, { containerPort: 9001 }],
      healthCheck: {
        command: ['CMD-SHELL', '/healthcheck.sh'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(30),
        retries: 3,
        startPeriod: cdk.Duration.seconds(120),
      },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
        REDIS_HOST_PASSWORD: ecs.Secret.fromSecretsManager(cacheSecret),
        ...(enableFulltextsearch && osSecret ? { FULLTEXTSEARCH_PASSWORD: ecs.Secret.fromSecretsManager(osSecret, 'password') } : {}),
      },
      environment: {
        POSTGRES_HOST: dbCluster.clusterEndpoint.hostname,
        POSTGRES_PORT: '5432',
        POSTGRES_DB: 'nextcloud_database',
        POSTGRES_USER: 'nextcloud',
        REDIS_HOST: cache.attrEndpointAddress,
        REDIS_PORT: cache.attrEndpointPort,
        REDIS_TLS_ENABLED: 'true',
        REDIS_MODE: 'rediscluster',
        NC_DOMAIN: domain,
        OVERWRITEPROTOCOL: 'https',
        APACHE_HOST: `nextcloud-aio-apache.nextcloud.local`,
        APACHE_PORT: String(apachePort),
        NEXTCLOUD_HOST: 'nextcloud-aio-nextcloud.nextcloud.local',
        ADMIN_USER: 'admin',
        ADMIN_PASSWORD: 'changeme-on-first-login',
        OBJECTSTORE_S3_BUCKET: bucket.bucketName,
        OBJECTSTORE_S3_REGION: this.region,
        OBJECTSTORE_S3_SSL: 'true',
        OBJECTSTORE_S3_AUTOCREATE: 'true',
        OBJECTSTORE_S3_USEPATH_STYLE: 'false',
        PHP_MEMORY_LIMIT: '512M',
        PHP_UPLOAD_LIMIT: '16G',
        PHP_MAX_TIME: '3600',
        TZ: 'Asia/Tokyo',
        ONLYOFFICE_ENABLED: enableOnlyOffice ? 'yes' : 'no',
        ONLYOFFICE_HOST: 'nextcloud-aio-onlyoffice.nextcloud.local',
        ONLYOFFICE_SECRET: 'changeme-onlyoffice-secret',
        TALK_ENABLED: enableTalk ? 'yes' : 'no',
        COLLABORA_ENABLED: 'no',
        CLAMAV_ENABLED: enableClamav ? 'yes' : 'no',
        IMAGINARY_ENABLED: enableImaginary ? 'yes' : 'no',
        FULLTEXTSEARCH_ENABLED: enableFulltextsearch ? 'yes' : 'no',
        FULLTEXTSEARCH_HOST: enableFulltextsearch && osDomain ? osDomain.domainEndpoint : '',
        FULLTEXTSEARCH_PORT: enableFulltextsearch ? '443' : '',
        FULLTEXTSEARCH_PROTOCOL: 'https',
        FULLTEXTSEARCH_USER: 'admin',
        FULLTEXTSEARCH_PASSWORD: 'none',
        FULLTEXTSEARCH_INDEX: 'nextcloud-aio',
        WHITEBOARD_ENABLED: 'no',
        STARTUP_APPS: 'deck twofactor_totp tasks calendar contacts notes drawio mail forms groupfolders user_saml files_accesscontrol suspicious_login',
        UPDATE_NEXTCLOUD_APPS: 'no',
        REMOVE_DISABLED_APPS: 'yes',
        NEXTCLOUD_LOG_TYPE: 'syslog',
      },
    });
    nextcloudContainer.addMountPoints({
      sourceVolume: 'nextcloud-html',
      containerPath: '/var/www/html',
      readOnly: false,
    });

    const nextcloudSvc = createService('nextcloud', nextcloudTd, 9000, { desiredCount: 2, minCapacity: 2, maxCapacity: 10 });

    // ========================================
    // 12. Apache Task Definition
    // ========================================
    const apacheTd = new ecs.FargateTaskDefinition(this, 'ApacheTd', {
      cpu: 512, memoryLimitMiB: 1024,
      taskRole, executionRole,
    });

    apacheTd.addVolume({
      name: 'nextcloud-html',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: apNextcloudHtml.accessPointId },
      },
    });
    apacheTd.addVolume({
      name: 'apache-data',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: apApacheData.accessPointId },
      },
    });

    const apacheContainer = apacheTd.addContainer('apache', {
      image: ecs.ContainerImage.fromRegistry(`ghcr.io/nextcloud-releases/aio-apache:${aioImageTag}`),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'apache', logGroup }),
      portMappings: [{ containerPort: apachePort }],
      healthCheck: {
        command: ['CMD-SHELL', '/healthcheck.sh'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(30),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
      environment: {
        APACHE_PORT: String(apachePort),
        APACHE_MAX_SIZE: '17179869184',
        APACHE_MAX_TIME: '3600',
        NC_DOMAIN: domain,
        APACHE_HOST: 'nextcloud-aio-apache.nextcloud.local',
        NEXTCLOUD_HOST: 'nextcloud-aio-nextcloud.nextcloud.local',
        NOTIFY_PUSH_HOST: 'nextcloud-aio-notify-push.nextcloud.local',
        ONLYOFFICE_HOST: enableOnlyOffice ? 'nextcloud-aio-onlyoffice.nextcloud.local' : 'localhost',
        TALK_HOST: enableTalk ? 'nextcloud-aio-talk.nextcloud.local' : 'localhost',
        COLLABORA_HOST: 'localhost',
        WHITEBOARD_HOST: 'localhost',
        HARP_HOST: 'localhost',
        TZ: 'Asia/Tokyo',
      },
    });
    apacheContainer.addMountPoints(
      { sourceVolume: 'nextcloud-html', containerPath: '/var/www/html', readOnly: true },
      { sourceVolume: 'apache-data', containerPath: '/mnt/data', readOnly: false },
    );

    const apacheSvc = createService('apache', apacheTd, apachePort, { desiredCount: 2, minCapacity: 2, maxCapacity: 5 });
    apacheSvc.node.addDependency(nextcloudSvc);

    // ========================================
    // 13. Notify-push Task Definition
    // ========================================
    const notifyTd = new ecs.FargateTaskDefinition(this, 'NotifyPushTd', {
      cpu: 256, memoryLimitMiB: 512,
      taskRole, executionRole,
    });
    notifyTd.addVolume({
      name: 'nextcloud-html',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: apNextcloudHtml.accessPointId },
      },
    });
    const notifyContainer = notifyTd.addContainer('notify-push', {
      image: ecs.ContainerImage.fromRegistry(`ghcr.io/nextcloud-releases/aio-notify-push:${aioImageTag}`),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'notify-push', logGroup }),
      portMappings: [{ containerPort: 7867 }],
      healthCheck: {
        command: ['CMD-SHELL', '/healthcheck.sh'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(30),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
      environment: {
        NEXTCLOUD_HOST: 'nextcloud-aio-nextcloud.nextcloud.local',
        TZ: 'Asia/Tokyo',
      },
    });
    notifyContainer.addMountPoints({ sourceVolume: 'nextcloud-html', containerPath: '/var/www/html', readOnly: true });
    const notifySvc = createService('notify-push', notifyTd, 7867);
    notifySvc.node.addDependency(nextcloudSvc);

    // ========================================
    // 14. OnlyOffice (optional)
    // ========================================
    if (enableOnlyOffice) {
      const apOnlyoffice = fileSystem.addAccessPoint('OnlyofficeData', {
        path: '/onlyoffice-data',
        posixUser: { uid: '104', gid: '104' },
        createAcl: { ownerUid: '104', ownerGid: '104', permissions: '777' },
      });
      const ooTd = new ecs.FargateTaskDefinition(this, 'OnlyofficeTd', {
        cpu: 2048, memoryLimitMiB: 4096,
        taskRole, executionRole,
      });
      ooTd.addVolume({
        name: 'onlyoffice-data',
        efsVolumeConfiguration: {
          fileSystemId: fileSystem.fileSystemId,
          transitEncryption: 'ENABLED',
          authorizationConfig: { accessPointId: apOnlyoffice.accessPointId },
        },
      });
      const ooContainer = ooTd.addContainer('onlyoffice', {
        image: ecs.ContainerImage.fromRegistry(`ghcr.io/nextcloud-releases/aio-onlyoffice:${aioImageTag}`),
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'onlyoffice', logGroup }),
        portMappings: [{ containerPort: 80 }],
        healthCheck: {
          command: ['CMD-SHELL', '/healthcheck.sh'],
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(30),
          retries: 9,
          startPeriod: cdk.Duration.seconds(120),
        },
        environment: {
          JWT_ENABLED: 'true',
          JWT_HEADER: 'AuthorizationJwt',
          JWT_SECRET: 'changeme-onlyoffice-secret',
          TZ: 'Asia/Tokyo',
        },
      });
      ooContainer.addMountPoints({ sourceVolume: 'onlyoffice-data', containerPath: '/var/lib/onlyoffice', readOnly: false });
      createService('onlyoffice', ooTd, 80);
      NagSuppressions.addResourceSuppressions(ooTd, [
        { id: 'AwsSolutions-ECS2', reason: 'Non-sensitive configuration values (feature flags) passed as environment variables' },
      ]);
    }

    // ========================================
    // 15. ALB + DNS
    // ========================================
    const hostedZone = hostedZoneId && hostedZoneName
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId, zoneName: hostedZoneName })
      : undefined;

    // ACM certificate: use provided ARN, or auto-create if hosted zone is available
    const certificate = certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'Cert', certificateArn)
      : hostedZone
        ? new acm.Certificate(this, 'Cert', { domainName: domain, validation: acm.CertificateValidation.fromDns(hostedZone) })
        : undefined;

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });
    alb.logAccessLogs(accessLogBucket, 'alb/');

    const listenerProps: elbv2.BaseApplicationListenerProps = certificate
      ? { port: 443, protocol: elbv2.ApplicationProtocol.HTTPS, certificates: [certificate], sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS }
      : { port: 80, protocol: elbv2.ApplicationProtocol.HTTP };
    const listener = alb.addListener('Listener', listenerProps);

    listener.addTargets('ApacheTarget', {
      port: apachePort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [apacheSvc],
      healthCheck: {
        path: '/status.php',
        port: String(apachePort),
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      stickinessCookieDuration: cdk.Duration.hours(1),
    });

    // ========================================
    // 16. Upgrade State Machine (Step Functions)
    // ========================================
    const sfnRole = new iam.Role(this, 'SfnRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
    });
    sfnRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask', 'ecs:DescribeTasks', 'ecs:UpdateService', 'ecs:DescribeServices'],
      resources: ['*'],
    }));
    sfnRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [taskRole.roleArn, executionRole.roleArn],
    }));
    sfnRole.addToPolicy(new iam.PolicyStatement({
      actions: ['rds:CreateDBClusterSnapshot', 'rds:DescribeDBClusterSnapshots'],
      resources: [dbCluster.clusterArn, `arn:aws:rds:${this.region}:${this.account}:cluster-snapshot:*`],
    }));

    const privateSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS });
    const networkConfig = {
      AwsvpcConfiguration: {
        Subnets: privateSubnets.subnetIds,
        SecurityGroups: [ecsSg.securityGroupId],
        AssignPublicIp: 'DISABLED',
      },
    };

    // Helper: run one-off ECS task with command override
    const runOccCommand = (id: string, command: string[]) =>
      new tasks.CallAwsService(this, id, {
        service: 'ecs',
        action: 'runTask',
        parameters: {
          Cluster: cluster.clusterArn,
          TaskDefinition: nextcloudTd.taskDefinitionArn,
          LaunchType: 'FARGATE',
          NetworkConfiguration: networkConfig,
          Overrides: {
            ContainerOverrides: [{ Name: 'nextcloud', Command: command }],
          },
        },
        iamResources: ['*'],
        resultPath: `$.${id}Result`,
      });

    // Helper: update service desired count
    const scaleService = (id: string, serviceName: string, count: number) =>
      new tasks.CallAwsService(this, id, {
        service: 'ecs',
        action: 'updateService',
        parameters: {
          Cluster: cluster.clusterArn,
          Service: serviceName,
          DesiredCount: count,
        },
        iamResources: ['*'],
        resultPath: sfn.JsonPath.DISCARD,
      });

    // Step 1: Maintenance mode ON
    const maintenanceOn = runOccCommand('MaintenanceOn', ['php', '/var/www/html/occ', 'maintenance:mode', '--on']);

    // Step 2: Wait for in-flight requests to drain
    const waitDrain = new sfn.Wait(this, 'WaitDrain', { time: sfn.WaitTime.duration(cdk.Duration.seconds(30)) });

    // Step 3: Scale down all services to 0
    const scaleDownNextcloud = scaleService('ScaleDownNextcloud', `nextcloud-aio-nextcloud`, 0);
    const scaleDownApache = scaleService('ScaleDownApache', `nextcloud-aio-apache`, 0);
    const scaleDownNotify = scaleService('ScaleDownNotify', `nextcloud-aio-notify-push`, 0);
    const scaleDownAll = new sfn.Parallel(this, 'ScaleDownAll', { resultPath: sfn.JsonPath.DISCARD })
      .branch(scaleDownNextcloud)
      .branch(scaleDownApache)
      .branch(scaleDownNotify);

    // Step 4: Wait for all tasks to stop
    const waitScaleDown = new sfn.Wait(this, 'WaitScaleDown', { time: sfn.WaitTime.duration(cdk.Duration.seconds(60)) });

    // Step 5: Aurora snapshot
    const createSnapshot = new tasks.CallAwsService(this, 'CreateSnapshot', {
      service: 'rds',
      action: 'createDBClusterSnapshot',
      parameters: {
        'DbClusterIdentifier': dbCluster.clusterIdentifier,
        'DbClusterSnapshotIdentifier.$': "States.Format('pre-upgrade-{}', $.executionId)",
      },
      iamResources: ['*'],
      resultPath: '$.snapshotResult',
    });

    // Step 6: Backup config.php to S3
    const backupConfig = runOccCommand('BackupConfig', [
      'sh', '-c',
      `aws s3 cp /var/www/html/config/config.php s3://${bucket.bucketName}/backups/config.php.$(date +%Y%m%d%H%M%S)`,
    ]);

    // Step 7: Start Nextcloud with 1 task (new image triggers upgrade)
    const scaleUpNextcloudOne = scaleService('ScaleUpNextcloudOne', `nextcloud-aio-nextcloud`, 1);

    // Step 8: Wait for upgrade to complete (health check pass)
    const waitUpgrade = new sfn.Wait(this, 'WaitUpgrade', { time: sfn.WaitTime.duration(cdk.Duration.seconds(180)) });

    // Step 9: Check service health
    const checkHealth = new tasks.CallAwsService(this, 'CheckHealth', {
      service: 'ecs',
      action: 'describeServices',
      parameters: {
        Cluster: cluster.clusterArn,
        Services: [`nextcloud-aio-nextcloud`],
      },
      iamResources: ['*'],
      resultPath: '$.healthResult',
    });

    const isHealthy = new sfn.Choice(this, 'IsHealthy')
      .when(
        sfn.Condition.numberGreaterThanEquals('$.healthResult.Services[0].Deployments[0].RunningCount', 1),
        new sfn.Pass(this, 'HealthCheckPassed'),
      )
      .otherwise(
        new sfn.Wait(this, 'WaitRetryHealth', { time: sfn.WaitTime.duration(cdk.Duration.seconds(60)) })
          .next(checkHealth),
      );

    // Step 10: Scale up all services
    const scaleUpNextcloud = scaleService('ScaleUpNextcloud', `nextcloud-aio-nextcloud`, 2);
    const scaleUpApache = scaleService('ScaleUpApache', `nextcloud-aio-apache`, 2);
    const scaleUpNotify = scaleService('ScaleUpNotify', `nextcloud-aio-notify-push`, 1);
    const scaleUpAll = new sfn.Parallel(this, 'ScaleUpAll', { resultPath: sfn.JsonPath.DISCARD })
      .branch(scaleUpNextcloud)
      .branch(scaleUpApache)
      .branch(scaleUpNotify);

    const upgradeSuccess = new sfn.Succeed(this, 'UpgradeSuccess');

    // Rollback on failure
    const rollbackScaleUp = new sfn.Parallel(this, 'RollbackScaleUp', { resultPath: sfn.JsonPath.DISCARD })
      .branch(scaleService('RollbackNextcloud', `nextcloud-aio-nextcloud`, 2))
      .branch(scaleService('RollbackApache', `nextcloud-aio-apache`, 2))
      .branch(scaleService('RollbackNotify', `nextcloud-aio-notify-push`, 1));
    const maintenanceOff = runOccCommand('MaintenanceOff', ['php', '/var/www/html/occ', 'maintenance:mode', '--off']);
    const rollback = rollbackScaleUp.next(maintenanceOff).next(new sfn.Fail(this, 'UpgradeFailed', {
      cause: 'Upgrade failed. Services rolled back to previous state.',
    }));

    // Chain
    const definition = maintenanceOn
      .next(waitDrain)
      .next(scaleDownAll)
      .next(waitScaleDown)
      .next(createSnapshot)
      .next(backupConfig)
      .next(scaleUpNextcloudOne)
      .next(waitUpgrade)
      .next(checkHealth)
      .next(isHealthy);

    // Connect success path
    isHealthy.afterwards().next(scaleUpAll).next(upgradeSuccess);

    // Add catch for rollback
    const mainChain = new sfn.Parallel(this, 'MainChain', { resultPath: sfn.JsonPath.DISCARD });
    mainChain.branch(definition);
    mainChain.addCatch(rollback, { resultPath: '$.error' });

    // Prepend executionId extraction
    const extractId = new sfn.Pass(this, 'ExtractExecutionId', {
      parameters: { 'executionId.$': "$$.Execution.Name" },
    });

    const sfnLogGroup = new logs.LogGroup(this, 'SfnLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const stateMachine = new sfn.StateMachine(this, 'UpgradeStateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(extractId.next(mainChain)),
      timeout: cdk.Duration.hours(2),
      role: sfnRole,
      stateMachineName: 'nextcloud-upgrade',
      tracingEnabled: true,
      logs: { destination: sfnLogGroup, level: sfn.LogLevel.ALL },
    });

    // ========================================
    // 17. CI/CD Pipeline (CodePipeline + CodeBuild)
    // ========================================
    const ecrRepo = new ecr.Repository(this, 'NextcloudEcr', {
      repositoryName: 'aio-nextcloud',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 10 }],
    });

    const githubToken = cdk.SecretValue.secretsManager('github-token');

    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true, // Docker ビルドに必要
      },
      environmentVariables: {
        ECR_REPO_URI: { value: ecrRepo.repositoryUri },
        AWS_ACCOUNT_ID: { value: this.account },
        AWS_DEFAULT_REGION: { value: this.region },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com',
              'IMAGE_TAG=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-8)',
            ],
          },
          build: {
            commands: [
              'docker build -f containers/nextcloud/Dockerfile -t $ECR_REPO_URI:$IMAGE_TAG -t $ECR_REPO_URI:latest .',
            ],
          },
          post_build: {
            commands: [
              'docker push $ECR_REPO_URI:$IMAGE_TAG',
              'docker push $ECR_REPO_URI:latest',
              // タスク定義の新リビジョンを登録
              `TASK_DEF_ARN=$(aws ecs describe-task-definition --task-definition ${nextcloudTd.family} --query 'taskDefinition.taskDefinitionArn' --output text)`,
              `CONTAINER_DEFS=$(aws ecs describe-task-definition --task-definition ${nextcloudTd.family} --query 'taskDefinition.containerDefinitions' --output json | sed "s|${nextcloudImageUri}|$ECR_REPO_URI:$IMAGE_TAG|g")`,
              `aws ecs register-task-definition --family ${nextcloudTd.family} --container-definitions "$CONTAINER_DEFS" --task-role-arn ${taskRole.roleArn} --execution-role-arn ${executionRole.roleArn} --network-mode awsvpc --requires-compatibilities FARGATE --cpu 1024 --memory 2048 --volumes "$(aws ecs describe-task-definition --task-definition ${nextcloudTd.family} --query 'taskDefinition.volumes' --output json)"`,
              // Step Functions 実行
              `aws stepfunctions start-execution --state-machine-arn ${stateMachine.stateMachineArn}`,
            ],
          },
        },
      }),
    });

    ecrRepo.grantPullPush(buildProject);
    stateMachine.grantStartExecution(buildProject);
    buildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:DescribeTaskDefinition', 'ecs:RegisterTaskDefinition', 'iam:PassRole'],
      resources: ['*'],
    }));

    const pipelineKey = new kms.Key(this, 'PipelineKey', {
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const pipelineArtifactsBucket = new s3.Bucket(this, 'PipelineArtifactsBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: pipelineKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const sourceOutput = new codepipeline.Artifact();
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'nextcloud-deploy',
      pipelineType: codepipeline.PipelineType.V2,
      artifactBucket: pipelineArtifactsBucket,
      stages: [
        {
          stageName: 'Source',
          actions: [
            new codepipeline_actions.GitHubSourceAction({
              actionName: 'GitHub',
              owner: githubOwner,
              repo: githubRepo,
              branch: githubBranch,
              oauthToken: githubToken,
              output: sourceOutput,
              trigger: codepipeline_actions.GitHubTrigger.NONE, // 手動トリガー
            }),
          ],
        },
        {
          stageName: 'BuildAndDeploy',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'BuildPushUpgrade',
              project: buildProject,
              input: sourceOutput,
            }),
          ],
        },
      ],
    });

    // ========================================
    // 18. Monitoring - Log Metric Filters
    // ========================================
    const errorMetric = new logs.MetricFilter(this, 'ErrorLogFilter', {
      logGroup,
      filterPattern: logs.FilterPattern.anyTerm('ERROR', 'CRITICAL', 'Fatal'),
      metricNamespace: 'Nextcloud',
      metricName: 'ErrorCount',
      metricValue: '1',
      defaultValue: 0,
    });

    // ========================================
    // 19. Monitoring - CloudWatch Alarms
    // ========================================
    // ECS: Nextcloud CPU high
    new cloudwatch.Alarm(this, 'NextcloudCpuAlarm', {
      metric: nextcloudSvc.metricCpuUtilization({ period: cdk.Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      alarmDescription: 'Nextcloud ECS CPU > 80% for 15 min',
    });

    // ECS: Nextcloud Memory high
    new cloudwatch.Alarm(this, 'NextcloudMemoryAlarm', {
      metric: nextcloudSvc.metricMemoryUtilization({ period: cdk.Duration.minutes(5) }),
      threshold: 85,
      evaluationPeriods: 3,
      alarmDescription: 'Nextcloud ECS Memory > 85% for 15 min',
    });

    // ECS: Apache CPU high
    new cloudwatch.Alarm(this, 'ApacheCpuAlarm', {
      metric: apacheSvc.metricCpuUtilization({ period: cdk.Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      alarmDescription: 'Apache ECS CPU > 80% for 15 min',
    });

    // ALB: 5xx errors
    const alb5xx = new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
      metric: alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: cdk.Duration.minutes(5) }),
      threshold: 10,
      evaluationPeriods: 2,
      alarmDescription: 'ALB 5xx errors > 10 for 10 min',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ALB: Target 5xx errors
    new cloudwatch.Alarm(this, 'Target5xxAlarm', {
      metric: alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: cdk.Duration.minutes(5) }),
      threshold: 10,
      evaluationPeriods: 2,
      alarmDescription: 'Target 5xx errors > 10 for 10 min',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ALB: Target response time
    new cloudwatch.Alarm(this, 'ResponseTimeAlarm', {
      metric: alb.metrics.targetResponseTime({ period: cdk.Duration.minutes(5), statistic: 'p95' }),
      threshold: 5,
      evaluationPeriods: 3,
      alarmDescription: 'ALB p95 response time > 5s for 15 min',
    });

    // ALB: Unhealthy targets
    new cloudwatch.Alarm(this, 'UnhealthyTargetsAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'UnHealthyHostCount',
        dimensionsMap: { LoadBalancer: alb.loadBalancerFullName },
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 1,
      evaluationPeriods: 3,
      alarmDescription: 'Unhealthy targets detected for 3 min',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Aurora: CPU
    new cloudwatch.Alarm(this, 'AuroraCpuAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'CPUUtilization',
        dimensionsMap: { DBClusterIdentifier: dbCluster.clusterIdentifier },
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: 80,
      evaluationPeriods: 3,
      alarmDescription: 'Aurora CPU > 80% for 15 min',
    });

    // Aurora: Serverless capacity
    new cloudwatch.Alarm(this, 'AuroraCapacityAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'ServerlessDatabaseCapacity',
        dimensionsMap: { DBClusterIdentifier: dbCluster.clusterIdentifier },
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: auroraMaxAcu * 0.8,
      evaluationPeriods: 3,
      alarmDescription: `Aurora capacity > ${auroraMaxAcu * 0.8} ACU for 15 min`,
    });

    // Aurora: Freeable memory low
    new cloudwatch.Alarm(this, 'AuroraMemoryAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'FreeableMemory',
        dimensionsMap: { DBClusterIdentifier: dbCluster.clusterIdentifier },
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: 256 * 1024 * 1024, // 256MB
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      alarmDescription: 'Aurora freeable memory < 256MB for 15 min',
    });

    // Log errors
    new cloudwatch.Alarm(this, 'ErrorLogAlarm', {
      metric: errorMetric.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 50,
      evaluationPeriods: 2,
      alarmDescription: 'Error log count > 50 in 10 min',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ========================================
    // 20. CloudWatch Dashboard
    // ========================================
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'Nextcloud-Monitoring',
    });

    // Row 1: ECS overview
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ECS CPU Utilization',
        left: [
          nextcloudSvc.metricCpuUtilization({ label: 'Nextcloud' }),
          apacheSvc.metricCpuUtilization({ label: 'Apache' }),
          notifySvc.metricCpuUtilization({ label: 'Notify-push' }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'ECS Memory Utilization',
        left: [
          nextcloudSvc.metricMemoryUtilization({ label: 'Nextcloud' }),
          apacheSvc.metricMemoryUtilization({ label: 'Apache' }),
          notifySvc.metricMemoryUtilization({ label: 'Notify-push' }),
        ],
        width: 12,
      }),
    );

    // Row 2: ALB
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ALB Request Count & Errors',
        left: [alb.metrics.requestCount({ label: 'Requests' })],
        right: [
          alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { label: '5xx', color: '#d62728' }),
          alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { label: 'Target 5xx', color: '#ff7f0e' }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'ALB Response Time (p50/p95/p99)',
        left: [
          alb.metrics.targetResponseTime({ label: 'p50', statistic: 'p50' }),
          alb.metrics.targetResponseTime({ label: 'p95', statistic: 'p95' }),
          alb.metrics.targetResponseTime({ label: 'p99', statistic: 'p99' }),
        ],
        width: 12,
      }),
    );

    // Row 3: Aurora
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Aurora CPU & Capacity',
        left: [new cloudwatch.Metric({
          namespace: 'AWS/RDS', metricName: 'CPUUtilization',
          dimensionsMap: { DBClusterIdentifier: dbCluster.clusterIdentifier }, label: 'CPU %',
        })],
        right: [new cloudwatch.Metric({
          namespace: 'AWS/RDS', metricName: 'ServerlessDatabaseCapacity',
          dimensionsMap: { DBClusterIdentifier: dbCluster.clusterIdentifier }, label: 'ACU',
        })],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Aurora Connections & Latency',
        left: [new cloudwatch.Metric({
          namespace: 'AWS/RDS', metricName: 'DatabaseConnections',
          dimensionsMap: { DBClusterIdentifier: dbCluster.clusterIdentifier }, label: 'Connections',
        })],
        right: [
          new cloudwatch.Metric({
            namespace: 'AWS/RDS', metricName: 'ReadLatency',
            dimensionsMap: { DBClusterIdentifier: dbCluster.clusterIdentifier }, label: 'Read',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/RDS', metricName: 'WriteLatency',
            dimensionsMap: { DBClusterIdentifier: dbCluster.clusterIdentifier }, label: 'Write',
          }),
        ],
        width: 12,
      }),
    );

    // Row 4: Errors & ECS Task Count
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Application Error Logs',
        left: [errorMetric.metric({ label: 'Errors', statistic: 'Sum' })],
        width: 12,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Running Tasks',
        metrics: [
          nextcloudSvc.metricCpuUtilization({ label: 'Nextcloud CPU' }),
          apacheSvc.metricCpuUtilization({ label: 'Apache CPU' }),
        ],
        width: 12,
      }),
    );

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(this, 'AlbDns', { value: alb.loadBalancerDnsName });

    // Route 53 Alias record
    if (hostedZone) {
      new route53.ARecord(this, 'DnsRecord', {
        zone: hostedZone,
        recordName: domain,
        target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(alb)),
      });
    }
    new cdk.CfnOutput(this, 'S3Bucket', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'AuroraEndpoint', { value: dbCluster.clusterEndpoint.hostname });
    new cdk.CfnOutput(this, 'CacheEndpoint', { value: cache.attrEndpointAddress });
    new cdk.CfnOutput(this, 'EfsId', { value: fileSystem.fileSystemId });
    if (osDomain) {
      new cdk.CfnOutput(this, 'OsEndpoint', { value: osDomain.domainEndpoint });
    }
    new cdk.CfnOutput(this, 'UpgradeStateMachineArn', { value: stateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'EcrRepoUri', { value: ecrRepo.repositoryUri });
    new cdk.CfnOutput(this, 'PipelineName', { value: pipeline.pipelineName });

    // ========================================
    // Nag Suppressions (intentional design decisions)
    // ========================================
    NagSuppressions.addResourceSuppressions(albSg, [
      { id: 'AwsSolutions-EC23', reason: 'ALB is public-facing for Nextcloud web access' },
    ]);
    NagSuppressions.addResourceSuppressions(executionRole, [
      { id: 'AwsSolutions-IAM4', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'], reason: 'Standard ECS task execution role managed policy' },
    ]);
    NagSuppressions.addResourceSuppressions([dbSecret, cacheSecret], [
      { id: 'AwsSolutions-SMG4', reason: 'Secrets rotation requires application-level coordination; managed externally' },
    ]);
    const taskDefinitions = [nextcloudTd, apacheTd, notifyTd];
    NagSuppressions.addResourceSuppressions(taskDefinitions, [
      { id: 'AwsSolutions-ECS2', reason: 'Non-sensitive configuration values (hostnames, ports, feature flags) passed as environment variables' },
    ]);
    NagSuppressions.addResourceSuppressions(accessLogBucket, [
      { id: 'AwsSolutions-S1', reason: 'This is the access log destination bucket itself' },
    ]);
    // IAM5: wildcard permissions auto-generated by CDK grant methods
    NagSuppressions.addResourceSuppressions(
      [taskRole, sfnRole, buildProject.role!, pipeline.role],
      [{ id: 'AwsSolutions-IAM5', reason: 'Wildcard permissions generated by CDK grant helpers for S3, CodeBuild, KMS, and ECS operations' }],
      true,
    );
    // ArtifactsBucket S1: Pipeline-managed internal bucket
    NagSuppressions.addResourceSuppressions(pipeline, [
      { id: 'AwsSolutions-S1', reason: 'Pipeline artifacts bucket is internal; access logged via CloudTrail' },
    ], true);
    NagSuppressions.addResourceSuppressions(pipelineArtifactsBucket, [
      { id: 'AwsSolutions-S1', reason: 'Pipeline artifacts bucket is internal; access logged via CloudTrail' },
    ]);
    NagSuppressions.addResourceSuppressions(dbCluster, [
      { id: 'AwsSolutions-IAM4', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole'], reason: 'Standard RDS Enhanced Monitoring managed policy' },
    ], true);
  }
}
