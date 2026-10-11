import * as cdk from 'aws-cdk-lib';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { StackConfig } from './config';
import { FeatureSecrets } from './feature-secrets';
import { addEfsVolume } from './service-factory';
import { FileSystemResources } from './storage';

/**
 * Inputs of {@link buildNextcloudTask}.
 */
export interface NextcloudTaskProps {
  readonly config: StackConfig;
  readonly taskRole: iam.IRole;
  readonly executionRole: iam.IRole;
  readonly logGroup: logs.ILogGroup;
  readonly files: FileSystemResources;
  readonly bucket: s3.IBucket;
  readonly dbCluster: rds.IDatabaseCluster;
  readonly dbSecret: secretsmanager.ISecret;
  readonly cache: elasticache.CfnServerlessCache;
  readonly adminSecret: secretsmanager.ISecret;
  readonly onlyofficeSecret: secretsmanager.ISecret;
  readonly featureSecrets: FeatureSecrets;
  readonly osDomain?: opensearch.IDomain;
}

/**
 * Nextcloud (PHP-FPM) task definition and its main container.
 */
export interface NextcloudTaskResources {
  readonly taskDefinition: ecs.FargateTaskDefinition;
  /** Container overridden by the upgrade state machine's one-off tasks. */
  readonly container: ecs.ContainerDefinition;
}

type Environment = Record<string, string>;

/**
 * Database, cache and object storage settings.
 *
 * @param props - Task inputs.
 * @returns Environment entries.
 */
function dataEnvironment(props: NextcloudTaskProps): Environment {
  return {
    POSTGRES_HOST: props.dbCluster.clusterEndpoint.hostname,
    POSTGRES_PORT: '5432',
    POSTGRES_DB: 'nextcloud_database',
    POSTGRES_USER: 'nextcloud',
    PGSSLCERT: '',
    REDIS_HOST: props.cache.attrEndpointAddress,
    REDIS_PORT: props.cache.attrEndpointPort,
    REDIS_TLS_ENABLED: 'true',
    REDIS_MODE: 'rediscluster',
  };
}

/**
 * Host names, admin user, data directory, S3 primary storage and PHP limits.
 *
 * @param props - Task inputs.
 * @returns Environment entries.
 */
function coreEnvironment(props: NextcloudTaskProps): Environment {
  return {
    NC_DOMAIN: props.config.domain,
    OVERWRITEPROTOCOL: 'https',
    APACHE_HOST: 'nextcloud-aio-apache.nextcloud.local',
    APACHE_PORT: String(props.config.apachePort),
    NEXTCLOUD_HOST: 'nextcloud-aio-nextcloud.nextcloud.local',
    ADMIN_USER: 'admin',
    NEXTCLOUD_DATA_DIR: '/mnt/ncdata',
    OBJECTSTORE_S3_BUCKET: props.bucket.bucketName,
    OBJECTSTORE_S3_REGION: cdk.Stack.of(props.bucket).region,
    OBJECTSTORE_S3_SSL: 'true',
    OBJECTSTORE_S3_AUTOCREATE: 'true',
    OBJECTSTORE_S3_USEPATH_STYLE: 'false',
    PHP_MEMORY_LIMIT: '512M',
    PHP_UPLOAD_LIMIT: '16G',
    PHP_MAX_TIME: '3600',
    TZ: 'Asia/Tokyo',
  };
}

/**
 * Converts a feature flag into the "yes"/"no" value the AIO scripts expect.
 *
 * @param enabled - Feature flag.
 * @returns "yes" or "no".
 */
function yesNo(enabled: boolean): string {
  return enabled ? 'yes' : 'no';
}

/**
 * Office, Talk, antivirus and preview integrations.
 *
 * TURN_DOMAIN is the Nextcloud domain. (The original stack intended to use the
 * Talk NLB name here, but assigned it only after this container was defined,
 * so the effective value has always been the domain.)
 *
 * @param config - Deployment parameters.
 * @returns Environment entries.
 */
function integrationEnvironment(config: StackConfig): Environment {
  return {
    ONLYOFFICE_ENABLED: yesNo(config.enableOnlyOffice),
    ONLYOFFICE_HOST: 'nextcloud-aio-onlyoffice.nextcloud.local',
    TALK_ENABLED: yesNo(config.enableTalk),
    TALK_HOST: 'nextcloud-aio-talk.nextcloud.local',
    TALK_PORT: '3478',
    TURN_DOMAIN: config.domain,
    COLLABORA_ENABLED: 'no',
    CLAMAV_ENABLED: yesNo(config.enableClamav),
    IMAGINARY_ENABLED: yesNo(config.enableImaginary),
    IMAGINARY_HOST: config.enableImaginary ? 'nextcloud-aio-imaginary.nextcloud.local' : '',
  };
}

/**
 * Full-text search (OpenSearch Service) settings.
 *
 * @param config - Deployment parameters.
 * @param osDomain - Search domain, when full-text search is enabled.
 * @returns Environment entries.
 */
function fulltextsearchEnvironment(config: StackConfig, osDomain?: opensearch.IDomain): Environment {
  const enabled = config.enableFulltextsearch;
  return {
    FULLTEXTSEARCH_ENABLED: yesNo(enabled),
    FULLTEXTSEARCH_HOST: osDomain ? osDomain.domainEndpoint : '',
    FULLTEXTSEARCH_PORT: enabled ? '443' : '',
    FULLTEXTSEARCH_PROTOCOL: 'https',
    FULLTEXTSEARCH_USER: 'admin',
    ...(enabled ? {} : { FULLTEXTSEARCH_PASSWORD: 'none' }),
    FULLTEXTSEARCH_INDEX: 'nextcloud-aio',
  };
}

/**
 * App installation and logging behaviour.
 *
 * @returns Environment entries.
 */
function appsEnvironment(): Environment {
  return {
    WHITEBOARD_ENABLED: 'no',
    STARTUP_APPS: 'deck twofactor_totp tasks calendar contacts notes drawio mail forms groupfolders user_saml files_accesscontrol suspicious_login',
    UPDATE_NEXTCLOUD_APPS: 'no',
    // メジャーアップグレード時に未対応アプリが「無効化」に留まり「削除」されないようにする
    REMOVE_DISABLED_APPS: 'no',
    NEXTCLOUD_LOG_TYPE: 'errorlog',
    // NOTE: 意図的にデプロイ時刻等の非決定値を含めない。
    // 非決定値があると synth のたびにタスク定義が置換され、
    // cdk diff が常に差分を示して冪等性が失われる。
  };
}

/**
 * Full environment of the Nextcloud container. Entry order is part of the
 * synthesized template, so the groups are concatenated in a fixed order.
 *
 * @param props - Task inputs.
 * @returns Environment entries.
 */
function nextcloudEnvironment(props: NextcloudTaskProps): Environment {
  return {
    ...dataEnvironment(props),
    ...coreEnvironment(props),
    ...integrationEnvironment(props.config),
    ...fulltextsearchEnvironment(props.config, props.osDomain),
    ...appsEnvironment(),
  };
}

/**
 * Secrets injected into the Nextcloud container.
 *
 * @param props - Task inputs.
 * @returns Secrets by environment variable name.
 */
function nextcloudSecrets(props: NextcloudTaskProps): Record<string, ecs.Secret> {
  const s = props.featureSecrets;
  return {
    POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(props.dbSecret, 'password'),
    ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(props.adminSecret),
    ...(s.osSecret ? { FULLTEXTSEARCH_PASSWORD: ecs.Secret.fromSecretsManager(s.osSecret, 'password') } : {}),
    ...(s.talkSecret ? { TURN_SECRET: ecs.Secret.fromSecretsManager(s.talkSecret) } : {}),
    ...(s.signalingSecret ? { SIGNALING_SECRET: ecs.Secret.fromSecretsManager(s.signalingSecret) } : {}),
    ...(s.imaginarySecret ? { IMAGINARY_SECRET: ecs.Secret.fromSecretsManager(s.imaginarySecret) } : {}),
    ONLYOFFICE_SECRET: ecs.Secret.fromSecretsManager(props.onlyofficeSecret),
  };
}

/**
 * Create the Nextcloud task definition with the html and data EFS volumes.
 *
 * @param scope - Stack the resources belong to.
 * @param props - Task inputs.
 * @returns Task definition and container.
 */
export function buildNextcloudTask(scope: Construct, props: NextcloudTaskProps): NextcloudTaskResources {
  const taskDefinition = new ecs.FargateTaskDefinition(scope, 'NextcloudTd', {
    cpu: 1024, memoryLimitMiB: 2048,
    taskRole: props.taskRole, executionRole: props.executionRole,
  });
  const fsId = props.files.fileSystem.fileSystemId;
  addEfsVolume(taskDefinition, 'nextcloud-html', fsId, props.files.apNextcloudHtml.accessPointId);
  addEfsVolume(taskDefinition, 'nextcloud-data', fsId, props.files.apNextcloudData.accessPointId);

  const container = taskDefinition.addContainer('nextcloud', {
    image: ecs.ContainerImage.fromRegistry(props.config.nextcloudImageUri),
    logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'nextcloud', logGroup: props.logGroup }),
    portMappings: [{ containerPort: 9000 }, { containerPort: 9001 }],
    healthCheck: {
      command: ['CMD-SHELL', 'exit 0'],
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      retries: 3,
    },
    secrets: nextcloudSecrets(props),
    environment: nextcloudEnvironment(props),
  });
  container.addMountPoints(
    { sourceVolume: 'nextcloud-html', containerPath: '/var/www/html', readOnly: false },
    { sourceVolume: 'nextcloud-data', containerPath: '/mnt/ncdata', readOnly: false },
  );

  return { taskDefinition, container };
}
