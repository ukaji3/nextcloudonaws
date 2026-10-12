/**
 * Checks of where compute resources are placed in a synthesized template.
 *
 * - EC2 rule (project security rule): EC2 instances, including those launched
 *   through Auto Scaling groups or launch templates, must not be placed in
 *   public subnets or request a public IP. ALB, NLB and NAT Gateway are
 *   excluded (they are the internet-facing entry/exit points).
 * - ECS design check: tasks (services and the upgrade state machine's one-off
 *   tasks) run in non-public subnets without a public IP. This verifies the
 *   current design; it is not part of the EC2 rule.
 */

/** A CloudFormation resource as found in a synthesized template. */
export interface CfnResource {
  readonly Type: string;
  readonly Properties?: Record<string, unknown>;
}

/** Logical ID -> resource. */
export type CfnResources = Record<string, CfnResource>;

/** EC2 resource types that launch instances or define their network placement. */
const EC2_LAUNCHING_TYPES = new Set([
  'AWS::EC2::Instance',
  'AWS::AutoScaling::AutoScalingGroup',
  'AWS::EC2::LaunchTemplate',
  'AWS::AutoScaling::LaunchConfiguration',
]);

/**
 * Narrow a value to a plain object.
 *
 * @param value - Any template value.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Return the value as an array of unknown elements.
 *
 * @param value - Any template value.
 * @returns The elements, or an empty array when the value is not an array.
 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/**
 * Collect the logical IDs referenced with `{ "Ref": ... }` anywhere in a value.
 *
 * @param value - Any template value.
 * @param found - Accumulator.
 * @returns Referenced logical IDs.
 */
export function referencedLogicalIds(value: unknown, found: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    asArray(value).forEach((item) => { referencedLogicalIds(item, found); });
  } else if (isRecord(value)) {
    if (typeof value.Ref === 'string') {
      found.add(value.Ref);
    }
    Object.values(value).forEach((item) => { referencedLogicalIds(item, found); });
  }
  return found;
}

/**
 * Whether any `AssociatePublicIpAddress: true` occurs in a value.
 *
 * @param value - Any template value.
 * @returns True when a public IP is requested.
 */
function requestsPublicIp(value: unknown): boolean {
  if (Array.isArray(value)) {
    return asArray(value).some(requestsPublicIp);
  }
  if (!isRecord(value)) {
    return false;
  }
  return value.AssociatePublicIpAddress === true || Object.values(value).some(requestsPublicIp);
}

/**
 * Route tables that have a route to an internet gateway.
 *
 * @param resources - Template resources.
 * @returns Logical IDs of the route tables.
 */
function internetRouteTableIds(resources: CfnResources): Set<string> {
  const gateways = new Set(Object.entries(resources)
    .filter(([, r]) => r.Type === 'AWS::EC2::InternetGateway')
    .map(([id]) => id));
  const tables = new Set<string>();
  for (const r of Object.values(resources)) {
    if (r.Type !== 'AWS::EC2::Route') {
      continue;
    }
    const viaIgw = [...referencedLogicalIds(r.Properties?.GatewayId)].some((id) => gateways.has(id));
    if (viaIgw) {
      referencedLogicalIds(r.Properties?.RouteTableId).forEach((id) => tables.add(id));
    }
  }
  return tables;
}

/**
 * Whether a subnet resource is marked public by its own properties.
 *
 * @param subnet - Subnet resource.
 * @returns True when MapPublicIpOnLaunch is set or CDK tagged it "Public".
 */
function markedPublic(subnet: CfnResource): boolean {
  const tag = asArray(subnet.Properties?.Tags)
    .find((t) => isRecord(t) && t.Key === 'aws-cdk:subnet-type');
  return subnet.Properties?.MapPublicIpOnLaunch === true || (isRecord(tag) && tag.Value === 'Public');
}

/**
 * Logical IDs of public subnets: associated with a route table that routes to
 * an internet gateway, or marked public (MapPublicIpOnLaunch / CDK tag).
 *
 * @param resources - Template resources.
 * @returns Public subnet logical IDs.
 */
export function publicSubnetIds(resources: CfnResources): Set<string> {
  const ids = new Set(Object.entries(resources)
    .filter(([, r]) => r.Type === 'AWS::EC2::Subnet' && markedPublic(r))
    .map(([id]) => id));
  const internetTables = internetRouteTableIds(resources);
  for (const r of Object.values(resources)) {
    if (r.Type !== 'AWS::EC2::SubnetRouteTableAssociation') {
      continue;
    }
    const routesToInternet = [...referencedLogicalIds(r.Properties?.RouteTableId)].some((id) => internetTables.has(id));
    if (routesToInternet) {
      referencedLogicalIds(r.Properties?.SubnetId).forEach((id) => ids.add(id));
    }
  }
  return ids;
}

/**
 * Describe the public subnets a resource references.
 *
 * @param id - Logical ID of the resource.
 * @param resource - The resource.
 * @param publicSubnets - Public subnet logical IDs.
 * @returns One violation message per referenced public subnet.
 */
function publicSubnetReferences(id: string, resource: CfnResource, publicSubnets: Set<string>): string[] {
  return [...referencedLogicalIds(resource.Properties)]
    .filter((ref) => publicSubnets.has(ref))
    .map((ref) => `${id} (${resource.Type}) is placed in public subnet ${ref}`);
}

/**
 * EC2 rule: no EC2 instance in a public subnet. ALB, NLB and NAT Gateway are
 * not checked (excluded by the rule).
 *
 * @param resources - Template resources.
 * @returns Violation messages (empty when compliant).
 */
export function ec2PublicPlacementViolations(resources: CfnResources): string[] {
  const publicSubnets = publicSubnetIds(resources);
  const violations: string[] = [];
  for (const [id, resource] of Object.entries(resources)) {
    if (!EC2_LAUNCHING_TYPES.has(resource.Type)) {
      continue;
    }
    violations.push(...publicSubnetReferences(id, resource, publicSubnets));
    if (requestsPublicIp(resource.Properties)) {
      violations.push(`${id} (${resource.Type}) requests a public IP address`);
    }
  }
  return violations;
}

/**
 * Check one ECS service's awsvpc configuration.
 *
 * @param id - Logical ID of the service.
 * @param service - The service resource.
 * @param publicSubnets - Public subnet logical IDs.
 * @returns Violation messages.
 */
function ecsServiceViolations(id: string, service: CfnResource, publicSubnets: Set<string>): string[] {
  const network = service.Properties?.NetworkConfiguration;
  const awsvpc = isRecord(network) ? network.AwsvpcConfiguration : undefined;
  if (!isRecord(awsvpc)) {
    return [`${id} (AWS::ECS::Service) has no awsvpc network configuration`];
  }
  const violations = publicSubnetReferences(id, service, publicSubnets);
  if (awsvpc.AssignPublicIp === 'ENABLED') {
    violations.push(`${id} (AWS::ECS::Service) assigns a public IP to its tasks`);
  }
  return violations;
}

/**
 * Check the RunTask states of a state machine.
 *
 * @param id - Logical ID of the state machine.
 * @param machine - The state machine resource.
 * @param publicSubnets - Public subnet logical IDs.
 * @returns Violation messages.
 */
function stateMachineViolations(id: string, machine: CfnResource, publicSubnets: Set<string>): string[] {
  const violations = publicSubnetReferences(id, machine, publicSubnets);
  if (/AssignPublicIp\W+ENABLED/.test(JSON.stringify(machine.Properties?.DefinitionString))) {
    violations.push(`${id} (AWS::StepFunctions::StateMachine) runs tasks with a public IP`);
  }
  return violations;
}

/**
 * ECS design check: services and state machine tasks stay out of public
 * subnets and do not request a public IP (ECS default is DISABLED).
 *
 * @param resources - Template resources.
 * @returns Violation messages (empty when compliant).
 */
export function ecsPublicPlacementViolations(resources: CfnResources): string[] {
  const publicSubnets = publicSubnetIds(resources);
  const violations: string[] = [];
  for (const [id, resource] of Object.entries(resources)) {
    if (resource.Type === 'AWS::ECS::Service') {
      violations.push(...ecsServiceViolations(id, resource, publicSubnets));
    } else if (resource.Type === 'AWS::StepFunctions::StateMachine') {
      violations.push(...stateMachineViolations(id, resource, publicSubnets));
    }
  }
  return violations;
}
