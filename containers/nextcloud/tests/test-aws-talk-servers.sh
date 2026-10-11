#!/bin/bash
# Tests for containers/nextcloud/aws-talk-servers.sh
# Usage: bash containers/nextcloud/tests/test-aws-talk-servers.sh (php required)
# occ is replaced by a stub that keeps the TURN and STUN lists in JSON files.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/../aws-talk-servers.sh"
PASS=0
FAIL=0
WORK=""
OLD="cloud.example.com:3478"
NEW="turn.cloud.example.com:3478"

if ! command -v php >/dev/null 2>&1; then
    echo "ok - all # SKIP php is not installed"
    exit 0
fi

# Fresh sandbox. $1 = TURN list JSON, $2 = STUN list JSON.
setup() {
    WORK="$(mktemp -d)"
    printf '%s' "$1" > "$WORK/turn.json"
    printf '%s' "$2" > "$WORK/stun.json"
    : > "$WORK/occ.log"
    # Stub occ: list prints a log line plus JSON (like the real command); delete edits the JSON.
    aws_occ() {
        echo "$*" >> "$WORK/occ.log"
        case "$1" in
            talk:turn:list) echo '[Nextcloud][admin_audit][1] {"message":"Console command executed"}'; cat "$WORK/turn.json"; echo ;;
            talk:stun:list) cat "$WORK/stun.json"; echo ;;
            talk:turn:delete)
                # shellcheck disable=SC2016 # PHP code, single-quoted on purpose
                php -r '$f=$argv[1]; $d=json_decode(file_get_contents($f),true);
                    $d=array_values(array_filter($d, fn($s) => !($s["schemes"]===$argv[2] && $s["server"]===$argv[3] && $s["protocols"]===$argv[4])));
                    file_put_contents($f, json_encode($d));' "$WORK/turn.json" "$2" "$3" "$4" ;;
            talk:stun:delete)
                # shellcheck disable=SC2016 # PHP code, single-quoted on purpose
                php -r '$f=$argv[1]; $d=json_decode(file_get_contents($f),true);
                    file_put_contents($f, json_encode(array_values(array_diff($d, [$argv[2]]))));' "$WORK/stun.json" "$2" ;;
        esac
    }
    # shellcheck source-path=SCRIPTDIR source=../aws-talk-servers.sh
    source "$LIB"
}

teardown() {
    rm -rf "$WORK"
}

# Assert file content equals the expected JSON.
expect_file() {
    local description="$1" file="$2" expected="$3" actual
    actual="$(cat "$WORK/$file")"
    if [ "$actual" = "$expected" ]; then
        PASS=$((PASS + 1)); echo "ok - $description"
    else
        FAIL=$((FAIL + 1)); echo "not ok - $description (expected $expected, got $actual)"
    fi
}

turn() {
    printf '{"schemes":"turn","server":"%s","secret":"s","protocols":"udp,tcp"}' "$1"
}

setup "[$(turn "$OLD"),$(turn "$NEW")]" "[\"$OLD\",\"$NEW\"]"
aws_remove_stale_talk_server "$OLD" "$NEW" >/dev/null
expect_file "removes the stale TURN entry when the new one exists" turn.json "[$(turn "$NEW")]"
expect_file "removes the stale STUN entry when the new one exists" stun.json "[\"$NEW\"]"
teardown

setup "[$(turn "$OLD")]" "[\"$OLD\"]"
output="$(aws_remove_stale_talk_server "$OLD" "$NEW")"
expect_file "keeps the stale TURN entry when the new one is missing" turn.json "[$(turn "$OLD")]"
expect_file "keeps the stale STUN entry when the new one is missing" stun.json "[\"$OLD\"]"
if grep -q "WARNING: TURN server" <<< "$output"; then PASS=$((PASS + 1)); echo "ok - warns when the new TURN entry is missing"; else FAIL=$((FAIL + 1)); echo "not ok - warns when the new TURN entry is missing"; fi
teardown

setup "[$(turn "$NEW"),$(turn "admin.example.net:3478")]" "[\"$NEW\",\"stun.example.net:3478\"]"
aws_remove_stale_talk_server "$OLD" "$NEW" >/dev/null
expect_file "leaves administrator-added TURN servers alone" turn.json "[$(turn "$NEW"),$(turn "admin.example.net:3478")]"
expect_file "leaves administrator-added STUN servers alone" stun.json "[\"$NEW\",\"stun.example.net:3478\"]"
teardown

setup "[$(turn "$NEW")]" "[\"$NEW\"]"
aws_remove_stale_talk_server "$NEW" "$NEW" >/dev/null
expect_file "no-op when stale equals current" turn.json "[$(turn "$NEW")]"
if ! grep -q 'delete' "$WORK/occ.log"; then PASS=$((PASS + 1)); echo "ok - no delete call when stale equals current"; else FAIL=$((FAIL + 1)); echo "not ok - no delete call when stale equals current"; fi
teardown

setup "[$(turn "$OLD"),$(turn "$NEW")]" "[\"$OLD\",\"$NEW\"]"
aws_remove_stale_talk_server "$OLD" "$NEW" >/dev/null
aws_remove_stale_talk_server "$OLD" "$NEW" >/dev/null
expect_file "idempotent (TURN)" turn.json "[$(turn "$NEW")]"
expect_file "idempotent (STUN)" stun.json "[\"$NEW\"]"
teardown

echo "# pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
