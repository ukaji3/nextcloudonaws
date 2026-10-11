import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * VPC and security groups shared by every tier.
 */
export interface NetworkResources {
  readonly vpc: ec2.Vpc;
  readonly albSg: ec2.SecurityGroup;
  readonly ecsSg: ec2.SecurityGroup;
  readonly dbSg: ec2.SecurityGroup;
  readonly cacheSg: ec2.SecurityGroup;
  readonly efsSg: ec2.SecurityGroup;
}

/**
 * Create the VPC (public / private / isolated subnets in 2 AZs) with flow logs.
 *
 * @param scope - Stack the resources belong to (keeps logical IDs stable).
 * @returns The VPC.
 */
function buildVpc(scope: Construct): ec2.Vpc {
  const vpc = new ec2.Vpc(scope, 'Vpc', {
    maxAzs: 2,
    subnetConfiguration: [
      { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
    ],
  });

  vpc.addFlowLog('FlowLog', {
    destination: ec2.FlowLogDestination.toCloudWatchLogs(
      new logs.LogGroup(scope, 'VpcFlowLogGroup', { retention: logs.RetentionDays.ONE_MONTH }),
    ),
  });
  return vpc;
}

/**
 * Create the VPC and the security groups of the ALB, ECS, Aurora, ElastiCache and EFS.
 *
 * @param scope - Stack the resources belong to.
 * @param apachePort - Port the Apache container listens on behind the ALB.
 * @returns Network resources.
 */
export function buildNetwork(scope: Construct, apachePort: number): NetworkResources {
  const vpc = buildVpc(scope);

  const albSg = new ec2.SecurityGroup(scope, 'AlbSg', { vpc, description: 'ALB' });
  albSg.addIngressRule(ec2.Peer.ipv4('153.242.166.137/32'), ec2.Port.tcp(443));

  const ecsSg = new ec2.SecurityGroup(scope, 'EcsSg', { vpc, description: 'ECS Tasks' });
  ecsSg.addIngressRule(albSg, ec2.Port.tcp(apachePort));
  ecsSg.addIngressRule(ecsSg, ec2.Port.allTcp()); // inter-service

  const dbSg = new ec2.SecurityGroup(scope, 'DbSg', { vpc, description: 'Aurora' });
  dbSg.addIngressRule(ecsSg, ec2.Port.tcp(5432));

  const cacheSg = new ec2.SecurityGroup(scope, 'CacheSg', { vpc, description: 'ElastiCache' });
  cacheSg.addIngressRule(ecsSg, ec2.Port.tcp(6379));

  const efsSg = new ec2.SecurityGroup(scope, 'EfsSg', { vpc, description: 'EFS' });
  efsSg.addIngressRule(ecsSg, ec2.Port.tcp(2049));

  return { vpc, albSg, ecsSg, dbSg, cacheSg, efsSg };
}
