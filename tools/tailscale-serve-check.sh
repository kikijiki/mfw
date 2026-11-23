#!/usr/bin/env bash
# Manual check of trusted-proxy mode behind a real `tailscale serve`.
#
#   bun run build
#   tools/tailscale-serve-check.sh <machine>.<tailnet>.ts.net:<spare-port>
#
# It starts a THROWAWAY server (temporary home, no orchestrator, loopback) and
# never changes your Serve configuration: you run the printed command yourself.
# MFW_CHECK_CURL_OPTS adds curl options, for rehearsing against a local proxy.
set -euo pipefail

external="${1:-}"
if [[ ! "$external" =~ ^[a-z0-9.-]+:[0-9]+$ ]]; then
	echo "usage: $0 <machine>.<tailnet>.ts.net:<spare-port>" >&2
	exit 2
fi
https_port="${external##*:}"
root="$(cd "$(dirname "$0")/.." && pwd)"
entry="$root/apps/start/.output/server/index.mjs"
[[ -f "$entry" ]] || { echo "no production build. Fix: bun run build" >&2; exit 2; }

port="${MFW_CHECK_PORT:-47790}"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/mfw-serve-check-XXXXXX")"
socket="$scratch/mfw/serve/mfw.sock"
server=""
cleanup() {
	if [[ -n "$server" ]]; then
		kill "$server" 2>/dev/null || true
		wait "$server" 2>/dev/null || true
	fi
	echo "Temporary files (a throwaway home) are in $scratch"
}
trap cleanup EXIT

mkdir -p "$scratch/home"
HOME="$scratch/home" MFW_HOME="$scratch/mfw" HOST=127.0.0.1 PORT="$port" \
	MFW_DISABLE_ORCHESTRATOR=1 MFW_USAGE_MONITOR=0 \
	TMUX_TMPDIR="$scratch" MFW_TMUX_SOCKET="mfw-serve-check-$$" \
	MFW_LISTEN_SOCKET="$socket" MFW_ALLOWED_HOSTS="$external" \
	bun run "$entry" >"$scratch/server.log" 2>&1 &
server=$!

for _ in $(seq 1 100); do
	[[ -s "$scratch/mfw/setup-token" && -S "$socket" ]] && break
	sleep 0.1
done
[[ -s "$scratch/mfw/setup-token" && -S "$socket" ]] || { cat "$scratch/server.log" >&2; exit 1; }

echo "Throwaway server on 127.0.0.1:$port. In another terminal run:"
echo
echo "  sudo tailscale serve --bg --https=$https_port unix:$socket"
echo
read -r -p "Press Enter once it is published. " _

url="https://$external/mfw"
failed=0
result() { # name, ok(0/1), detail
	if [[ "$2" == 0 ]]; then echo "ok    $1"; else echo "FAIL  $1 ($3)"; failed=1; fi
}
# shellcheck disable=SC2086
http() { curl -sS --max-time 15 ${MFW_CHECK_CURL_OPTS:-} "$@"; }
post() { # action, json, extra curl args...
	local action="$1" body="$2"
	shift 2
	http -i -X POST "$url/api/auth/$action" -H "Origin: https://$external" \
		-H 'Content-Type: application/json' -H 'x-mfw-auth: 1' -d "$body" "$@"
}
status() { head -n1 | tr -d '\r' | awk '{print $2}'; }

password="serve check owner passphrase"
token="$(tr -d '\n' <"$scratch/mfw/setup-token")"
setup="$(post setup "{\"token\":\"$token\",\"password\":\"$password\"}")"
code="$(status <<<"$setup")"
rc=0; [[ "$code" == 200 ]] || rc=$?; result "setup through the proxy" "$rc" "$code"

cookie_line="$(grep -i '^set-cookie: __Secure-mfw_session=' <<<"$setup" | grep -vi 'Max-Age=0' | head -n1 | tr -d '\r' || true)"
rc=0; [[ -n "$cookie_line" ]] || rc=$?; result "X-Forwarded-Proto gave the __Secure- cookie" "$rc" "no such cookie"
rc=0; grep -qi '; Secure' <<<"$cookie_line" || rc=$?; result "cookie is Secure" "$rc" "$cookie_line"
rc=0; grep -qi '; HttpOnly' <<<"$cookie_line" || rc=$?; result "cookie is HttpOnly" "$rc" "$cookie_line"
rc=0; grep -qi 'SameSite=Strict' <<<"$cookie_line" || rc=$?; result "cookie is SameSite=Strict" "$rc" "$cookie_line"
rc=0; grep -qE 'Path=/mfw(;|$)' <<<"$cookie_line" || rc=$?; result "cookie Path is /mfw" "$rc" "$cookie_line"

cookie="$(sed -E 's/^[^:]+: ([^;]+).*/\1/' <<<"$cookie_line")"
key="$(sed -nE 's/.*"requestKey":"([^"]+)".*/\1/p' <<<"$setup")"
code="$(http -o /dev/null -w '%{http_code}' "$url/api/trpc/brain.states" -H "Cookie: $cookie" -H "x-mfw-key: $key")"
rc=0; [[ "$code" == 200 ]] || rc=$?; result "cookie and key read the API" "$rc" "$code"
code="$(http -o /dev/null -w '%{http_code}' "$url/api/trpc/brain.states" -H "Cookie: __Secure-mfw_session=$(printf 'A%.0s' {1..43}); $cookie" -H "x-mfw-key: $key")"
rc=0; [[ "$code" == 200 ]] || rc=$?; result "a planted cookie is harmless" "$rc" "$code"

# The proxy must replace a client's forwarded headers. If it passes them on,
# mfw refuses the request (403), and that is the failure this check exists for.
code="$(http -o /dev/null -w '%{http_code}' "$url/api/auth/state" -H 'X-Forwarded-Host: evil.example')"
rc=0; [[ "$code" == 200 ]] || rc=$?; result "the proxy replaces a forged X-Forwarded-Host" "$rc" "$code"
code="$(http -o /dev/null -w '%{http_code}' "$url/api/auth/state" -H 'X-Forwarded-Proto: http')"
rc=0; [[ "$code" == 200 ]] || rc=$?; result "the proxy replaces a forged X-Forwarded-Proto" "$rc" "$code"

locked=1
for i in 1 2 3 4 5 6 7 8; do
	code="$(post login '{"password":"wrong password here"}' -H "X-Forwarded-For: 198.51.100.$i" | status)"
	if [[ "$code" == 429 ]]; then locked=0; break; fi
done
result "rotating a forged X-Forwarded-For does not escape the throttle" "$locked" "never locked"

echo
echo "Remove the mapping afterwards:  tailscale serve --https=$https_port off"
echo "Then work through the browser checklist in docs/exposure.md."
exit "$failed"
