#!/usr/bin/env bash
# Prove a built image actually serves, using no provider credentials at all.
#
# Deliberately credential-free: the gateway's own behaviour is fully
# exercisable without one, and introducing a dummy key here would trip
# check-no-live-calls.sh, which cannot tell a placeholder from a real secret.
#
#   ./scripts/smoke-test-image.sh nimblellm:smoke
set -euo pipefail

IMAGE="${1:?usage: smoke-test-image.sh <image>}"
NAME="nimblellm-smoke-$$"
PORT=18080

cleanup() {
  docker logs "$NAME" 2>&1 | sed 's/^/  container | /' || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Starting $IMAGE ..."
docker run -d --name "$NAME" -p "${PORT}:8080" \
  -e NIMBLE_SERVER_API_KEYS=smoke-key \
  "$IMAGE" >/dev/null

# The container is up when liveness answers; give it a bounded window.
for _ in $(seq 1 30); do
  if curl -fsS "localhost:${PORT}/health" >/dev/null 2>&1; then break; fi
  sleep 1
done

fail() { echo "::error::$1"; exit 1; }

echo "1/4 liveness returns 200"
curl -fsS "localhost:${PORT}/health" | grep -q '"status":"ok"' \
  || fail '/health did not report ok'

echo "2/4 readiness reports 503 with no provider configured"
code=$(curl -s -o /dev/null -w '%{http_code}' "localhost:${PORT}/ready")
[ "$code" = "503" ] || fail "/ready returned $code, expected 503 with no provider configured"

echo "3/4 an unauthenticated request is rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' "localhost:${PORT}/v1/providers")
[ "$code" = "401" ] || fail "/v1/providers returned $code without a key, expected 401"

echo "4/4 a keyed request is served"
curl -fsS -H "authorization: Bearer smoke-key" "localhost:${PORT}/v1/providers" \
  | grep -q '"openai"' || fail '/v1/providers did not list the built-in adapters'

echo "OK: the image starts, serves, and enforces its gateway key."
