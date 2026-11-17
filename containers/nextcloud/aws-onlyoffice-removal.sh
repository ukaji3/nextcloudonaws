#!/bin/bash
# shellcheck shell=bash
#
# nextcloudonaws: remove the onlyoffice app left by earlier versions of this stack.
#
# The stack no longer runs the OnlyOffice document server (removed 2026-11;
# OnlyOffice is deprecated in upstream AIO). Earlier versions installed the
# onlyoffice app and stored its settings, including the JWT secret, in the app
# config and in config.php (system key "onlyoffice"). Without the document
# server the app keeps offering an editor that cannot load, and the settings
# keep a copy of a secret that no longer exists in Secrets Manager.
#
# aws_remove_onlyoffice does nothing when ONLYOFFICE_ENABLED is "yes".
# Otherwise it removes whatever is still present:
#   1. the app: "occ app:remove onlyoffice" disables it (running the app's
#      uninstall steps) and deletes custom_apps/onlyoffice. Files that EFS
#      keeps behind are removed with retries (see aws-custom-apps-repair.sh);
#      if occ fails, the app is disabled and the directory removed directly
#   2. every app config value of "onlyoffice" (including "enabled" and
#      "installed_version", so Nextcloud forgets the app)
#   3. the system config key "onlyoffice"
# Steps 2 and 3 run only once the directory is gone, so a directory that cannot
# be removed keeps the app and its settings together for the next attempt.
# Database tables created by the app's migrations (oc_onlyoffice_*) and their
# oc_migrations rows are kept: Nextcloud does not drop them on removal, and
# they are reused if the app is installed again.
# Each step checks first, so a second call prints nothing and changes nothing.
#
# This file is a library: sourced by entrypoint.sh and by the tests. It needs
# aws_remove_dir_with_retry from aws-custom-apps-repair.sh.
#
# Overridable for tests:
#   aws_occ()                function wrapping "php /var/www/html/occ"
#   AWS_ONLYOFFICE_APP_DIR   app directory (default /var/www/html/custom_apps/onlyoffice)

AWS_ONLYOFFICE_APP_DIR="${AWS_ONLYOFFICE_APP_DIR:-/var/www/html/custom_apps/onlyoffice}"

if ! declare -F aws_occ >/dev/null; then
    # Run occ. Defined only if the caller has not provided its own wrapper.
    aws_occ() {
        php /var/www/html/occ "$@"
    }
fi

# Print the last line of stdin that is a JSON object containing key $1, so log
# lines that occ may print around its JSON output are ignored.
# Arguments: $1 = top-level key the object must have ("apps" or "system").
aws_last_json_object() {
    # The PHP code is single-quoted on purpose; its variables belong to PHP.
    # shellcheck disable=SC2016
    php -r '
        $found = "";
        foreach (preg_split("/\R/", stream_get_contents(STDIN)) as $line) {
            $line = trim($line);
            if ($line !== "" && $line[0] === "{") {
                $decoded = json_decode($line, true);
                if (is_array($decoded) && array_key_exists($argv[1], $decoded)) { $found = $line; }
            }
        }
        echo $found;
    ' "$1"
}

# Print the app config keys of app $1, one per line. Values are never printed.
# Arguments: $1 = app id.
aws_app_config_keys() {
    local app_id="$1"
    # shellcheck disable=SC2016
    aws_occ config:list "$app_id" --private --output=json 2>/dev/null | aws_last_json_object apps | php -r '
        $data = json_decode(stream_get_contents(STDIN), true);
        $values = is_array($data) ? ($data["apps"][$argv[1]] ?? []) : [];
        if (!is_array($values)) { exit(0); }
        foreach (array_keys($values) as $key) { echo $key, PHP_EOL; }
    ' "$app_id"
}

# Succeed when the system config (config.php) has the top-level key $1.
# Arguments: $1 = key.
aws_system_config_has() {
    # shellcheck disable=SC2016
    aws_occ config:list system --private --output=json 2>/dev/null | aws_last_json_object system | php -r '
        $data = json_decode(stream_get_contents(STDIN), true);
        exit(is_array($data) && is_array($data["system"] ?? null) && array_key_exists($argv[1], $data["system"]) ? 0 : 1);
    ' "$1"
}

# Remove the onlyoffice app directory (step 1). Returns 0 when it is gone.
aws_remove_onlyoffice_app_dir() {
    [ -e "$AWS_ONLYOFFICE_APP_DIR" ] || return 0
    echo "Removing the onlyoffice app (this stack has no OnlyOffice document server)..."
    if ! aws_occ app:remove onlyoffice; then
        echo "WARNING: occ app:remove onlyoffice failed; disabling the app and removing '$AWS_ONLYOFFICE_APP_DIR' directly."
        aws_occ app:disable onlyoffice > /dev/null 2>&1
    fi
    if ! aws_remove_dir_with_retry "$AWS_ONLYOFFICE_APP_DIR"; then
        echo "WARNING: could not remove '$AWS_ONLYOFFICE_APP_DIR'; it will be retried on next start."
        return 1
    fi
    return 0
}

# Delete every app config value of onlyoffice (step 2).
aws_remove_onlyoffice_app_config() {
    local keys key
    keys="$(aws_app_config_keys onlyoffice)"
    [ -n "$keys" ] || return 0
    echo "Deleting the app config of onlyoffice ($(wc -l <<< "$keys") values)..."
    while IFS= read -r key; do
        [ -n "$key" ] || continue
        aws_occ config:app:delete onlyoffice "$key" > /dev/null
    done <<< "$keys"
}

# Delete the system config key onlyoffice (step 3).
aws_remove_onlyoffice_system_config() {
    aws_system_config_has onlyoffice || return 0
    echo "Deleting the system config key onlyoffice..."
    aws_occ config:system:delete onlyoffice > /dev/null
}

# Remove the onlyoffice app and its settings unless OnlyOffice is enabled.
# The settings are deleted only after the app directory is gone: if the
# directory cannot be removed, everything is kept and the whole removal runs
# again on the next start (app and settings stay consistent).
# Always returns 0: a failure is reported and retried on the next start.
aws_remove_onlyoffice() {
    if [ "${ONLYOFFICE_ENABLED:-}" = yes ]; then
        return 0
    fi
    if ! aws_remove_onlyoffice_app_dir; then
        return 0
    fi
    aws_remove_onlyoffice_app_config
    aws_remove_onlyoffice_system_config
    return 0
}
