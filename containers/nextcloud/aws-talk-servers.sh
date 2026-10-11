#!/bin/bash
# shellcheck shell=bash
#
# nextcloudonaws: clean up Talk TURN/STUN servers registered by earlier versions.
#
# Earlier versions of this stack passed TURN_DOMAIN=<NC_DOMAIN>, so entrypoint.sh
# registered "<NC_DOMAIN>:3478" as TURN and STUN server. NC_DOMAIN points to the
# ALB, which only listens on 443, so clients could never reach TURN/STUN. The
# stack now passes TURN_DOMAIN=turn.<NC_DOMAIN> (the Talk NLB) and upstream
# entrypoint.sh adds that entry, but it never removes old entries.
#
# aws_remove_stale_talk_server removes exactly one known stale server, and only
# after the replacement entry exists, so Talk is never left without TURN/STUN.
# Servers added by an administrator are not touched.
#
# This file is a library: sourced by entrypoint.sh and by the tests.
#
# Overridable for tests:
#   aws_occ()   function wrapping "php /var/www/html/occ"

if ! declare -F aws_occ >/dev/null; then
    # Run occ. Defined only if the caller has not provided its own wrapper.
    aws_occ() {
        php /var/www/html/occ "$@"
    }
fi

# Decode the JSON printed by "occ talk:<kind>:list --output=json" (the last line
# that looks like JSON wins, so stray log lines are ignored) and print one line
# per server: "<schemes>\t<server>\t<protocols>" for TURN, "<server>" for STUN.
# Arguments: $1 = turn|stun.
aws_list_talk_servers() {
    local kind="$1"
    # The PHP code is single-quoted on purpose; its variables belong to PHP.
    # shellcheck disable=SC2016
    aws_occ "talk:$kind:list" --output=json 2>/dev/null | php -r '
        $data = null;
        foreach (preg_split("/\R/", stream_get_contents(STDIN)) as $line) {
            $line = trim($line);
            if ($line !== "" && ($line[0] === "[" || $line[0] === "{")) {
                $decoded = json_decode($line, true);
                if (is_array($decoded)) { $data = $decoded; }
            }
        }
        if (!is_array($data)) { exit(0); }
        foreach ($data as $entry) {
            if (is_string($entry)) { echo $entry, PHP_EOL; }
            elseif (is_array($entry) && isset($entry["server"])) {
                echo $entry["schemes"] ?? "turn", "\t", $entry["server"], "\t", $entry["protocols"] ?? "udp,tcp", PHP_EOL;
            }
        }'
}

# Remove the stale TURN entries for one server, if the current one is registered.
# Arguments: $1 = stale host:port, $2 = current host:port.
aws_remove_stale_turn_server() {
    local stale="$1" current="$2" schemes server protocols list
    list="$(aws_list_talk_servers turn)"
    if ! cut -f2 <<< "$list" | grep -qxF "$current"; then
        echo "WARNING: TURN server '$current' is not registered; keeping '$stale'"
        return 0
    fi
    while IFS=$'\t' read -r schemes server protocols; do
        [ "$server" = "$stale" ] || continue
        echo "Removing stale TURN server '$stale' ($schemes, $protocols)"
        aws_occ talk:turn:delete "$schemes" "$server" "$protocols"
    done <<< "$list"
}

# Remove the stale STUN entry, if the current one is registered.
# Arguments: $1 = stale host:port, $2 = current host:port.
aws_remove_stale_stun_server() {
    local stale="$1" current="$2" list
    list="$(aws_list_talk_servers stun)"
    if ! grep -qxF "$current" <<< "$list"; then
        echo "WARNING: STUN server '$current' is not registered; keeping '$stale'"
        return 0
    fi
    if grep -qxF "$stale" <<< "$list"; then
        echo "Removing stale STUN server '$stale'"
        aws_occ talk:stun:delete "$stale"
    fi
}

# Remove a stale TURN/STUN server once its replacement is registered.
# Arguments: $1 = stale host:port, $2 = current host:port. No-op when equal.
aws_remove_stale_talk_server() {
    local stale="$1" current="$2"
    if [ -z "$stale" ] || [ -z "$current" ] || [ "$stale" = "$current" ]; then
        return 0
    fi
    aws_remove_stale_turn_server "$stale" "$current"
    aws_remove_stale_stun_server "$stale" "$current"
    return 0
}
