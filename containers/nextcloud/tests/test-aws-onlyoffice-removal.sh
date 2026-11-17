#!/bin/bash
# Tests for containers/nextcloud/aws-onlyoffice-removal.sh
# Usage: bash containers/nextcloud/tests/test-aws-onlyoffice-removal.sh (php required)
# occ is replaced by a stub that keeps the app config and the system config in
# JSON files and the app in a temporary custom_apps directory.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/../aws-onlyoffice-removal.sh"
REPAIR_LIB="$SCRIPT_DIR/../aws-custom-apps-repair.sh"
PASS=0
FAIL=0
SKIP=0
WORK=""
SECRET_VALUE="jwt-secret-value-must-not-be-printed"

if ! command -v php >/dev/null 2>&1; then
    echo "ok - all # SKIP php is not installed"
    exit 0
fi

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

# Fresh sandbox with an installed onlyoffice app (like production on 2026-11-17)
# and the stubbed occ. $1 = behaviour of "app:remove": ok | fail | leftover.
setup() {
    WORK="$(mktemp -d)"
    REMOVE_MODE="${1:-ok}"
    export AWS_ONLYOFFICE_APP_DIR="$WORK/custom_apps/onlyoffice"
    export AWS_RM_RETRIES=2
    mkdir -p "$AWS_ONLYOFFICE_APP_DIR/appinfo" "$AWS_ONLYOFFICE_APP_DIR/l10n" "$WORK/custom_apps/deck/appinfo"
    echo '<info><id>onlyoffice</id></info>' > "$AWS_ONLYOFFICE_APP_DIR/appinfo/info.xml"
    echo 'x' > "$AWS_ONLYOFFICE_APP_DIR/l10n/ja.js"
    printf '{"onlyoffice":{"enabled":"yes","installed_version":"10.2.1","jwt_secret":"%s","DocumentServerUrl":"https://cloud.example.com/onlyoffice"},"deck":{"enabled":"yes"}}' \
        "$SECRET_VALUE" > "$WORK/appconfig.json"
    printf '{"onlyoffice":{"editors_check_interval":0,"jwt_secret":"%s","jwt_header":"AuthorizationJwt"},"trusted_domains":["cloud.example.com"]}' \
        "$SECRET_VALUE" > "$WORK/system.json"
    : > "$WORK/occ.log"
    unset ONLYOFFICE_ENABLED
    # Stub occ. Every call is logged; list commands print a log line before the
    # JSON (as occ may do), the other commands edit the JSON files.
    aws_occ() {
        echo "$*" >> "$WORK/occ.log"
        case "$1" in
            config:list)
                echo '[Nextcloud][admin_audit][1] {"message":"Console command executed"}'
                if [ "$2" = system ]; then
                    # shellcheck disable=SC2016 # PHP code, single-quoted on purpose
                    php -r 'echo json_encode(["system" => json_decode(file_get_contents($argv[1]), true)]), PHP_EOL;' "$WORK/system.json"
                else
                    # shellcheck disable=SC2016
                    php -r '$d = json_decode(file_get_contents($argv[1]), true);
                        echo json_encode(["apps" => [$argv[2] => $d[$argv[2]] ?? []]]), PHP_EOL;' "$WORK/appconfig.json" "$2"
                fi ;;
            config:app:delete)
                # shellcheck disable=SC2016
                php -r '$f = $argv[1]; $d = json_decode(file_get_contents($f), true);
                    unset($d[$argv[2]][$argv[3]]); if (($d[$argv[2]] ?? null) === []) { unset($d[$argv[2]]); }
                    file_put_contents($f, json_encode($d));' "$WORK/appconfig.json" "$2" "$3" ;;
            config:system:delete)
                # shellcheck disable=SC2016
                php -r '$f = $argv[1]; $d = json_decode(file_get_contents($f), true);
                    unset($d[$argv[2]]); file_put_contents($f, json_encode($d));' "$WORK/system.json" "$2" ;;
            app:remove)
                case "$REMOVE_MODE" in
                    fail) echo "App 'onlyoffice' is not installed. Nothing to remove."; return 1 ;;
                    leftover) rm -rf "$AWS_ONLYOFFICE_APP_DIR/appinfo"; echo "Removed app 'onlyoffice' (version 10.2.1)." ;;
                    *) rm -rf "$AWS_ONLYOFFICE_APP_DIR"; echo "Removed app 'onlyoffice' (version 10.2.1)." ;;
                esac ;;
            app:disable) echo "onlyoffice disabled" ;;
        esac
        return 0
    }
    # shellcheck source-path=SCRIPTDIR source=../aws-custom-apps-repair.sh
    source "$REPAIR_LIB"
    # shellcheck source-path=SCRIPTDIR source=../aws-onlyoffice-removal.sh
    source "$LIB"
}

teardown() {
    chmod -R u+w "$WORK" 2>/dev/null
    rm -rf "$WORK"
}

# Prints "present" or "absent" for path $1.
presence() {
    [ -e "$1" ] && echo present || echo absent
}

# Prints the keys of the app config of app $1 (comma separated, sorted).
app_keys() {
    # shellcheck disable=SC2016
    php -r '$d = json_decode(file_get_contents($argv[1]), true); $k = array_keys($d[$argv[2]] ?? []); sort($k); echo implode(",", $k);' \
        "$WORK/appconfig.json" "$1"
}

# Prints the top-level keys of the system config (comma separated, sorted).
system_keys() {
    # shellcheck disable=SC2016
    php -r '$k = array_keys(json_decode(file_get_contents($argv[1]), true)); sort($k); echo implode(",", $k);' "$WORK/system.json"
}

# Number of occ calls that change state (everything except config:list).
mutating_calls() {
    grep -c -v '^config:list ' "$WORK/occ.log"
}

echo "# aws_remove_onlyoffice"

# 1: OnlyOffice enabled - nothing is touched, occ is not called.
setup
export ONLYOFFICE_ENABLED=yes
out="$(aws_remove_onlyoffice)"
check "ONLYOFFICE_ENABLED=yes: アプリを残す" "present" "$(presence "$AWS_ONLYOFFICE_APP_DIR")"
check "ONLYOFFICE_ENABLED=yes: occ を呼ばない" "0" "$(wc -l < "$WORK/occ.log")"
check "ONLYOFFICE_ENABLED=yes: 何も出力しない" "" "$out"
teardown

# 2: disabled (production after the CDK change) - app, app config and system config are removed.
setup
export ONLYOFFICE_ENABLED=no
out="$(aws_remove_onlyoffice)"; rc=$?
check "終了コード 0" "0" "$rc"
check "custom_apps/onlyoffice を削除する" "absent" "$(presence "$AWS_ONLYOFFICE_APP_DIR")"
check "occ app:remove onlyoffice を 1 回呼ぶ" "1" "$(grep -c '^app:remove onlyoffice$' "$WORK/occ.log")"
check "onlyoffice の app config を全て削除する" "" "$(app_keys onlyoffice)"
check "他のアプリの app config は残す" "enabled" "$(app_keys deck)"
check "config.php の onlyoffice を削除し、他のキーは残す" "trusted_domains" "$(system_keys)"
check "他のアプリのディレクトリは残す" "present" "$(presence "$WORK/custom_apps/deck/appinfo")"
check "削除したことをログに出す" "yes" "$(grep -q 'Removing the onlyoffice app' <<< "$out" && echo yes || echo no)"
check "シークレットの値をログに出さない" "no" "$(grep -qF "$SECRET_VALUE" <<< "$out" && echo yes || echo no)"
# 3: a second call (next container start) is a no-op.
: > "$WORK/occ.log"
out="$(aws_remove_onlyoffice)"
check "2 回目: 何も出力しない" "" "$out"
check "2 回目: 状態を変える occ を呼ばない" "0" "$(mutating_calls)"
teardown

# 4: ONLYOFFICE_ENABLED unset counts as disabled.
setup
aws_remove_onlyoffice > /dev/null
check "ONLYOFFICE_ENABLED 未設定でも削除する" "absent" "$(presence "$AWS_ONLYOFFICE_APP_DIR")"
teardown

# 5: fresh instance without the app - nothing to do, no output.
setup
rm -rf "$AWS_ONLYOFFICE_APP_DIR"
printf '{"deck":{"enabled":"yes"}}' > "$WORK/appconfig.json"
printf '{"trusted_domains":["cloud.example.com"]}' > "$WORK/system.json"
out="$(aws_remove_onlyoffice)"
check "アプリが無い: 何も出力しない" "" "$out"
check "アプリが無い: 状態を変える occ を呼ばない" "0" "$(mutating_calls)"
teardown

# 6: occ app:remove fails - the app is disabled and the directory removed directly.
setup fail
out="$(aws_remove_onlyoffice)"
check "app:remove 失敗: 警告を出す" "yes" "$(grep -q 'WARNING: occ app:remove onlyoffice failed' <<< "$out" && echo yes || echo no)"
check "app:remove 失敗: app:disable を呼ぶ" "1" "$(grep -c '^app:disable onlyoffice$' "$WORK/occ.log")"
check "app:remove 失敗: ディレクトリを直接削除する" "absent" "$(presence "$AWS_ONLYOFFICE_APP_DIR")"
check "app:remove 失敗: app config も削除する" "" "$(app_keys onlyoffice)"
teardown

# 7: files left behind by app:remove (EFS) are removed.
setup leftover
aws_remove_onlyoffice > /dev/null
check "app:remove の残骸も削除する" "absent" "$(presence "$AWS_ONLYOFFICE_APP_DIR")"
teardown

# 8: an undeletable directory is reported and retried on the next start; the call still succeeds.
if [ "$(id -u)" = 0 ]; then
    skip "削除できないディレクトリ" "permission test cannot run as root"
else
    setup fail
    chmod 555 "$WORK/custom_apps"
    out="$(aws_remove_onlyoffice)"; rc=$?
    chmod 755 "$WORK/custom_apps"
    check "削除できない: 終了コード 0" "0" "$rc"
    check "削除できない: 次回の起動で再試行すると警告する" "yes" "$(grep -q 'will be retried on next start' <<< "$out" && echo yes || echo no)"
    check "削除できない: ディレクトリは残る" "present" "$(presence "$AWS_ONLYOFFICE_APP_DIR")"
    teardown
fi

echo "# passed: $PASS, failed: $FAIL, skipped: $SKIP"
[ "$FAIL" -eq 0 ]
