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
  /**
   * ISO 3166 alpha-2 codes allowed to reach the load balancer (e.g. ["JP"]).
   * May be empty to allow only the configured IP ranges (for example while an
   * unpatched vulnerability is being handled); at least one country or one
   * CIDR is required so the ACL can never lock every client out.
   */
  readonly allowedCountries: readonly string[];
  /**
   * IPv4 addresses always allowed regardless of country: the NAT Gateway
   * public IPs, because tasks inside the VPC (notify_push, OnlyOffice,
   * Nextcloud itself) call the public URL.
   */
  readonly alwaysAllowedIpv4: readonly string[];
  /**
   * IPv4 CIDRs allowed regardless of country, for users outside the allowed
   * countries. Empty means the rule is not created.
   */
  readonly allowedIpv4Cidrs?: readonly string[];
  /**
   * IPv6 CIDRs allowed regardless of country, for users outside the allowed
   * countries. Empty means the rule is not created.
   */
  readonly allowedIpv6Cidrs?: readonly string[];
}

/** Request headers that carry credentials and must not be written to the logs. */
const REDACTED_HEADERS = ['authorization', 'cookie', 'requesttoken'];

/**
 * Pattern AWS WAF enforces on the Description of web ACLs and IP sets
 * (from the CreateWebACL validation error). Descriptions outside it make the
 * stack update fail at deploy time, not at synth time.
 */
export const WEB_ACL_DESCRIPTION_PATTERN = /^[\w+=:#@/\-,.][\w+=:#@/\-,.\s]+[\w+=:#@/\-,.]$/;

/** Rule priorities. Lower numbers are evaluated first. */
const PRIORITY = { vpcEgress: 0, ipv4: 1, ipv6: 2, countries: 3 } as const;

/** Address family and the IP set construct id per rule. */
interface IpRuleSpec {
  readonly name: string;
  readonly priority: number;
  readonly setId: string;
  readonly version: 'IPV4' | 'IPV6';
  readonly description: string;
  readonly addresses: readonly string[];
}

/**
 * Regional AWS WAF web ACL on the ALB. Every request is blocked unless a rule
 * explicitly allows it (default action: block).
 *
 * Allow rules, in evaluation order:
 *  0. AllowVpcEgress   - the NAT Gateway public IPs
 *  1. AllowListedIpv4  - configured IPv4 CIDRs (only when configured)
 *  2. AllowListedIpv6  - configured IPv6 CIDRs (only when configured)
 *  3. AllowedCountries - source IP geolocating to an allowed country
 *                        (omitted when no country is allowed, so only the
 *                        IP ranges pass)
 *
 * The client location comes from the connection source IP (the ALB is the edge,
 * so no forwarded-IP header is trusted). AWS WAF resolves it with the MaxMind
 * GeoIP database, so the country of a VPN or proxy decides the outcome, not the
 * user's physical location. Only blocked requests are logged, with credential
 * headers redacted.
 */
export class GeoRestrictedWebAcl extends Construct {
  /** The web ACL. */
  public readonly webAcl: wafv2.CfnWebACL;

  /** Log group receiving blocked requests. */
  public readonly logGroup: logs.LogGroup;

  /**
   * @param scope - Parent construct.
   * @param id - Construct id.
   * @param props - Target, allowed countries and allowed IP ranges.
   */
  public constructor(scope: Construct, id: string, props: GeoRestrictedWebAclProps) {
    super(scope, id);
    const allowedCidrCount = (props.allowedIpv4Cidrs?.length ?? 0) + (props.allowedIpv6Cidrs?.length ?? 0);
    if (props.allowedCountries.length === 0 && allowedCidrCount === 0) {
      throw new Error('GeoRestrictedWebAcl: allow at least one country or one CIDR; otherwise every client is blocked');
    }
    const stackName = cdk.Stack.of(this).stackName;

    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'REGIONAL',
      defaultAction: { block: {} },
      description: GeoRestrictedWebAcl.describe(props.allowedCountries),
      visibilityConfig: GeoRestrictedWebAcl.visibility(`${stackName}-geo-acl`),
      rules: this.buildRules(props),
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
   * Build the allow rules. The optional IP rules are left out when their list
   * is empty, so an unused rule never reaches the template.
   *
   * @param props - Allowed countries and allowed IP ranges.
   * @returns Rules in evaluation order.
   */
  private buildRules(props: GeoRestrictedWebAclProps): wafv2.CfnWebACL.RuleProperty[] {
    const specs: IpRuleSpec[] = [{
      name: 'AllowVpcEgress',
      priority: PRIORITY.vpcEgress,
      setId: 'VpcEgressIps',
      version: 'IPV4',
      description: 'NAT Gateway public IPs of the Nextcloud VPC',
      // The NAT public IPs are CloudFormation references, so the /32 suffix has
      // to be appended at deploy time.
      addresses: props.alwaysAllowedIpv4.map((ip) => cdk.Fn.join('', [ip, '/32'])),
    }];
    if (props.allowedIpv4Cidrs?.length) {
      specs.push({
        name: 'AllowListedIpv4',
        priority: PRIORITY.ipv4,
        setId: 'AllowedIpv4',
        version: 'IPV4',
        description: 'IPv4 CIDRs allowed regardless of country',
        addresses: props.allowedIpv4Cidrs,
      });
    }
    if (props.allowedIpv6Cidrs?.length) {
      specs.push({
        name: 'AllowListedIpv6',
        priority: PRIORITY.ipv6,
        setId: 'AllowedIpv6',
        version: 'IPV6',
        description: 'IPv6 CIDRs allowed regardless of country',
        addresses: props.allowedIpv6Cidrs,
      });
    }
    const rules = specs.map((spec) => this.ipSetRule(spec));
    if (props.allowedCountries.length > 0) {
      rules.push({
        name: 'AllowedCountries',
        priority: PRIORITY.countries,
        action: { allow: {} },
        statement: { geoMatchStatement: { countryCodes: [...props.allowedCountries] } },
        visibilityConfig: GeoRestrictedWebAcl.visibility('AllowedCountries'),
      });
    }
    return rules;
  }

  /**
   * Description of the web ACL. AWS WAF only accepts letters, digits, spaces
   * and `_+=:#@/-,.` here (see WEB_ACL_DESCRIPTION_PATTERN).
   *
   * @param allowedCountries - Allowed countries (may be empty).
   * @returns Human-readable summary of what passes.
   */
  private static describe(allowedCountries: readonly string[]): string {
    return allowedCountries.length > 0
      ? `Block every request except ${allowedCountries.join(', ')} and the configured IP ranges`
      : 'Block every request except the configured IP ranges, no country is allowed';
  }

  /**
   * Create an IP set and the rule allowing its addresses.
   *
   * @param spec - Rule name, priority, IP set id, address family, description and addresses.
   * @returns Allow rule referencing the new IP set.
   */
  private ipSetRule(spec: IpRuleSpec): wafv2.CfnWebACL.RuleProperty {
    const ipSet = new wafv2.CfnIPSet(this, spec.setId, {
      scope: 'REGIONAL',
      ipAddressVersion: spec.version,
      addresses: [...spec.addresses],
      description: spec.description,
    });
    return {
      name: spec.name,
      priority: spec.priority,
      action: { allow: {} },
      statement: { ipSetReferenceStatement: { arn: ipSet.attrArn } },
      visibilityConfig: GeoRestrictedWebAcl.visibility(spec.name),
    };
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
