import { Construct } from 'constructs';

/**
 * Deployment parameters read from the CDK context (cdk.json / -c).
 */
export interface StackConfig {
  readonly domain: string;
  readonly certificateArn: string;
  readonly hostedZoneId: string;
  readonly hostedZoneName: string;
  /** Tag of the AIO images (apache, onlyoffice, imaginary, talk). */
  readonly aioImageTag: string;
  /**
   * Tag of the notify-push image (defaults to {@link aioImageTag}).
   * Kept as a separate parameter so notify-push can be pinned independently.
   */
  readonly aioNotifyPushImageTag: string;
  readonly nextcloudImageUri: string;
  readonly apachePort: number;
  readonly enableOnlyOffice: boolean;
  readonly enableTalk: boolean;
  readonly enableFulltextsearch: boolean;
  readonly enableImaginary: boolean;
  readonly enableClamav: boolean;
  readonly auroraMinAcu: number;
  readonly auroraMaxAcu: number;
  /** Alarm notification recipients. */
  readonly alarmEmails: readonly string[];
  readonly auroraBackupRetentionDays: number;
  readonly backupDailyRetentionDays: number;
  readonly backupWeeklyRetentionDays: number;
  /** ECR repositories scanned on push. */
  readonly ecrScanRepositories: readonly string[];
}

/**
 * Read a raw context value.
 *
 * @param scope - Construct whose node holds the context.
 * @param key - Context key.
 * @returns The raw value, or undefined when not set.
 */
function readContext(scope: Construct, key: string): unknown {
  return scope.node.tryGetContext(key) as unknown;
}

/**
 * True when the value counts as "not set" (undefined, null, '', 0 or false).
 * Mirrors the `value || fallback` semantics the stack has always used.
 *
 * @param value - Raw context value.
 * @returns Whether the fallback should be used.
 */
function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === '' || value === 0 || value === false;
}

/**
 * Read a string context value.
 *
 * @param scope - Construct whose node holds the context.
 * @param key - Context key.
 * @param fallback - Value used when the key is unset or empty.
 * @returns The configured string.
 */
function contextString(scope: Construct, key: string, fallback: string): string {
  const value = readContext(scope, key);
  if (isUnset(value)) {
    return fallback;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  throw new Error(`Context "${key}" must be a string`);
}

/**
 * Read a numeric context value.
 *
 * @param scope - Construct whose node holds the context.
 * @param key - Context key.
 * @param fallback - Value used when the key is unset, empty or 0.
 * @returns The configured number.
 */
function contextNumber(scope: Construct, key: string, fallback: number): number {
  const value = readContext(scope, key);
  if (isUnset(value)) {
    return fallback;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Context "${key}" must be a number`);
  }
  return parsed;
}

/**
 * Read a feature flag. Only the string "true" enables a feature.
 *
 * @param scope - Construct whose node holds the context.
 * @param key - Context key.
 * @returns Whether the flag is enabled.
 */
function contextFlag(scope: Construct, key: string): boolean {
  return readContext(scope, key) === 'true';
}

/**
 * Read a comma-separated list.
 *
 * @param scope - Construct whose node holds the context.
 * @param key - Context key.
 * @param fallback - Comma-separated value used when the key is unset.
 * @returns Trimmed, non-empty entries.
 */
function contextList(scope: Construct, key: string, fallback: string): readonly string[] {
  return contextString(scope, key, fallback)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Load every deployment parameter from the CDK context.
 *
 * @param scope - Stack whose node holds the context.
 * @returns Typed configuration.
 */
export function loadStackConfig(scope: Construct): StackConfig {
  const aioImageTag = contextString(scope, 'aioImageTag', '20260218_123804');
  return {
    domain: contextString(scope, 'domain', 'cloud.example.com'),
    certificateArn: contextString(scope, 'certificateArn', ''),
    hostedZoneId: contextString(scope, 'hostedZoneId', ''),
    hostedZoneName: contextString(scope, 'hostedZoneName', ''),
    aioImageTag,
    aioNotifyPushImageTag: contextString(scope, 'aioNotifyPushImageTag', aioImageTag),
    nextcloudImageUri: contextString(scope, 'nextcloudImageUri', `ghcr.io/nextcloud-releases/aio-nextcloud:${aioImageTag}`),
    apachePort: contextNumber(scope, 'apachePort', 11000),
    enableOnlyOffice: contextFlag(scope, 'enableOnlyOffice'),
    enableTalk: contextFlag(scope, 'enableTalk'),
    enableFulltextsearch: contextFlag(scope, 'enableFulltextsearch'),
    enableImaginary: contextFlag(scope, 'enableImaginary'),
    enableClamav: contextFlag(scope, 'enableClamav'),
    auroraMinAcu: contextNumber(scope, 'auroraMinAcu', 0.5),
    auroraMaxAcu: contextNumber(scope, 'auroraMaxAcu', 16),
    alarmEmails: contextList(scope, 'alarmEmails', ''),
    auroraBackupRetentionDays: contextNumber(scope, 'auroraBackupRetentionDays', 7),
    backupDailyRetentionDays: contextNumber(scope, 'backupDailyRetentionDays', 35),
    backupWeeklyRetentionDays: contextNumber(scope, 'backupWeeklyRetentionDays', 90),
    ecrScanRepositories: contextList(scope, 'ecrScanRepositories', 'aio-nextcloud'),
  };
}
