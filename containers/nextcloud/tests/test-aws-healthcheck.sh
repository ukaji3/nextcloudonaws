#!/bin/bash
# Tests for containers/nextcloud/aws-healthcheck.sh
# Usage: bash containers/nextcloud/tests/test-aws-healthcheck.sh
# nc and pgrep are replaced by stubs on PATH; the upstream check by a stub script.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HC="$SCRIPT_DIR/../aws-healthcheck.sh"
PASS=0
FAIL=0

# Run the health check in a sandbox and print its exit code.
# Arguments: fpm(up|down) maintenance(on|off|missing) process(none|upgrade|install|rsync) upstream_exit
run_hc() {
    local fpm="$1" maintenance="$2" process="$3" upstream_exit="$4" work
    work="$(mktemp -d)"
    mkdir -p "$work/bin"
    # nc stub: succeeds only when php-fpm is "up"
    printf '#!/bin/bash\n[ "%s" = up ]\n' "$fpm" > "$work/bin/nc"
    # pgrep stub: matches the simulated running process
    cat > "$work/bin/pgrep" <<EOF
#!/bin/bash
case "$process" in
  upgrade) [[ "\$*" == *occ* ]] ;;
  install) [[ "\$*" == *occ* ]] ;;
  rsync)   [[ "\$*" == *rsync* ]] ;;
  *)       exit 1 ;;
esac
EOF
    printf '#!/bin/bash\nexit %s\n' "$upstream_exit" > "$work/upstream.sh"
    chmod +x "$work/bin/nc" "$work/bin/pgrep" "$work/upstream.sh"
    case "$maintenance" in
        on)  printf "<?php\n\$CONFIG = array (\n  'maintenance' => true,\n);\n" > "$work/config.php" ;;
        off) printf "<?php\n\$CONFIG = array (\n  'maintenance' => false,\n);\n" > "$work/config.php" ;;
    esac
    PATH="$work/bin:$PATH" AWS_HC_CONFIG="$work/config.php" AWS_HC_UPSTREAM="$work/upstream.sh" bash "$HC"
    echo $?
    rm -rf "$work"
}

# Assert the exit code of one scenario.
check() {
    local description="$1" expected="$2" actual
    shift 2
    actual="$(run_hc "$@")"
    if [ "$actual" = "$expected" ]; then
        PASS=$((PASS + 1)); echo "ok - $description"
    else
        FAIL=$((FAIL + 1)); echo "not ok - $description (expected $expected, got $actual)"
    fi
}

check "php-fpm listening -> healthy"                          0 up   off     none    1
check "starting, php-fpm not yet listening -> unhealthy"      1 down off     none    1
check "maintenance on (occ upgrade running) -> healthy"       0 down on      none    1
check "occ upgrade running -> healthy"                        0 down off     upgrade 1
check "occ maintenance:install running -> healthy"            0 down off     install 1
check "rsync of a new version running -> healthy"             0 down off     rsync   1
check "config.php not created yet, fpm down -> upstream says" 1 down missing none    1
check "database unreachable (upstream exits 0) -> healthy"    0 down off     none    0
check "maintenance explicitly false is not maintenance"       1 down off     none    1

echo "# pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
