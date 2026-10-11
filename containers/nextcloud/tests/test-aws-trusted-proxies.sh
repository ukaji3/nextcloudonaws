#!/bin/bash
# Tests for containers/nextcloud/aws-trusted-proxies.sh
# Usage: bash containers/nextcloud/tests/test-aws-trusted-proxies.sh
# occ is replaced by a stub that keeps trusted_proxies in a JSON file; php is required.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/../aws-trusted-proxies.sh"
PASS=0
FAIL=0
WORK=""

if ! command -v php >/dev/null 2>&1; then
    echo "ok - all # SKIP php is not installed"
    exit 0
fi

# Fresh sandbox; $1 = initial trusted_proxies JSON.
setup() {
    WORK="$(mktemp -d)"
    printf '%s' "$1" > "$WORK/proxies.json"
    : > "$WORK/occ.log"
    # Stub: config:system:get/set/delete trusted_proxies backed by proxies.json
    aws_occ() {
        echo "$*" >> "$WORK/occ.log"
        local action="$1" index="${3:-}" value=""
        [ "${4:-}" != "" ] && value="${4#--value=}"
        case "$action" in
            config:system:get) cat "$WORK/proxies.json" ;;
            config:system:delete|config:system:set)
                # shellcheck disable=SC2016 # PHP code, single-quoted on purpose
                php -r '
                    $f = $argv[1]; $d = json_decode(file_get_contents($f), true) ?: [];
                    if ($argv[2] === "config:system:delete") { unset($d[$argv[3]]); } else { $d[$argv[3]] = $argv[4]; }
                    ksort($d); file_put_contents($f, json_encode((object)$d));' \
                    "$WORK/proxies.json" "$action" "$index" "$value" ;;
        esac
    }
    # shellcheck source-path=SCRIPTDIR source=../aws-trusted-proxies.sh
    source "$LIB"
}

teardown() {
    rm -rf "$WORK"
}

# Assert the resulting trusted_proxies JSON.
expect_json() {
    local description="$1" expected="$2" actual
    actual="$(cat "$WORK/proxies.json")"
    if [ "$actual" = "$expected" ]; then
        PASS=$((PASS + 1)); echo "ok - $description"
    else
        FAIL=$((FAIL + 1)); echo "not ok - $description (expected $expected, got $actual)"
    fi
}

setup '{"0":"127.0.0.1","1":"::1","10":"10.0.2.0/16"}'
AWS_TRUSTED_PROXIES="52.195.244.65 52.196.226.157" aws_apply_trusted_proxies >/dev/null
expect_json "adds NAT IPs at 20+ and keeps other entries" \
    '{"0":"127.0.0.1","1":"::1","10":"10.0.2.0\/16","20":"52.195.244.65","21":"52.196.226.157"}'
teardown

setup '{"0":"127.0.0.1","20":"198.51.100.1","21":"198.51.100.2","22":"198.51.100.3"}'
AWS_TRUSTED_PROXIES="203.0.113.10" aws_apply_trusted_proxies >/dev/null
expect_json "replaces stale reserved entries" '{"0":"127.0.0.1","20":"203.0.113.10"}'
teardown

setup '{"0":"127.0.0.1","20":"198.51.100.1"}'
AWS_TRUSTED_PROXIES="" aws_apply_trusted_proxies >/dev/null
expect_json "empty list removes reserved entries only" '{"0":"127.0.0.1"}'
teardown

setup '{"0":"127.0.0.1"}'
output="$(AWS_TRUSTED_PROXIES="bad;value 203.0.113.0/24" aws_apply_trusted_proxies)"
expect_json "skips invalid values, accepts CIDR" '{"0":"127.0.0.1","20":"203.0.113.0\/24"}'
if grep -q "ignoring invalid trusted proxy" <<< "$output"; then PASS=$((PASS + 1)); echo "ok - warns on invalid value"; else FAIL=$((FAIL + 1)); echo "not ok - warns on invalid value"; fi
teardown

setup '{"0":"127.0.0.1"}'
AWS_TRUSTED_PROXIES="$(seq -f '198.51.100.%g' 1 12 | tr '\n' ' ')" aws_apply_trusted_proxies >/dev/null
# shellcheck disable=SC2016 # PHP code, single-quoted on purpose
count="$(php -r '$d=json_decode(file_get_contents($argv[1]),true); echo count(array_filter(array_keys($d), fn($k) => $k >= 20 && $k <= 29));' "$WORK/proxies.json")"
if [ "$count" = 10 ]; then PASS=$((PASS + 1)); echo "ok - caps the list at 10 entries"; else FAIL=$((FAIL + 1)); echo "not ok - caps the list at 10 entries (got $count)"; fi
teardown

setup '{"0":"127.0.0.1","1":"::1"}'
AWS_TRUSTED_PROXIES="52.195.244.65" aws_apply_trusted_proxies >/dev/null
first="$(cat "$WORK/proxies.json")"
AWS_TRUSTED_PROXIES="52.195.244.65" aws_apply_trusted_proxies >/dev/null
expect_json "idempotent" "$first"
teardown

echo "# pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
