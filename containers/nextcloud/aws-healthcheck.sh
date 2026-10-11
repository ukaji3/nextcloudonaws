#!/bin/bash
# nextcloudonaws: container health check used by the ECS task definition.
#
# ECS (and Cloud Map, which follows the container health) must not treat a new
# task as ready while entrypoint.sh is still running, otherwise the old task is
# stopped and Apache is routed to a task that cannot serve requests (observed:
# 19 minutes of 502 on 2026-10-11). Readiness = php-fpm accepts connections.
#
# A task must not be replaced while it is installing or upgrading Nextcloud,
# because interrupting occ upgrade / rsync on the shared EFS volume can leave the
# instance broken. Those phases therefore report healthy:
#   - maintenance mode is on (set by occ upgrade, or by the upgrade state machine;
#     the whole instance is unavailable anyway, so nothing is lost)
#   - occ upgrade / occ maintenance:install / rsync is running
#
# Everything else falls back to the upstream AIO /healthcheck.sh, which also
# reports healthy when the database is unreachable (restarting would not help).
#
# Overridable for tests:
#   AWS_HC_CONFIG    path of config.php     (default /var/www/html/config/config.php)
#   AWS_HC_UPSTREAM  upstream health check  (default /healthcheck.sh)

AWS_HC_CONFIG="${AWS_HC_CONFIG:-/var/www/html/config/config.php}"
AWS_HC_UPSTREAM="${AWS_HC_UPSTREAM:-/healthcheck.sh}"

# php-fpm is accepting connections.
fpm_ready() {
    nc -z 127.0.0.1 9000 >/dev/null 2>&1
}

# Maintenance mode is enabled in the shared config.php.
maintenance_on() {
    [ -r "$AWS_HC_CONFIG" ] && grep -Eq "'maintenance'[[:space:]]*=>[[:space:]]*true" "$AWS_HC_CONFIG"
}

# An install, upgrade or code sync that must not be interrupted is running.
provisioning_in_progress() {
    pgrep -f '/var/www/html/occ (upgrade|maintenance:install)' >/dev/null 2>&1 \
        || pgrep -x rsync >/dev/null 2>&1
}

if fpm_ready || maintenance_on || provisioning_in_progress; then
    exit 0
fi
exec "$AWS_HC_UPSTREAM"
