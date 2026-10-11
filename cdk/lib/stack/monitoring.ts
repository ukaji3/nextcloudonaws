import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { AlarmNotifications } from '../constructs/alarm-notifications';

/**
 * Resources observed by the alarms and the dashboard.
 */
export interface MonitoringTargets {
  readonly nextcloudService: ecs.FargateService;
  readonly apacheService: ecs.FargateService;
  readonly notifyService: ecs.FargateService;
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly dbCluster: rds.IDatabaseCluster;
  readonly logGroup: logs.ILogGroup;
  readonly auroraMaxAcu: number;
  readonly alarmEmails: readonly string[];
}

/**
 * Definition of one alarm.
 */
interface AlarmSpec {
  readonly id: string;
  readonly metric: cloudwatch.IMetric;
  readonly threshold: number;
  readonly evaluationPeriods: number;
  readonly description: string;
  readonly treatMissingData: cloudwatch.TreatMissingData;
  readonly comparisonOperator?: cloudwatch.ComparisonOperator;
}

const FIVE_MINUTES = cdk.Duration.minutes(5);
// NOT_BREACHING for request/error metrics that emit no datapoints when idle
// (TargetResponseTime has no data without traffic, which previously made the
// alarm flap between OK and INSUFFICIENT_DATA many times a day);
// MISSING for resource metrics that are always reported while the resource runs.
const IDLE_OK = cloudwatch.TreatMissingData.NOT_BREACHING;
const ALWAYS_REPORTED = cloudwatch.TreatMissingData.MISSING;

/**
 * Aurora cluster metric.
 *
 * @param dbCluster - Cluster.
 * @param metricName - AWS/RDS metric name.
 * @param opts - Optional period, statistic and label (metric defaults otherwise).
 * @param opts.period - Aggregation period.
 * @param opts.statistic - Statistic, e.g. "Average".
 * @param opts.label - Legend label.
 * @returns The metric.
 */
function auroraMetric(
  dbCluster: rds.IDatabaseCluster,
  metricName: string,
  opts: { period?: cdk.Duration; statistic?: string; label?: string } = {},
): cloudwatch.Metric {
  return new cloudwatch.Metric({
    namespace: 'AWS/RDS',
    metricName,
    dimensionsMap: { DBClusterIdentifier: dbCluster.clusterIdentifier },
    ...opts,
  });
}

/**
 * ECS and ALB alarm definitions.
 *
 * @param t - Monitored resources.
 * @returns Alarm definitions in creation order.
 */
function serviceAlarmSpecs(t: MonitoringTargets): AlarmSpec[] {
  return [
    { id: 'NextcloudCpuAlarm', metric: t.nextcloudService.metricCpuUtilization({ period: FIVE_MINUTES }), threshold: 80, evaluationPeriods: 3, description: 'Nextcloud ECS CPU > 80% for 15 min', treatMissingData: ALWAYS_REPORTED },
    { id: 'NextcloudMemoryAlarm', metric: t.nextcloudService.metricMemoryUtilization({ period: FIVE_MINUTES }), threshold: 85, evaluationPeriods: 3, description: 'Nextcloud ECS Memory > 85% for 15 min', treatMissingData: ALWAYS_REPORTED },
    { id: 'ApacheCpuAlarm', metric: t.apacheService.metricCpuUtilization({ period: FIVE_MINUTES }), threshold: 80, evaluationPeriods: 3, description: 'Apache ECS CPU > 80% for 15 min', treatMissingData: ALWAYS_REPORTED },
    { id: 'Alb5xxAlarm', metric: t.alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: FIVE_MINUTES }), threshold: 10, evaluationPeriods: 2, description: 'ALB 5xx errors > 10 for 10 min', treatMissingData: IDLE_OK },
    { id: 'Target5xxAlarm', metric: t.alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: FIVE_MINUTES }), threshold: 10, evaluationPeriods: 2, description: 'Target 5xx errors > 10 for 10 min', treatMissingData: IDLE_OK },
    { id: 'ResponseTimeAlarm', metric: t.alb.metrics.targetResponseTime({ period: FIVE_MINUTES, statistic: 'p95' }), threshold: 5, evaluationPeriods: 3, description: 'ALB p95 response time > 5s for 15 min', treatMissingData: IDLE_OK },
    {
      id: 'UnhealthyTargetsAlarm',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'UnHealthyHostCount',
        dimensionsMap: { LoadBalancer: t.alb.loadBalancerFullName },
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 1, evaluationPeriods: 3, description: 'Unhealthy targets detected for 3 min', treatMissingData: IDLE_OK,
    },
  ];
}

/**
 * Aurora and application log alarm definitions.
 *
 * @param t - Monitored resources.
 * @param errorMetric - Error log metric filter.
 * @returns Alarm definitions in creation order.
 */
function dataAlarmSpecs(t: MonitoringTargets, errorMetric: logs.MetricFilter): AlarmSpec[] {
  const capacityThreshold = t.auroraMaxAcu * 0.8;
  return [
    { id: 'AuroraCpuAlarm', metric: auroraMetric(t.dbCluster, 'CPUUtilization', { period: FIVE_MINUTES, statistic: 'Average' }), threshold: 80, evaluationPeriods: 3, description: 'Aurora CPU > 80% for 15 min', treatMissingData: ALWAYS_REPORTED },
    { id: 'AuroraCapacityAlarm', metric: auroraMetric(t.dbCluster, 'ServerlessDatabaseCapacity', { period: FIVE_MINUTES, statistic: 'Average' }), threshold: capacityThreshold, evaluationPeriods: 3, description: `Aurora capacity > ${String(capacityThreshold)} ACU for 15 min`, treatMissingData: ALWAYS_REPORTED },
    {
      id: 'AuroraMemoryAlarm',
      metric: auroraMetric(t.dbCluster, 'FreeableMemory', { period: FIVE_MINUTES, statistic: 'Average' }),
      threshold: 256 * 1024 * 1024, // 256MB
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      description: 'Aurora freeable memory < 256MB for 15 min',
      treatMissingData: ALWAYS_REPORTED,
    },
    { id: 'ErrorLogAlarm', metric: errorMetric.metric({ period: FIVE_MINUTES, statistic: 'Sum' }), threshold: 50, evaluationPeriods: 2, description: 'Error log count > 50 in 10 min', treatMissingData: IDLE_OK },
  ];
}

/**
 * Create the error log metric filter.
 *
 * @param scope - Stack the filter belongs to.
 * @param logGroup - ECS log group.
 * @returns The metric filter.
 */
export function buildErrorMetric(scope: Construct, logGroup: logs.ILogGroup): logs.MetricFilter {
  return new logs.MetricFilter(scope, 'ErrorLogFilter', {
    logGroup,
    filterPattern: logs.FilterPattern.anyTerm('ERROR', 'CRITICAL', 'Fatal'),
    metricNamespace: 'Nextcloud',
    metricName: 'ErrorCount',
    metricValue: '1',
    defaultValue: 0,
  });
}

/**
 * Create every alarm and send their ALARM / OK transitions to the SNS topic.
 *
 * @param scope - Stack the alarms belong to.
 * @param t - Monitored resources and notification recipients.
 * @param errorMetric - Error log metric filter.
 * @returns The alarms.
 */
export function buildAlarms(scope: Construct, t: MonitoringTargets, errorMetric: logs.MetricFilter): cloudwatch.Alarm[] {
  const notifications = new AlarmNotifications(scope, 'AlarmNotifications', { emailAddresses: t.alarmEmails });
  const alarms = [...serviceAlarmSpecs(t), ...dataAlarmSpecs(t, errorMetric)].map((spec) => new cloudwatch.Alarm(scope, spec.id, {
    metric: spec.metric,
    threshold: spec.threshold,
    evaluationPeriods: spec.evaluationPeriods,
    alarmDescription: spec.description,
    treatMissingData: spec.treatMissingData,
    ...(spec.comparisonOperator ? { comparisonOperator: spec.comparisonOperator } : {}),
  }));
  alarms.forEach((alarm) => { notifications.watch(alarm); });
  return alarms;
}

/**
 * ECS and ALB dashboard rows.
 *
 * @param t - Monitored resources.
 * @returns Widgets of the first two rows.
 */
function serviceWidgets(t: MonitoringTargets): cloudwatch.IWidget[][] {
  return [
    [
      new cloudwatch.GraphWidget({
        title: 'ECS CPU Utilization',
        left: [
          t.nextcloudService.metricCpuUtilization({ label: 'Nextcloud' }),
          t.apacheService.metricCpuUtilization({ label: 'Apache' }),
          t.notifyService.metricCpuUtilization({ label: 'Notify-push' }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'ECS Memory Utilization',
        left: [
          t.nextcloudService.metricMemoryUtilization({ label: 'Nextcloud' }),
          t.apacheService.metricMemoryUtilization({ label: 'Apache' }),
          t.notifyService.metricMemoryUtilization({ label: 'Notify-push' }),
        ],
        width: 12,
      }),
    ],
    [
      new cloudwatch.GraphWidget({
        title: 'ALB Request Count & Errors',
        left: [t.alb.metrics.requestCount({ label: 'Requests' })],
        right: [
          t.alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { label: '5xx', color: '#d62728' }),
          t.alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { label: 'Target 5xx', color: '#ff7f0e' }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'ALB Response Time (p50/p95/p99)',
        left: [
          t.alb.metrics.targetResponseTime({ label: 'p50', statistic: 'p50' }),
          t.alb.metrics.targetResponseTime({ label: 'p95', statistic: 'p95' }),
          t.alb.metrics.targetResponseTime({ label: 'p99', statistic: 'p99' }),
        ],
        width: 12,
      }),
    ],
  ];
}

/**
 * Aurora and error dashboard rows.
 *
 * @param t - Monitored resources.
 * @param errorMetric - Error log metric filter.
 * @returns Widgets of the last two rows.
 */
function dataWidgets(t: MonitoringTargets, errorMetric: logs.MetricFilter): cloudwatch.IWidget[][] {
  const db = t.dbCluster;
  return [
    [
      new cloudwatch.GraphWidget({
        title: 'Aurora CPU & Capacity',
        left: [auroraMetric(db, 'CPUUtilization', { label: 'CPU %' })],
        right: [auroraMetric(db, 'ServerlessDatabaseCapacity', { label: 'ACU' })],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Aurora Connections & Latency',
        left: [auroraMetric(db, 'DatabaseConnections', { label: 'Connections' })],
        right: [auroraMetric(db, 'ReadLatency', { label: 'Read' }), auroraMetric(db, 'WriteLatency', { label: 'Write' })],
        width: 12,
      }),
    ],
    [
      new cloudwatch.GraphWidget({
        title: 'Application Error Logs',
        left: [errorMetric.metric({ label: 'Errors', statistic: 'Sum' })],
        width: 12,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Running Tasks',
        metrics: [
          t.nextcloudService.metricCpuUtilization({ label: 'Nextcloud CPU' }),
          t.apacheService.metricCpuUtilization({ label: 'Apache CPU' }),
        ],
        width: 12,
      }),
    ],
  ];
}

/**
 * Create the Nextcloud-Monitoring dashboard (ECS, ALB, Aurora, errors).
 *
 * @param scope - Stack the dashboard belongs to.
 * @param t - Monitored resources.
 * @param errorMetric - Error log metric filter.
 */
export function buildDashboard(scope: Construct, t: MonitoringTargets, errorMetric: logs.MetricFilter): void {
  const dashboard = new cloudwatch.Dashboard(scope, 'Dashboard', { dashboardName: 'Nextcloud-Monitoring' });
  for (const row of [...serviceWidgets(t), ...dataWidgets(t, errorMetric)]) {
    dashboard.addWidgets(...row);
  }
}
