#!/bin/bash
# Tests for containers/nextcloud/aws-custom-apps-repair.sh
# Usage: bash containers/nextcloud/tests/test-aws-custom-apps-repair.sh
# Dependency-free: needs only bash and coreutils. Exits non-zero on failure.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/../aws-custom-apps-repair.sh"

PASS=0
FAIL=0
WORK=""

# Record a passing or failing assertion.
assert() {
    local description="$1"
    shift
    if "$@"; then
        PASS=$((PASS + 1))
        echo "ok - $description"
    else
        FAIL=$((FAIL + 1))
        echo "not ok - $description"
    fi
}

# Create a fresh sandbox and (re)load the library with a stubbed occ.
setup() {
    WORK="$(mktemp -d)"
    export AWS_CUSTOM_APPS_DIR="$WORK/custom_apps"
    export AWS_RM_RETRIES=2
    mkdir -p "$AWS_CUSTOM_APPS_DIR" "$WORK/state"
    : > "$WORK/state/occ.log"
    # Stub: records calls; "config:app:get <app> enabled" reads state/<app>.enabled
    aws_occ() {
        echo "$*" >> "$WORK/state/occ.log"
        if [ "$1" = "config:app:get" ] && [ "$3" = "enabled" ]; then
            cat "$WORK/state/$2.enabled" 2>/dev/null || echo "yes"
        fi
        return 0
    }
    # shellcheck source-path=SCRIPTDIR source=../aws-custom-apps-repair.sh
    source "$LIB"
}

teardown() {
    chmod -R u+w "$WORK" 2>/dev/null
    rm -rf "$WORK"
}

# Create a healthy app: custom_apps/<id>/appinfo/info.xml
make_healthy_app() {
    mkdir -p "$AWS_CUSTOM_APPS_DIR/$1/appinfo" "$AWS_CUSTOM_APPS_DIR/$1/l10n"
    echo "<info><id>$1</id></info>" > "$AWS_CUSTOM_APPS_DIR/$1/appinfo/info.xml"
    echo "x" > "$AWS_CUSTOM_APPS_DIR/$1/l10n/de.js"
}

# Create the broken layout Nextcloud's updater leaves behind on EFS.
make_nested_app() {
    mkdir -p "$AWS_CUSTOM_APPS_DIR/$1/$1/appinfo" "$AWS_CUSTOM_APPS_DIR/$1/l10n"
    echo "<info><id>$1</id><version>9.9.9</version></info>" > "$AWS_CUSTOM_APPS_DIR/$1/$1/appinfo/info.xml"
    echo "leftover" > "$AWS_CUSTOM_APPS_DIR/$1/l10n/ca.js"
}

tree_hash() {
    (cd "$AWS_CUSTOM_APPS_DIR" && find . -print | sort | sha256sum)
}

test_healthy_app_untouched() {
    setup
    make_healthy_app files_fulltextsearch
    local before
    before="$(tree_hash)"
    aws_repair_nested_custom_apps >/dev/null
    assert "healthy app: tree unchanged" [ "$before" = "$(tree_hash)" ]
    assert "healthy app: repaired count is 0" [ "$AWS_REPAIRED_APPS_COUNT" -eq 0 ]
    teardown
}

test_nested_app_repaired() {
    setup
    make_nested_app fulltextsearch
    aws_repair_nested_custom_apps >/dev/null
    assert "nested app: info.xml at top level" [ -f "$AWS_CUSTOM_APPS_DIR/fulltextsearch/appinfo/info.xml" ]
    assert "nested app: nested copy gone" [ ! -e "$AWS_CUSTOM_APPS_DIR/fulltextsearch/fulltextsearch" ]
    assert "nested app: leftover file removed" [ ! -e "$AWS_CUSTOM_APPS_DIR/fulltextsearch/l10n/ca.js" ]
    assert "nested app: new version content kept" grep -q '9.9.9' "$AWS_CUSTOM_APPS_DIR/fulltextsearch/appinfo/info.xml"
    assert "nested app: repaired count is 1" [ "$AWS_REPAIRED_APPS_COUNT" -eq 1 ]
    assert "nested app: no repair leftovers" [ -z "$(find "$AWS_CUSTOM_APPS_DIR" -maxdepth 1 -name '.repair-*')" ]
    teardown
}

test_disabled_app_reenabled() {
    setup
    make_nested_app notes
    echo "no" > "$WORK/state/notes.enabled"
    aws_repair_nested_custom_apps >/dev/null
    assert "disabled app: app:enable called" grep -qx 'app:enable notes' "$WORK/state/occ.log"
    teardown
}

test_enabled_app_not_reenabled() {
    setup
    make_nested_app fulltextsearch
    echo "yes" > "$WORK/state/fulltextsearch.enabled"
    aws_repair_nested_custom_apps >/dev/null
    assert "enabled app: app:enable not called" bash -c "! grep -q '^app:enable' '$WORK/state/occ.log'"
    teardown
}

test_unknown_layout_skipped() {
    setup
    mkdir -p "$AWS_CUSTOM_APPS_DIR/strange/lib"
    local before output
    before="$(tree_hash)"
    output="$(aws_repair_nested_custom_apps)"
    assert "unknown layout: tree unchanged" [ "$before" = "$(tree_hash)" ]
    assert "unknown layout: warning printed" grep -q "manual check recommended" <<< "$output"
    teardown
}

test_leftovers_cleaned() {
    setup
    mkdir -p "$AWS_CUSTOM_APPS_DIR/.repair-trash-old-1-1/l10n" "$AWS_CUSTOM_APPS_DIR/.repair-staged-x"
    make_healthy_app spreed
    aws_repair_nested_custom_apps >/dev/null
    assert "leftovers: .repair-* removed" [ -z "$(find "$AWS_CUSTOM_APPS_DIR" -maxdepth 1 -name '.repair-*')" ]
    assert "leftovers: dot dirs not treated as apps" [ "$AWS_REPAIRED_APPS_COUNT" -eq 0 ]
    teardown
}

test_idempotent() {
    setup
    make_nested_app fulltextsearch
    make_healthy_app spreed
    aws_repair_nested_custom_apps >/dev/null
    local after_first
    after_first="$(tree_hash)"
    aws_repair_nested_custom_apps >/dev/null
    assert "idempotent: second run changes nothing" [ "$after_first" = "$(tree_hash)" ]
    assert "idempotent: second run repaired count is 0" [ "$AWS_REPAIRED_APPS_COUNT" -eq 0 ]
    teardown
}

test_undeletable_leftover_does_not_lose_app() {
    if [ "$(id -u)" -eq 0 ]; then
        echo "ok - undeletable leftover # SKIP permission test cannot run as root"
        return
    fi
    setup
    make_nested_app fulltextsearch
    chmod 555 "$AWS_CUSTOM_APPS_DIR/fulltextsearch/l10n"
    # Run in the current shell (not $(...)) so AWS_REPAIRED_APPS_COUNT is visible.
    aws_repair_nested_custom_apps > "$WORK/state/output.log"
    assert "undeletable leftover: app still in place" [ -f "$AWS_CUSTOM_APPS_DIR/fulltextsearch/appinfo/info.xml" ]
    assert "undeletable leftover: warning printed" grep -q "WARNING: could not remove" "$WORK/state/output.log"
    assert "undeletable leftover: repair counted" [ "$AWS_REPAIRED_APPS_COUNT" -eq 1 ]
    chmod -R u+w "$AWS_CUSTOM_APPS_DIR"
    aws_repair_nested_custom_apps >/dev/null
    assert "undeletable leftover: cleaned on next run" [ -z "$(find "$AWS_CUSTOM_APPS_DIR" -maxdepth 1 -name '.repair-*')" ]
    teardown
}

test_healthy_app_untouched
test_nested_app_repaired
test_disabled_app_reenabled
test_enabled_app_not_reenabled
test_unknown_layout_skipped
test_leftovers_cleaned
test_idempotent
test_undeletable_leftover_does_not_lose_app

echo "# pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
