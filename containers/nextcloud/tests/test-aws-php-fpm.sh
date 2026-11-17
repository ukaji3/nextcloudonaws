#!/bin/bash
# Tests for containers/nextcloud/php-fpm.d/zzz-custom.conf and the PHP config
# directories of the image (root-owned and read-only for others, upstream AIO
# 0bf4473c).
# Usage: bash containers/nextcloud/tests/test-aws-php-fpm.sh
# The static checks need no dependencies. Inside the built image (run as root,
# with this directory mounted) they also check the effective php-fpm settings,
# the session handler and the permissions:
#   docker run --rm --entrypoint bash -v "$PWD/containers/nextcloud:/src:ro" \
#       <image> /src/tests/test-aws-php-fpm.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$SCRIPT_DIR/../php-fpm.d/zzz-custom.conf"
DOCKERFILE="$SCRIPT_DIR/../Dockerfile"
ENTRYPOINT="$SCRIPT_DIR/../entrypoint.sh"
START="$SCRIPT_DIR/../start.sh"
INSTALLED=/usr/local/etc/php-fpm.d/zzz-custom.conf
PHP_DIRS=(/usr/local/etc/php/conf.d /usr/local/etc/php-fpm.d)
PASS=0
FAIL=0
SKIP=0

# Compare two values. $1 = label, $2 = expected, $3 = actual.
check() {
    if [ "$2" = "$3" ]; then
        PASS=$((PASS + 1))
        echo "ok - $1"
    else
        FAIL=$((FAIL + 1))
        echo "not ok - $1"
        echo "    expected: $2"
        echo "    actual:   $3"
    fi
}

# Record a skipped check. $1 = label, $2 = reason.
skip() {
    SKIP=$((SKIP + 1))
    echo "ok - $1 # SKIP $2"
}

# Number of lines of file $2 that match the extended regex $1.
count() {
    grep -c -E -- "$1" "$2"
}

# Line number of the first line of file $2 that matches the extended regex $1
# (empty when there is none).
line_of() {
    grep -n -m1 -E -- "$1" "$2" | cut -d: -f1
}

echo "# zzz-custom.conf"

# 1: one [www] section with each setting exactly once.
check "[www] セクションが 1 つ" "1" "$(count '^\[www\][[:space:]]*$' "$CONF")"
check "clear_env = no を 1 回だけ設定する" "1" "$(count '^clear_env = no$' "$CONF")"
check "request_slowlog_timeout = 10 を 1 回だけ設定する" "1" "$(count '^request_slowlog_timeout = 10$' "$CONF")"
check "slowlog = /proc/self/fd/2 を 1 回だけ設定する" "1" "$(count '^slowlog = /proc/self/fd/2$' "$CONF")"
check "request_terminate_timeout = 60 を 1 回だけ設定する" "1" "$(count '^request_terminate_timeout = 60$' "$CONF")"
check "設定行は上記 4 つだけ" "4" "$(count '^[a-z_.]+ = ' "$CONF")"

# 2: the Dockerfile installs it into php-fpm.d under the same name.
check "Dockerfile が php-fpm.d/zzz-custom.conf として配置する" "1" \
    "$(count '^COPY containers/nextcloud/php-fpm\.d/zzz-custom\.conf /usr/local/etc/php-fpm\.d/zzz-custom\.conf$' "$DOCKERFILE")"

# 3: php-fpm includes php-fpm.d/*.conf in name order, so "zzz-" is read last.
last="$(printf '%s\n' docker.conf www.conf zz-docker.conf zzz-custom.conf | LC_ALL=C sort | tail -1)"
check "ファイル名順で php-fpm.d の最後に読まれる" "zzz-custom.conf" "$last"

echo "# Dockerfile"

# 4: the Redis session handler written by the upstream block is removed at build time.
written="$(line_of '> /usr/local/etc/php/conf\.d/redis-session\.ini; \\$' "$DOCKERFILE")"
removed="$(line_of '^[[:space:]]+rm /usr/local/etc/php/conf\.d/redis-session\.ini; \\$' "$DOCKERFILE")"
check "redis-session.ini を書く行がある（upstream のまま）" "yes" "$([ -n "$written" ] && echo yes || echo no)"
check "redis-session.ini を書いた後に削除する" "yes" \
    "$([ -n "$written" ] && [ -n "$removed" ] && [ "$removed" -gt "$written" ] && echo yes || echo no)"

# 5: the PHP config directories are root-owned and not world-writable (upstream 0bf4473c).
check "設定ディレクトリを chmod 777 しない" "0" "$(count 'chmod (-R )?777 (-R )?/usr/local/etc/php' "$DOCKERFILE")"
check "設定ディレクトリを root:root にする" "1" \
    "$(count '^[[:space:]]+chown -R root:root /usr/local/etc/php/conf\.d /usr/local/etc/php-fpm\.d && \\$' "$DOCKERFILE")"
check "ディレクトリを 755 にする" "1" \
    "$(count '^[[:space:]]+find /usr/local/etc/php/conf\.d /usr/local/etc/php-fpm\.d -type d -exec chmod 755 \{\} \+ && \\$' "$DOCKERFILE")"
check "ファイルを 644 にする" "1" \
    "$(count '^[[:space:]]+find /usr/local/etc/php/conf\.d /usr/local/etc/php-fpm\.d -type f -exec chmod 644 \{\} \+ && \\$' "$DOCKERFILE")"

echo "# entrypoint.sh"

# 6: entrypoint.sh runs as www-data (start.sh), so it must not write the PHP config directories.
check "前提: start.sh が entrypoint.sh を www-data で実行する" "1" \
    "$(count '^if ! su-exec www-data bash /entrypoint\.sh; then$' "$START")"
check "entrypoint.sh が PHP の設定ディレクトリに触れない" "0" "$(count '/usr/local/etc/php' "$ENTRYPOINT")"

if [ ! -f "$INSTALLED" ] || ! command -v php-fpm >/dev/null 2>&1; then
    skip "イメージ内の実効値と権限を確認" "not running inside the built image"
else
    echo "# image"

    # 7: the installed file is the one in the repository.
    check "イメージ内: 配置されたファイルがリポジトリの内容と同一" "same" \
        "$(cmp -s "$CONF" "$INSTALLED" && echo same || echo different)"

    # 8: php-fpm accepts the configuration, and the [www] pool has the values.
    fpm_dump="$(php-fpm -tt 2>&1)"
    check "イメージ内: php-fpm -t（設定の検証）が成功する" "0" "$(php-fpm -t >/dev/null 2>&1; echo $?)"
    # Prints the value of pool directive $1 in the [www] section of the dump
    # (awk: the image has no perl).
    fpm_value() {
        printf '%s\n' "$fpm_dump" | awk -v key="$1" '
            /NOTICE:[ \t]+\[[^]]+\][ \t]*$/ {
                section = $0; sub(/.*\[/, "", section); sub(/\].*/, "", section); next
            }
            section == "www" {
                line = $0; sub(/.*NOTICE:[ \t]+/, "", line)
                n = index(line, " = ")
                if (n > 0 && substr(line, 1, n - 1) == key) { print substr(line, n + 3); exit }
            }'
    }
    check "イメージ内: clear_env が no" "no" "$(fpm_value clear_env)"
    check "イメージ内: request_slowlog_timeout が 10s" "10s" "$(fpm_value request_slowlog_timeout)"
    check "イメージ内: slowlog が /proc/self/fd/2" "/proc/self/fd/2" "$(fpm_value slowlog)"
    check "イメージ内: request_terminate_timeout が 60s" "60s" "$(fpm_value request_terminate_timeout)"

    # 9: no Redis session handler; PHP uses its default file sessions.
    check "イメージ内: redis-session.ini が無い" "absent" \
        "$([ -e /usr/local/etc/php/conf.d/redis-session.ini ] && echo present || echo absent)"
    check "イメージ内: CLI の session.save_handler が files" "files" "$(php -r 'echo ini_get("session.save_handler");')"
    check "イメージ内: php-fpm の session.save_handler が files" "session.save_handler => files => files" \
        "$(php-fpm -i 2>/dev/null | grep -m1 '^session.save_handler')"

    # 10: ownership and modes of the PHP config directories.
    check "イメージ内: root:root 以外の所有者が無い" "" \
        "$(find "${PHP_DIRS[@]}" \( ! -user root -o ! -group root \) -print)"
    check "イメージ内: group / other が書き込めるものが無い" "" "$(find "${PHP_DIRS[@]}" -perm /022 -print)"

    if [ "$(id -u)" != 0 ] || ! command -v su-exec >/dev/null 2>&1; then
        skip "イメージ内: www-data の書き込み可否" "needs root and su-exec"
    else
        for dir in "${PHP_DIRS[@]}"; do
            probe="$dir/.aws-php-fpm-test-$$"
            # 11: control - root can write there, so check 12 fails for the right reason.
            check "イメージ内: 対照: root は $dir に書き込める" "0" "$(touch "$probe" 2>/dev/null; echo $?)"
            rm -f "$probe"
            # 12: www-data (the user of entrypoint.sh and of the PHP workers) cannot.
            check "イメージ内: www-data は $dir に書き込めない" "denied" \
                "$(su-exec www-data touch "$probe" 2>/dev/null && echo written || echo denied)"
            rm -f "$probe"
        done
        check "イメージ内: www-data は zzz-custom.conf を変更できない" "denied" \
            "$(su-exec www-data sh -c ": >> '$INSTALLED'" 2>/dev/null && echo written || echo denied)"
    fi
fi

echo "# passed: $PASS, failed: $FAIL, skipped: $SKIP"
[ "$FAIL" -eq 0 ]
