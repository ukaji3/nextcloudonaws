import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

/**
 * Feature flags that decide which optional secrets exist.
 */
export interface FeatureFlags {
  readonly fulltextsearch: boolean;
  readonly imaginary: boolean;
  readonly talk: boolean;
}

/**
 * Secrets of optional features; undefined when the feature is disabled.
 */
export interface FeatureSecrets {
  readonly osSecret?: secretsmanager.Secret;
  readonly imaginarySecret?: secretsmanager.Secret;
  readonly talkSecret?: secretsmanager.Secret;
  readonly signalingSecret?: secretsmanager.Secret;
  readonly talkInternalSecret?: secretsmanager.Secret;
}

/**
 * Inputs of {@link buildSearchDomain}.
 */
export interface SearchDomainProps {
  readonly vpc: ec2.IVpc;
  readonly ecsSg: ec2.ISecurityGroup;
  /** OpenSearch master user secret; the domain is created only when present. */
  readonly osSecret?: secretsmanager.Secret;
}

/**
 * Create a 32-character secret without punctuation.
 *
 * @param scope - Stack the secret belongs to.
 * @param id - Construct id.
 * @returns The secret.
 */
function alphanumericSecret(scope: Construct, id: string): secretsmanager.Secret {
  return new secretsmanager.Secret(scope, id, {
    generateSecretString: { excludePunctuation: true, passwordLength: 32 },
  });
}

/**
 * Create the OpenSearch master user secret (URL-safe password).
 *
 * @param scope - Stack the secret belongs to.
 * @returns The secret.
 */
function openSearchSecret(scope: Construct): secretsmanager.Secret {
  return new secretsmanager.Secret(scope, 'OsSecret', {
    generateSecretString: {
      secretStringTemplate: JSON.stringify({ username: 'admin' }),
      generateStringKey: 'password',
      excludeCharacters: '&<>"\'/\\@#%{}|^~`[]',
      includeSpace: false,
      passwordLength: 32,
      requireEachIncludedType: true,
    },
  });
}

/**
 * Create the secrets of the enabled optional features.
 * They are created before the Nextcloud container, which references them.
 *
 * @param scope - Stack the secrets belong to.
 * @param flags - Enabled features.
 * @returns Secrets per feature.
 */
export function buildFeatureSecrets(scope: Construct, flags: FeatureFlags): FeatureSecrets {
  return {
    osSecret: flags.fulltextsearch ? openSearchSecret(scope) : undefined,
    imaginarySecret: flags.imaginary ? alphanumericSecret(scope, 'ImaginarySecret') : undefined,
    talkSecret: flags.talk ? alphanumericSecret(scope, 'TalkSecret') : undefined,
    signalingSecret: flags.talk ? alphanumericSecret(scope, 'SignalingSecret') : undefined,
    talkInternalSecret: flags.talk ? alphanumericSecret(scope, 'TalkInternalSecret') : undefined,
  };
}

/**
 * Create the OpenSearch Service domain used for full-text search.
 *
 * @param scope - Stack the resources belong to.
 * @param props - Network placement and master user secret.
 * @returns The domain, or undefined when full-text search is disabled.
 */
export function buildSearchDomain(scope: Construct, props: SearchDomainProps): opensearch.Domain | undefined {
  if (!props.osSecret) {
    return undefined;
  }
  const osSg = new ec2.SecurityGroup(scope, 'OsSg', { vpc: props.vpc, description: 'OpenSearch' });
  osSg.addIngressRule(props.ecsSg, ec2.Port.tcp(443));

  return new opensearch.Domain(scope, 'OsDomain', {
    version: opensearch.EngineVersion.OPENSEARCH_2_17,
    vpc: props.vpc,
    vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
    securityGroups: [osSg],
    zoneAwareness: { enabled: true, availabilityZoneCount: 2 },
    capacity: {
      dataNodeInstanceType: 't3.medium.search',
      dataNodes: 2,
      multiAzWithStandbyEnabled: false,
    },
    ebs: { volumeSize: 20, volumeType: ec2.EbsDeviceVolumeType.GP3 },
    nodeToNodeEncryption: true,
    encryptionAtRest: { enabled: true },
    enforceHttps: true,
    fineGrainedAccessControl: {
      masterUserName: 'admin',
      masterUserPassword: props.osSecret.secretValueFromJson('password'),
    },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
}
