#!/bin/bash
# shellcheck shell=bash
#
# nextcloudonaws: remove files that earlier versions of this stack installed
# into the served Nextcloud web root.
#
# diag.php (a Redis connectivity probe added while the ElastiCache Serverless
# configuration was being worked out) was copied into /var/www/html on every
# start. It needs no authentication, echoes the cache endpoint and writes a key
# into the shared cache, and "occ integrity:check-core" reports it as
# EXTRA_FILE. The same checks are available through occ and the regular
# monitoring, so the file is gone from the image - but the copy on EFS survives
# an image change, because the install/upgrade rsync only runs on a version
# change and diag.php is not in upgrade.exclude either.
#
# aws_remove_legacy_webroot_files deletes exactly the files this stack is known
# to have added, never anything else, so a web root prepared by Nextcloud itself
# is left untouched.
#
# This file is a library: sourced by entrypoint.sh and by the tests.

# Files this stack installed into the web root in earlier versions.
AWS_LEGACY_WEBROOT_FILES=('diag.php')

# Delete the known legacy files from a web root.
# Arguments: $1 = web root (default /var/www/html).
aws_remove_legacy_webroot_files() {
    local webroot="${1:-/var/www/html}" name target
    [ -d "$webroot" ] || return 0
    for name in "${AWS_LEGACY_WEBROOT_FILES[@]}"; do
        target="$webroot/$name"
        # Only plain files, so a directory of the same name is never touched.
        if [ -f "$target" ] && [ ! -L "$target" ]; then
            echo "Removing legacy file '$target' (no longer part of this image)"
            rm -f "$target"
        fi
    done
    return 0
}
