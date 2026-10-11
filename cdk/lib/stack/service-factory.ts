import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

/**
 * Shared placement of every Fargate service.
 */
export interface ServiceContext {
  /** Stack that owns the services (keeps logical IDs stable). */
  readonly scope: Construct;
  readonly cluster: ecs.ICluster;
  readonly namespace: servicediscovery.INamespace;
  readonly ecsSg: ec2.ISecurityGroup;
}

/**
 * Desired count and optional CPU-based auto scaling of a service.
 */
export interface ServiceOptions {
  /**
   * Desired count. When {@link managedDesiredCount} is true this is only used
   * as the documented baseline; CloudFormation does not set it.
   */
  readonly desiredCount?: number;
  readonly minCapacity?: number;
  readonly maxCapacity?: number;
  /**
   * Leave the desired count out of the template (default false).
   *
   * Use for services whose count is changed outside CloudFormation (the upgrade
   * state machine scales them to 0 and restores them). CloudFormation then
   * creates the service with 1 task and never changes the count on update, so a
   * `cdk deploy` during an upgrade only swaps the task definition. Changing the
   * count and the task definition in one UpdateService call made ECS start a
   * task of the previous revision as well (observed on 2026-10-11).
   */
  readonly managedDesiredCount?: boolean;
}

/**
 * Normal-operation desired counts, shared by the service definitions and the
 * upgrade state machine (scale down / restore) so the values cannot drift apart.
 */
export interface ServiceBaselineCounts {
  readonly nextcloud: number;
  readonly apache: number;
  readonly notifyPush: number;
}

/**
 * Create a Fargate service registered in Cloud Map as `nextcloud-aio-<name>`,
 * the host name the AIO containers expect.
 *
 * @param ctx - Shared placement.
 * @param name - Short service name (also the Cloud Map name suffix).
 * @param taskDefinition - Task definition to run.
 * @param opts - Desired count and auto scaling.
 * @returns The service.
 */
export function createFargateService(
  ctx: ServiceContext,
  name: string,
  taskDefinition: ecs.FargateTaskDefinition,
  opts?: ServiceOptions,
): ecs.FargateService {
  const svc = new ecs.FargateService(ctx.scope, `${name}Service`, {
    cluster: ctx.cluster,
    taskDefinition,
    desiredCount: opts?.managedDesiredCount ? undefined : (opts?.desiredCount ?? 1),
    securityGroups: [ctx.ecsSg],
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    cloudMapOptions: {
      name: `nextcloud-aio-${name}`,
      cloudMapNamespace: ctx.namespace,
      dnsRecordType: servicediscovery.DnsRecordType.A,
      dnsTtl: cdk.Duration.seconds(10),
    },
    enableExecuteCommand: true,
    circuitBreaker: { enable: true, rollback: true },
  });

  if (opts?.maxCapacity) {
    const scaling = svc.autoScaleTaskCount({ minCapacity: opts.minCapacity ?? 1, maxCapacity: opts.maxCapacity });
    scaling.scaleOnCpuUtilization(`${name}CpuScaling`, { targetUtilizationPercent: 70 });
  }
  return svc;
}

/**
 * Add an encrypted-in-transit EFS volume bound to an access point.
 *
 * @param taskDefinition - Task definition receiving the volume.
 * @param name - Volume name referenced by mount points.
 * @param fileSystemId - EFS file system id.
 * @param accessPointId - EFS access point id.
 */
export function addEfsVolume(
  taskDefinition: ecs.TaskDefinition,
  name: string,
  fileSystemId: string,
  accessPointId: string,
): void {
  taskDefinition.addVolume({
    name,
    efsVolumeConfiguration: {
      fileSystemId,
      transitEncryption: 'ENABLED',
      authorizationConfig: { accessPointId },
    },
  });
}
