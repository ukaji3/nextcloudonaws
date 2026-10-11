import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

/**
 * Properties for {@link ImageScanning}.
 */
export interface ImageScanningProps {
  /**
   * ECR repository names scanned on push (exact names, no wildcards).
   * Repositories that are not listed keep the account's default behaviour.
   */
  readonly repositoryNames: readonly string[];
}

/**
 * Registry-level BASIC scanning: every push to the listed repositories is
 * scanned for OS package CVEs.
 *
 * The registry scanning configuration is a single per-region resource of the
 * account. This construct therefore owns it; other stacks in the same account
 * and region must not define it as well.
 */
export class ImageScanning extends Construct {
  /** Underlying CloudFormation resource. */
  public readonly configuration: ecr.CfnRegistryScanningConfiguration;

  /**
   * @param scope - Parent construct.
   * @param id - Construct id.
   * @param props - Repositories to scan.
   */
  public constructor(scope: Construct, id: string, props: ImageScanningProps) {
    super(scope, id);

    this.configuration = new ecr.CfnRegistryScanningConfiguration(this, 'Configuration', {
      scanType: 'BASIC',
      rules: [{
        scanFrequency: 'SCAN_ON_PUSH',
        repositoryFilters: props.repositoryNames.map((name) => ({
          filter: name,
          filterType: 'WILDCARD',
        })),
      }],
    });
  }
}
