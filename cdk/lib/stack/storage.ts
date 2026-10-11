import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * EFS file system and its access points.
 */
export interface FileSystemResources {
  readonly fileSystem: efs.FileSystem;
  /** /var/www/html of Nextcloud (code, config, apps). */
  readonly apNextcloudHtml: efs.AccessPoint;
  readonly apApacheData: efs.AccessPoint;
  /** Nextcloud data directory (/mnt/ncdata). */
  readonly apNextcloudData: efs.AccessPoint;
}

/**
 * S3 buckets: primary object storage and its access log destination.
 */
export interface BucketResources {
  readonly accessLogBucket: s3.Bucket;
  readonly bucket: s3.Bucket;
}

/**
 * Create the encrypted EFS file system and the access points used by the containers.
 *
 * @param scope - Stack the resources belong to.
 * @param vpc - VPC hosting the mount targets.
 * @param efsSg - Security group of the mount targets.
 * @returns File system resources.
 */
export function buildFileSystem(scope: Construct, vpc: ec2.IVpc, efsSg: ec2.ISecurityGroup): FileSystemResources {
  const fileSystem = new efs.FileSystem(scope, 'Efs', {
    vpc,
    securityGroup: efsSg,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
    throughputMode: efs.ThroughputMode.ELASTIC,
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
  const apNextcloudData = fileSystem.addAccessPoint('NextcloudData', {
    path: '/nextcloud-data',
    posixUser: { uid: '33', gid: '0' },
    createAcl: { ownerUid: '33', ownerGid: '0', permissions: '750' },
  });

  return { fileSystem, apNextcloudHtml, apApacheData, apNextcloudData };
}

/**
 * Create the versioned primary bucket (Intelligent-Tiering) and the access log bucket.
 *
 * @param scope - Stack the resources belong to.
 * @returns Bucket resources.
 */
export function buildBuckets(scope: Construct): BucketResources {
  const accessLogBucket = new s3.Bucket(scope, 'AccessLogBucket', {
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  const bucket = new s3.Bucket(scope, 'DataBucket', {
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    versioned: true,
    enforceSSL: true,
    serverAccessLogsBucket: accessLogBucket,
    serverAccessLogsPrefix: 'data-bucket/',
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

  return { accessLogBucket, bucket };
}
