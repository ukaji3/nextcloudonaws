import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { StackConfig } from './config';

/**
 * Inputs of {@link buildLoadBalancer}.
 */
export interface LoadBalancerProps {
  readonly vpc: ec2.IVpc;
  readonly albSg: ec2.ISecurityGroup;
  readonly accessLogBucket: s3.IBucket;
  readonly apacheService: ecs.FargateService;
  readonly hostedZone?: route53.IHostedZone;
}

/**
 * Public ALB and the Apache target group.
 */
export interface LoadBalancerResources {
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly apacheTargetGroup: elbv2.ApplicationTargetGroup;
}

/**
 * Message raised when no TLS certificate can be resolved. The public ALB is
 * never created with a plaintext HTTP listener (fail closed).
 */
export const TLS_REQUIRED_MESSAGE =
  'TLS is required: set context "certificateArn" (existing ACM certificate in the stack region), '
  + 'or both "hostedZoneId" and "hostedZoneName" (a DNS-validated certificate is issued). '
  + 'The ALB is never created with a plaintext HTTP listener.';

/**
 * Resolve the TLS certificate: an existing ARN, or a DNS-validated certificate
 * when a hosted zone is configured. Without either, synthesis fails.
 *
 * @param scope - Stack the certificate belongs to.
 * @param config - Deployment parameters.
 * @param hostedZone - Hosted zone used for DNS validation.
 * @returns Certificate of the HTTPS listener.
 * @throws {Error} When neither a certificate ARN nor a hosted zone is configured.
 */
function resolveCertificate(
  scope: Construct,
  config: StackConfig,
  hostedZone?: route53.IHostedZone,
): acm.ICertificate {
  if (config.certificateArn) {
    return acm.Certificate.fromCertificateArn(scope, 'Cert', config.certificateArn);
  }
  if (hostedZone) {
    return new acm.Certificate(scope, 'Cert', { domainName: config.domain, validation: acm.CertificateValidation.fromDns(hostedZone) });
  }
  throw new Error(TLS_REQUIRED_MESSAGE);
}

/**
 * Create the internet-facing ALB, its HTTPS listener and the Apache target group.
 *
 * @param scope - Stack the resources belong to.
 * @param config - Deployment parameters.
 * @param props - Network, logging and target service.
 * @returns ALB and target group.
 * @throws {Error} When no TLS certificate can be resolved (see {@link TLS_REQUIRED_MESSAGE}).
 */
export function buildLoadBalancer(scope: Construct, config: StackConfig, props: LoadBalancerProps): LoadBalancerResources {
  const certificate = resolveCertificate(scope, config, props.hostedZone);

  const alb = new elbv2.ApplicationLoadBalancer(scope, 'Alb', {
    vpc: props.vpc,
    internetFacing: true,
    securityGroup: props.albSg,
  });
  alb.logAccessLogs(props.accessLogBucket, 'alb');

  const listener = alb.addListener('Listener', {
    port: 443,
    protocol: elbv2.ApplicationProtocol.HTTPS,
    certificates: [certificate],
    sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
    // Do not let CDK add its own 0.0.0.0/0 ingress rule: the ALB ingress is
    // declared explicitly in buildNetwork, and access is controlled by the WAF.
    open: false,
  });

  const apacheTargetGroup = listener.addTargets('ApacheTarget', {
    port: config.apachePort,
    protocol: elbv2.ApplicationProtocol.HTTP,
    targets: [props.apacheService],
    healthCheck: {
      path: '/status.php',
      port: String(config.apachePort),
      interval: cdk.Duration.seconds(30),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
      healthyHttpCodes: '200,400',
    },
    stickinessCookieDuration: cdk.Duration.hours(1),
  });

  return { alb, apacheTargetGroup };
}

/**
 * Create the Route 53 alias of the domain pointing at the ALB.
 *
 * @param scope - Stack the record belongs to.
 * @param config - Deployment parameters.
 * @param hostedZone - Hosted zone of the domain.
 * @param alb - Load balancer.
 */
export function buildDnsRecord(
  scope: Construct,
  config: StackConfig,
  hostedZone: route53.IHostedZone,
  alb: elbv2.IApplicationLoadBalancer,
): void {
  new route53.ARecord(scope, 'DnsRecord', {
    zone: hostedZone,
    recordName: config.domain,
    target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(alb)),
  });
}
