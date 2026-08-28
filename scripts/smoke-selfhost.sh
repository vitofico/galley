#!/usr/bin/env bash
# Self-host smoke test (roadmap #5, ADR-0017): bring the runtime stack up with
# `docker compose up` and assert it actually SERVES Galley — not just that the
# image builds. Hits the running containers over their published localhost ports.
#
#   ./scripts/smoke-selfhost.sh            # web + proxy + sync
#   ./scripts/smoke-selfhost.sh --compile  # also the compile service
#
# Exits 0 only if every checked endpoint answers as expected. Tears the stack
# down on exit regardless of outcome.
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker-compose.yml)
PROFILE_ARGS=()
SERVICES=(web proxy sync)
if [[ "${1:-}" == "--compile" ]]; then
  PROFILE_ARGS=(--profile compile)
  SERVICES+=(compile)
  # Slice 5: a compile deployment advertises the (browser-reachable) compile
  # URL to the SPA via serve-time runtime config — exported for the `up` so the
  # web service serves /config.js + injects its script tag (asserted below).
  export GALLEY_COMPILE_URL="http://127.0.0.1:3001/compile"
fi

cleanup() { "${COMPOSE[@]}" ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

# Poll an HTTP endpoint until it returns the expected status (or time out).
wait_http() {
  local url="$1" want="$2" name="$3" tries=60
  for _ in $(seq 1 "$tries"); do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    [[ "$code" == "$want" ]] && { echo "  ok: $name ($url -> $code)"; return 0; }
    sleep 1
  done
  fail "$name never returned $want at $url"
}

echo "==> building + starting: ${SERVICES[*]}"
"${COMPOSE[@]}" ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} up -d --build "${SERVICES[@]}"

echo "==> waiting for endpoints"
wait_http "http://127.0.0.1:8080/healthz" 200 "web /healthz"
wait_http "http://127.0.0.1:8787/healthz" 200 "proxy /healthz"
wait_http "http://127.0.0.1:1234/"        200 "sync /"
if [[ "${1:-}" == "--compile" ]]; then
  wait_http "http://127.0.0.1:3001/healthz" 200 "compile /healthz"
fi

echo "==> asserting the served app is real"
body="$(curl -s http://127.0.0.1:8080/)"
echo "$body" | grep -q "Galley" || fail "web root did not serve the Galley SPA HTML"
echo "  ok: web / serves the Galley SPA"

# /healthz must return real JSON {"ok":true}, not just a 200 — a misconfigured
# WEB_ROOT reports {"ok":false}/503, so the body is the no-false-healthy signal.
health="$(curl -s http://127.0.0.1:8080/healthz)"
echo "$health" | grep -q '"ok":true' || fail "web /healthz body was not {\"ok\":true} (got: $health)"
echo "  ok: web /healthz returns {\"ok\":true}"

# Production security headers must be present on the served document (see
# apps/web-server/src/index.ts: the app.use("*") defense-in-depth middleware).
hdrs="$(curl -s -D - -o /dev/null http://127.0.0.1:8080/)"
header_has() {
  echo "$hdrs" | grep -iq "^$1:[[:space:]]*$2" || fail "web / missing header '$1: $2'"
  echo "  ok: header $1"
}
header_has "x-content-type-options" "nosniff"
header_has "x-frame-options" "DENY"
header_has "referrer-policy" "no-referrer"
header_has "permissions-policy" "camera=(), microphone=(), geolocation=(), browsing-topics=()"
echo "$hdrs" | grep -iq "^content-security-policy:.*script-src" \
  || fail "web / missing Content-Security-Policy with script-src"
echo "  ok: header content-security-policy"

# A client-side deep link must fall back to the SPA shell (200 text/html).
ct="$(curl -s -o /dev/null -w '%{content_type}' http://127.0.0.1:8080/some/deep/link)"
echo "$ct" | grep -q "text/html" || fail "SPA deep-link fallback did not serve HTML (got: $ct)"
echo "  ok: SPA deep-link fallback"

# A missing asset must 404 (not be masked by index.html).
code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/assets/definitely-missing-xyz.js)"
[[ "$code" == "404" ]] || fail "missing asset returned $code (expected 404)"
echo "  ok: missing asset -> 404"

# sync's health body identifies the relay.
curl -s http://127.0.0.1:1234/ | grep -q "galley-sync ok" || fail "sync health body unexpected"
echo "  ok: sync relay health body"

if [[ "${1:-}" == "--compile" ]]; then
  # Slice 5: with GALLEY_COMPILE_URL set, the web service must (a) serve the
  # runtime config at /config.js carrying the URL, and (b) inject the script
  # tag into the served SPA shell so the Server/Auto compile toggle can engage.
  cfg="$(curl -s http://127.0.0.1:8080/config.js)"
  echo "$cfg" | grep -q '^window.__GALLEY_CONFIG__ = ' \
    || fail "/config.js did not declare window.__GALLEY_CONFIG__ (got: $cfg)"
  echo "$cfg" | grep -qF "$GALLEY_COMPILE_URL" \
    || fail "/config.js does not carry GALLEY_COMPILE_URL=$GALLEY_COMPILE_URL (got: $cfg)"
  echo "  ok: /config.js serves the compile URL"

  cfg_ct="$(curl -s -o /dev/null -w '%{content_type}' http://127.0.0.1:8080/config.js)"
  echo "$cfg_ct" | grep -q "application/javascript" \
    || fail "/config.js content-type was not application/javascript (got: $cfg_ct)"
  echo "  ok: /config.js content-type"

  echo "$body" | grep -qF '<script src="/config.js"></script>' \
    || fail "served index.html does not carry the /config.js script tag"
  echo "  ok: index.html carries the runtime-config script tag"
else
  # Without the env, the runtime config must be ABSENT (no dead-server advert).
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/config.js)"
  [[ "$code" == "404" ]] || fail "/config.js should be 404 without GALLEY_COMPILE_URL (got $code)"
  echo "  ok: /config.js absent without GALLEY_COMPILE_URL"
fi

echo "SMOKE PASS: docker compose up serves Galley (${SERVICES[*]})"
