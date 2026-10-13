#!/bin/bash
# Tests for containers/nextcloud/aws-legacy-files.sh
# Usage: bash containers/nextcloud/tests/test-aws-legacy-files.sh
# No external dependencies: only a temporary directory tree is used.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/../aws-legacy-files.sh"
PASS=0
FAIL=0
WORK=""

# shellcheck source-path=SCRIPTDIR source=../aws-legacy-files.sh
source "$LIB"

# Fresh sandbox holding a web root.
setup() {
    WORK="$(mktemp -d)"
    mkdir -p "$WORK/html"
}

teardown() {
    rm -rf "$WORK"
}

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

echo "# aws_remove_legacy_webroot_files"

# 1: diag.php is removed.
setup
: > "$WORK/html/diag.php"
aws_remove_legacy_webroot_files "$WORK/html" > /dev/null
check "diag.php を削除する" "absent" "$([ -e "$WORK/html/diag.php" ] && echo present || echo absent)"
teardown

# 2: the removal is reported.
setup
: > "$WORK/html/diag.php"
out="$(aws_remove_legacy_webroot_files "$WORK/html")"
check "削除をログに出す" "yes" "$(echo "$out" | grep -q "diag.php" && echo yes || echo no)"
teardown

# 3: Nextcloud's own files are kept.
setup
for f in index.php status.php remote.php cron.php public.php version.php console.php; do : > "$WORK/html/$f"; done
aws_remove_legacy_webroot_files "$WORK/html" > /dev/null
check "Nextcloud 本体のファイルは残す" "7" "$(find "$WORK/html" -maxdepth 1 -name '*.php' | wc -l)"
teardown

# 4: nothing to remove is not an error and prints nothing.
setup
out="$(aws_remove_legacy_webroot_files "$WORK/html")"
check "対象が無ければ終了コード 0" "0" "$?"
check "対象が無ければ何も出力しない" "" "$out"
teardown

# 5: a missing web root is not an error (first start, EFS not mounted yet).
setup
aws_remove_legacy_webroot_files "$WORK/does-not-exist" > /dev/null
check "Web ルートが無くても終了コード 0" "0" "$?"
teardown

# 6: a directory of the same name is not touched.
setup
mkdir -p "$WORK/html/diag.php"
aws_remove_legacy_webroot_files "$WORK/html" > /dev/null
check "同名のディレクトリは削除しない" "present" "$([ -d "$WORK/html/diag.php" ] && echo present || echo absent)"
teardown

# 7: a symlink of the same name is not followed or removed.
setup
: > "$WORK/target.php"
ln -s "$WORK/target.php" "$WORK/html/diag.php"
aws_remove_legacy_webroot_files "$WORK/html" > /dev/null
check "同名のシンボリックリンクは削除しない" "present" "$([ -L "$WORK/html/diag.php" ] && echo present || echo absent)"
check "リンク先も削除しない" "present" "$([ -f "$WORK/target.php" ] && echo present || echo absent)"
teardown

# 8: the default web root is used when no argument is given.
setup
aws_remove_legacy_webroot_files > /dev/null
check "引数なしでも終了コード 0（既定の Web ルート）" "0" "$?"
teardown

# 9: running twice is harmless.
setup
: > "$WORK/html/diag.php"
aws_remove_legacy_webroot_files "$WORK/html" > /dev/null
out="$(aws_remove_legacy_webroot_files "$WORK/html")"
check "2 回目は何もしない" "" "$out"
teardown

echo "# passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
