#!/bin/bash
# shellcheck shell=bash
#
# nextcloudonaws: extra trusted proxies for Nextcloud.
#
# notify_push (and any other client inside the VPC) reaches Nextcloud through
# the public URL, so the request leaves through a NAT Gateway and the ALB adds
# the NAT Gateway public IP to X-Forwarded-For. Unless that IP is a trusted
# proxy, Nextcloud resolves it as the client address and notify_push's
# self-test reports "push server is not a trusted proxy".
#
# AWS_TRUSTED_PROXIES (space-separated IPs or CIDRs) is set by the CDK stack to
# the NAT Gateway public IPs. They are written to trusted_proxies indices
# 20-29, which are reserved for this list and rewritten on every start, so a
# removed or replaced NAT Gateway does not leave a stale entry behind.
#
# This file is a library: sourced by entrypoint.sh and by the tests.
#
# Overridable for tests:
#   aws_occ()   function wrapping "php /var/www/html/occ"

AWS_TRUSTED_PROXY_FIRST_INDEX=20
AWS_TRUSTED_PROXY_LAST_INDEX=29

if ! declare -F aws_occ >/dev/null; then
    # Run occ. Defined only if the caller has not provided its own wrapper.
    aws_occ() {
        php /var/www/html/occ "$@"
    }
fi

# Print the reserved indices currently present in trusted_proxies, one per line.
aws_reserved_trusted_proxy_indices() {
    # The PHP code is single-quoted on purpose; its variables belong to PHP.
    # shellcheck disable=SC2016
    aws_occ config:system:get trusted_proxies --output=json 2>/dev/null \
        | php -r '
            $d = json_decode(stream_get_contents(STDIN), true);
            if (!is_array($d)) { exit(0); }
            foreach (array_keys($d) as $k) {
                if (is_numeric($k) && $k >= (int)$argv[1] && $k <= (int)$argv[2]) { echo $k, PHP_EOL; }
            }' "$AWS_TRUSTED_PROXY_FIRST_INDEX" "$AWS_TRUSTED_PROXY_LAST_INDEX"
}

# True when the value looks like an IPv4/IPv6 address or CIDR.
# Arguments: $1 = value.
aws_is_ip_or_cidr() {
    [[ "$1" =~ ^[0-9A-Fa-f:.]+(/[0-9]{1,3})?$ ]]
}

# Rewrite the reserved trusted_proxies indices from AWS_TRUSTED_PROXIES.
# Entries outside the reserved range (127.0.0.1, ::1, the Apache range, ...)
# are never touched. Idempotent.
aws_apply_trusted_proxies() {
    local index proxy
    for index in $(aws_reserved_trusted_proxy_indices); do
        aws_occ config:system:delete trusted_proxies "$index" >/dev/null
    done
    index="$AWS_TRUSTED_PROXY_FIRST_INDEX"
    for proxy in ${AWS_TRUSTED_PROXIES:-}; do
        if ! aws_is_ip_or_cidr "$proxy"; then
            echo "WARNING: ignoring invalid trusted proxy '$proxy'"
            continue
        fi
        if [ "$index" -gt "$AWS_TRUSTED_PROXY_LAST_INDEX" ]; then
            echo "WARNING: more than $((AWS_TRUSTED_PROXY_LAST_INDEX - AWS_TRUSTED_PROXY_FIRST_INDEX + 1)) trusted proxies; ignoring '$proxy'"
            continue
        fi
        aws_occ config:system:set trusted_proxies "$index" --value="$proxy"
        index=$((index + 1))
    done
    return 0
}
