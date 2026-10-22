#!/bin/bash
# Tests for containers/nextcloud/php/zz-aws-hardening.ini
# Usage: bash containers/nextcloud/tests/test-aws-php-ini.sh
# The static checks need no dependencies. The php checks are skipped when php is
# not installed; inside the built image they also check the effective values of
# the CLI and of php-fpm.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INI="$SCRIPT_DIR/../php/zz-aws-hardening.ini"
DOCKERFILE="$SCRIPT_DIR/../Dockerfile"
INSTALLED=/usr/local/etc/php/conf.d/zz-aws-hardening.ini
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

echo "# zz-aws-hardening.ini"

# 1: the file disables session upload progress, and only once.
check "session.upload_progress.enabled = 0 を 1 回だけ設定する" "1" \
    "$(grep -c -E '^[[:space:]]*session\.upload_progress\.enabled[[:space:]]*=[[:space:]]*0[[:space:]]*$' "$INI")"
check "upload_progress.enabled を有効にする行が無い" "0" \
    "$(grep -c -E '^[[:space:]]*session\.upload_progress\.enabled[[:space:]]*=[[:space:]]*(1|[Oo]n|[Tt]rue|[Yy]es)' "$INI")"

# 2: the Dockerfile installs it into conf.d under the same name.
check "Dockerfile が conf.d/zz-aws-hardening.ini として配置する" "1" \
    "$(grep -c -E '^COPY containers/nextcloud/php/zz-aws-hardening\.ini /usr/local/etc/php/conf\.d/zz-aws-hardening\.ini$' "$DOCKERFILE")"

# 3: "zz-" sorts after every file the image writes to conf.d (PHP reads them in order).
last="$(printf '%s\n' docker-fpm.ini docker-php-ext-zip.ini nextcloud.ini opcache-recommended.ini redis-session.ini zz-aws-hardening.ini | LC_ALL=C sort | tail -1)"
check "ファイル名順で conf.d の最後に読まれる" "zz-aws-hardening.ini" "$last"

if ! command -v php >/dev/null 2>&1; then
    skip "php で実効値を確認" "php is not installed"
else
    # Run php with no php.ini and only the ini files of directory $1 (isolated
    # from the image's own conf.d). Prints the effective upload progress flag.
    php_with_dir() {
        PHP_INI_SCAN_DIR="$1" php -c "$1" -r 'echo ini_get("session.upload_progress.enabled");'
    }
    EMPTY_DIR="$(mktemp -d)"
    ONLY_DIR="$(mktemp -d)"
    cp "$INI" "$ONLY_DIR/"
    # 4: control - with no ini file at all PHP's default is enabled, so check 5 can fail.
    check "対照: ini なしの既定値は 1（有効）" "1" "$(php_with_dir "$EMPTY_DIR")"
    # 5: loading only this file disables it.
    check "このファイルだけを読むと 0（無効）" "0" "$(php_with_dir "$ONLY_DIR")"
    rm -rf "$EMPTY_DIR" "$ONLY_DIR"

    if [ -f "$INSTALLED" ]; then
        # 6/7: inside the built image, the effective values of both SAPIs.
        check "イメージ内: CLI の実効値が 0" "0" "$(php -r 'echo ini_get("session.upload_progress.enabled");')"
        check "イメージ内: php-fpm の実効値が Off" "session.upload_progress.enabled => Off => Off" \
            "$(php-fpm -i 2>/dev/null | grep -m1 '^session.upload_progress.enabled')"
        check "イメージ内: 配置されたファイルがリポジトリの内容と同一" "same" \
            "$(cmp -s "$INI" "$INSTALLED" && echo same || echo different)"
    else
        skip "イメージ内の実効値を確認" "not running inside the built image"
    fi
fi

echo "# passed: $PASS, failed: $FAIL, skipped: $SKIP"
[ "$FAIL" -eq 0 ]
