#!/bin/bash
# shellcheck shell=bash
#
# nextcloudonaws: repair helpers for custom_apps on Amazon EFS (NFSv4.1).
#
# Background (verified on the production EFS mount, 2026-10-11):
#   Nextcloud's app updater (lib/private/Installer.php) removes the old app
#   directory with \OCP\Files::rmdirr(), which unlinks entries while iterating
#   the directory. On EFS this regularly leaves a single file behind (e.g.
#   l10n/ca.js), so the final rmdir() fails. The updater ignores that result,
#   its "@mkdir($baseDir)" then fails, and copyRecursive() copies the *outer*
#   extraction folder instead, producing:
#       custom_apps/<app>/<app>/appinfo/info.xml   (nested, broken)
#   instead of
#       custom_apps/<app>/appinfo/info.xml         (expected)
#   occ then reports "Could not find <app>" and the app silently stops working.
#
# This file is a library: it is sourced by entrypoint.sh and by the shell
# tests in containers/nextcloud/tests/. It only defines functions.
#
# Overridable for tests:
#   AWS_CUSTOM_APPS_DIR   custom_apps root (default: /var/www/html/custom_apps)
#   AWS_RM_RETRIES        attempts for recursive removal (default: 5)
#   aws_occ()             function wrapping "php /var/www/html/occ"

AWS_CUSTOM_APPS_DIR="${AWS_CUSTOM_APPS_DIR:-/var/www/html/custom_apps}"
AWS_RM_RETRIES="${AWS_RM_RETRIES:-5}"
# Number of apps repaired by the last aws_repair_nested_custom_apps call.
AWS_REPAIRED_APPS_COUNT=0

if ! declare -F aws_occ >/dev/null; then
    # Run occ. Defined only if the caller has not provided its own wrapper.
    aws_occ() {
        php /var/www/html/occ "$@"
    }
fi

# Remove a directory tree, retrying because a single pass may skip entries on NFS.
# Arguments: $1 = directory. Returns 0 when the path no longer exists.
aws_remove_dir_with_retry() {
    local target="$1" attempt
    for attempt in $(seq 1 "$AWS_RM_RETRIES"); do
        [ -e "$target" ] || return 0
        rm -rf "$target" 2>/dev/null
        [ -e "$target" ] || return 0
        echo "Retrying removal of '$target' (attempt $attempt/$AWS_RM_RETRIES)..."
        sleep 1
    done
    [ ! -e "$target" ]
}

# Delete leftovers of earlier (possibly interrupted) repairs.
aws_cleanup_repair_leftovers() {
    local leftover
    for leftover in "$AWS_CUSTOM_APPS_DIR"/.repair-*; do
        [ -e "$leftover" ] || continue
        if ! aws_remove_dir_with_retry "$leftover"; then
            echo "WARNING: could not remove repair leftover '$leftover'; it is ignored by Nextcloud (dot-prefixed)."
        fi
    done
}

# Re-enable an app that Nextcloud auto-disabled while its directory was broken.
# Arguments: $1 = app id.
aws_reenable_app_if_disabled() {
    local app_id="$1"
    if [ "$(aws_occ config:app:get "$app_id" enabled)" = 'no' ]; then
        if ! aws_occ app:enable "$app_id"; then
            echo "Could not re-enable '$app_id' after repairing its directory."
        fi
    fi
}

# Move the nested app one level up, discarding the broken outer directory.
# The outer directory is renamed (atomic) before deletion, so a deletion
# failure never leaves the app missing.
# Arguments: $1 = app id. Returns 0 on success.
aws_repair_nested_app() {
    local app_id="$1"
    local app_dir="$AWS_CUSTOM_APPS_DIR/$app_id"
    local staged="$AWS_CUSTOM_APPS_DIR/.repair-staged-$app_id"
    local trash
    trash="$AWS_CUSTOM_APPS_DIR/.repair-trash-$app_id-$(date +%s)-$$"

    echo "Repairing nested app directory layout for '$app_id'..."
    if ! aws_remove_dir_with_retry "$staged"; then
        echo "Failed to repair '$app_id': stale staging directory '$staged' cannot be removed."
        return 1
    fi
    if ! mv "$app_dir/$app_id" "$staged"; then
        echo "Failed to repair '$app_id': could not stage the nested app."
        return 1
    fi
    if ! mv "$app_dir" "$trash"; then
        # Put things back the way they were; nothing is lost.
        mv "$staged" "$app_dir/$app_id"
        echo "Failed to repair '$app_id': could not move the broken directory aside."
        return 1
    fi
    if ! mv "$staged" "$app_dir"; then
        mv "$trash" "$app_dir"
        mv "$staged" "$app_dir/$app_id"
        echo "Failed to repair '$app_id': could not move the app into place."
        return 1
    fi
    if ! aws_remove_dir_with_retry "$trash"; then
        echo "WARNING: could not remove '$trash'; it will be retried on next start."
    fi
    echo "Repaired app directory for '$app_id'."
    return 0
}

# Scan custom_apps and repair every nested app. Healthy apps are untouched,
# so the function is idempotent. Sets AWS_REPAIRED_APPS_COUNT.
aws_repair_nested_custom_apps() {
    local app_dir app_id
    AWS_REPAIRED_APPS_COUNT=0
    [ -d "$AWS_CUSTOM_APPS_DIR" ] || return 0
    aws_cleanup_repair_leftovers
    for app_dir in "$AWS_CUSTOM_APPS_DIR"/*/; do
        [ -d "$app_dir" ] || continue
        app_id="$(basename "$app_dir")"
        if [ -f "${app_dir}appinfo/info.xml" ]; then
            continue
        fi
        if [ -f "${app_dir}${app_id}/appinfo/info.xml" ]; then
            if aws_repair_nested_app "$app_id"; then
                AWS_REPAIRED_APPS_COUNT=$((AWS_REPAIRED_APPS_COUNT + 1))
                aws_reenable_app_if_disabled "$app_id"
            else
                echo "Manual intervention required for '$app_id'."
            fi
        else
            echo "App directory '$app_id' has no appinfo/info.xml and no nested app; skipping (manual check recommended)."
        fi
    done
    return 0
}
