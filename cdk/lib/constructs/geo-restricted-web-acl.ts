import * as cdk from 'aws-cdk-lib';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

/**
 * Properties for {@link GeoRestrictedWebAcl}.
 */
export interface GeoRestrictedWebAclProps {
  /** Load balancer the web ACL is attached to. */
  readonly loadBalancer: elbv2.IApplicationLoadBalancer;
  /** ISO 3166 alpha-2 codes allowed to reach the load balancer (e.g. ["JP"]). */
  readonly allowedCountries: readonly string[];
  /**
   * IPv4 addresses always allowed regardless of country: the NAT Gateway
   * public IPs, because tasks inside the VPC (notify_push, OnlyOffice,
   * Nextcloud itself) call the public URL.
   */
  readonly alwaysAllowedIpv4: readonly string[];
}

/** Request headers that carry credentials and must not be written to the logs. */
const REDACTED_HEADERS = ['authorization', 'cookie', 'requesttoken'];

/**
 * Regional AWS WAF web ACL on the ALB that blocks requests from outside the
 * allowed countries.
 *
 * Rules (evaluated in order):
 *  1. AllowVpcEgress   - allow the NAT Gateway public IPs
 *  2. BlockOutsideAllowedCountries - block when the source IP is not in an allowed country
 *  default action: allow
 *
 * The client location is taken from the connection source IP (the ALB is the
 * edge, so no forwarded-IP header is trusted). Only blocked requests are
 * logged, with credential headers redacted.
 */
export class GeoRestrictedWebAcl extends Construct {
  /** The web ACL. */
  public readonly webAcl: wafv2.CfnWebACL;

  /** Log group receiving blocked requests. */
  public readonly logGroup: logs.LogGroup;

  /**
   * @param scope - Parent construct.
   * @param id - Construct id.
   * @param props - Target, allowed countries and always-allowed IPs.
   */
  public constructor(scope: Construct, id: string, props: GeoRestrictedWebAclProps) {
    super(scope, id);
    if (props.allowedCountries.length === 0) {
      throw new Error('GeoRestrictedWebAcl: allowedCountries must not be empty');
    }
    const stackName = cdk.Stack.of(this).stackName;

    const vpcEgress = new wafv2.CfnIPSet(this, 'VpcEgressIps', {
      scope: 'REGIONAL',
      ipAddressVersion: 'IPV4',
      addresses: props.alwaysAllowedIpv4.map((ip) => cdk.Fn.join('', [ip, '/32'])),
      description: 'NAT Gateway public IPs of the Nextcloud VPC',
    });

    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      description: `Allow only ${props.allowedCountries.join(', ')} to reach the Nextcloud ALB`,
      visibilityConfig: GeoRestrictedWebAcl.visibility(`${stackName}-geo-acl`),
      rules: [
        {
          name: 'AllowVpcEgress',
          priority: 0,
          action: { allow: {} },
          statement: { ipSetReferenceStatement: { arn: vpcEgress.attrArn } },
          visibilityConfig: GeoRestrictedWebAcl.visibility('AllowVpcEgress'),
        },
        {
          name: 'BlockOutsideAllowedCountries',
          priority: 1,
          action: { block: {} },
          statement: {
            notStatement: {
              statement: { geoMatchStatement: { countryCodes: [...props.allowedCountries] } },
            },
          },
          visibilityConfig: GeoRestrictedWebAcl.visibility('BlockOutsideAllowedCountries'),
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'AlbAssociation', {
      resourceArn: props.loadBalancer.loadBalancerArn,
      webAclArn: this.webAcl.attrArn,
    });

    // AWS WAF requires the "aws-waf-logs-" prefix for CloudWatch Logs destinations.
    this.logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `aws-waf-logs-${stackName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new wafv2.CfnLoggingConfiguration(this, 'Logging', {
      resourceArn: this.webAcl.attrArn,
      logDestinationConfigs: [this.logGroup.logGroupArn],
      redactedFields: REDACTED_HEADERS.map((name) => ({ singleHeader: { Name: name } })),
      loggingFilter: {
        DefaultBehavior: 'DROP',
        Filters: [{
          Behavior: 'KEEP',
          Requirement: 'MEETS_ANY',
          Conditions: [{ ActionCondition: { Action: 'BLOCK' } }],
        }],
      },
    });
  }

  /**
   * CloudWatch metrics and sampled requests for a rule or the web ACL.
   *
   * @param metricName - Metric name.
   * @returns Visibility configuration.
   */
  private static visibility(metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty {
    return { cloudWatchMetricsEnabled: true, metricName, sampledRequestsEnabled: true };
  }
}
