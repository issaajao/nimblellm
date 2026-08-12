#!/usr/bin/env bash
# Fails if any GitHub workflow invokes the live provider check or references
# provider credentials.
#
# CI runs entirely against mocked transports. `verify:live` spends real money
# against real providers and fails for reasons unrelated to the code (model
# entitlement, region availability, quota), which makes it unfit as a gate.
# A comment saying so is not an enforcement mechanism; this is.
#
# This lives outside .github/workflows on purpose: a guard that searched the
# directory containing its own patterns would match itself and always fail.
set -euo pipefail

WORKFLOWS='.github/workflows'
status=0

if [ ! -d "$WORKFLOWS" ]; then
  echo "No $WORKFLOWS directory; nothing to check."
  exit 0
fi

if matches=$(grep -rnE 'verify[:-]live' "$WORKFLOWS" 2>/dev/null); then
  echo "::error::A workflow invokes the live provider check. It must stay manual."
  echo "$matches"
  status=1
fi

CREDENTIALS='OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|AZURE_OPENAI_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_SERVICE_ACCOUNT_JSON|AWS_BEARER_TOKEN_BEDROCK'
if matches=$(grep -rnE "$CREDENTIALS" "$WORKFLOWS" 2>/dev/null); then
  echo "::error::A workflow references provider credentials. CI runs against mocked transports only."
  echo "$matches"
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "OK: no workflow invokes the live check or references provider credentials."
fi
exit "$status"
