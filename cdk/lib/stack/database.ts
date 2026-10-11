import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

/**
 * Inputs of {@link buildDatabase}.
 */
export interface DatabaseProps {
  readonly vpc: ec2.IVpc;
  readonly dbSg: ec2.ISecurityGroup;
  readonly minAcu: number;
  readonly maxAcu: number;
  /** Automated backup retention, in days. */
  readonly backupRetentionDays: number;
}

/**
 * Aurora cluster and its credentials.
 */
export interface DatabaseResources {
  readonly dbSecret: secretsmanager.Secret;
  readonly dbCluster: rds.DatabaseCluster;
}

/**
 * Serverless Valkey cache and its secret.
 */
export interface CacheResources {
  readonly cacheSecret: secretsmanager.Secret;
  readonly cache: elasticache.CfnServerlessCache;
}

/**
 * Create the Aurora Serverless v2 (PostgreSQL) cluster.
 *
 * @param scope - Stack the resources belong to.
 * @param props - Network placement, capacity and backup retention.
 * @returns Database resources.
 */
export function buildDatabase(scope: Construct, props: DatabaseProps): DatabaseResources {
  const dbSecret = new secretsmanager.Secret(scope, 'DbSecret', {
    generateSecretString: {
      secretStringTemplate: JSON.stringify({ username: 'oc_nextcloud' }),
      generateStringKey: 'password',
      excludePunctuation: true,
    },
  });

  const dbCluster = new rds.DatabaseCluster(scope, 'AuroraCluster', {
    engine: rds.DatabaseClusterEngine.auroraPostgres({
      // 16.4 は deprecated（新規作成不可）。稼働クラスタは自動マイナー
      // アップグレードで 16.11 のため、テンプレートを実機に一致させる。
      version: rds.AuroraPostgresEngineVersion.VER_16_11,
    }),
    credentials: rds.Credentials.fromSecret(dbSecret),
    defaultDatabaseName: 'nextcloud_database',
    serverlessV2MinCapacity: props.minAcu,
    serverlessV2MaxCapacity: props.maxAcu,
    writer: rds.ClusterInstance.serverlessV2('Writer', {
      enablePerformanceInsights: true,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
    }),
    vpc: props.vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    securityGroups: [props.dbSg],
    storageEncrypted: true,
    iamAuthentication: true,
    monitoringInterval: cdk.Duration.seconds(60),
    backup: { retention: cdk.Duration.days(props.backupRetentionDays) },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  return { dbSecret, dbCluster };
}

/**
 * Create the ElastiCache Serverless (Valkey) cache.
 *
 * @param scope - Stack the resources belong to.
 * @param vpc - VPC hosting the cache endpoints.
 * @param cacheSg - Security group of the cache.
 * @returns Cache resources.
 */
export function buildCache(scope: Construct, vpc: ec2.IVpc, cacheSg: ec2.ISecurityGroup): CacheResources {
  const cacheSecret = new secretsmanager.Secret(scope, 'CacheSecret', {
    generateSecretString: { excludePunctuation: true, passwordLength: 32 },
  });

  const cache = new elasticache.CfnServerlessCache(scope, 'ValkeyCache', {
    engine: 'valkey',
    serverlessCacheName: `${cdk.Names.uniqueId(scope)}-cache`.substring(0, 40).toLowerCase(),
    securityGroupIds: [cacheSg.securityGroupId],
    subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
  });

  return { cacheSecret, cache };
}
