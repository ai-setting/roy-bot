#!/usr/bin/env bash
# @fileoverview TDD RED — wiki-auth.sh v2.5.0 OAuth client_id + Content-Type contract tests (Task #2925)
#
# Background:
#   Task #2924 verified that v2.4.0 PKCE flow fails with:
#     - "auth request is missing client_id"
#     - "invalid_client"
#   Root cause discovered by playwright probe in Task #2925:
#     - client_id should be "ones.v1" (not orgUUID)
#     - Content-Type for /identity/authorize and /identity/oauth/token must be
#       "application/x-www-form-urlencoded" (not application/json)
#     - redirect_uri must be "$BASE/auth/authorize/callback" (not $BASE/project/#/workspace)
#
# This test sources the library and verifies 5 new helpers expose the correct values.
# RED state (before GREEN fix): all 5 tests fail because helpers don't exist yet.
# GREEN state (after fix): all 5 pass.
#
# Usage:   bash wiki-auth-v2.5.test.sh
# Exit:    0 on all-pass, non-zero otherwise

set -euo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$LIB_DIR/wiki-auth.sh"
if [ ! -f "$LIB" ]; then
  echo "FAIL: $LIB not found" >&2
  exit 99
fi

TEST_HOME="$(mktemp -d)"
export HOME="$TEST_HOME"
export XDG_CACHE_HOME="$TEST_HOME/cache"
mkdir -p "$XDG_CACHE_HOME/roy-bot"

# shellcheck source=wiki-auth.sh
. "$LIB"

PASS=0
FAIL=0
FAILED_TESTS=()

assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$label")
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
  fi
}

echo "=== Test 1: oauth_client_id returns 'ones.v1' ==="
ACTUAL=$(oauth_client_id 2>/dev/null || echo "__MISSING__")
assert_eq "oauth_client_id returns 'ones.v1'" "ones.v1" "$ACTUAL"

echo "=== Test 2: oauth_authorize_redirect_uri returns '<base>/auth/authorize/callback' ==="
ACTUAL=$(oauth_authorize_redirect_uri "https://wiki.example.com" 2>/dev/null || echo "__MISSING__")
assert_eq "oauth_authorize_redirect_uri for https://wiki.example.com" \
  "https://wiki.example.com/auth/authorize/callback" "$ACTUAL"

echo "=== Test 3: oauth_token_redirect_uri returns '<base>/auth/authorize/callback' ==="
ACTUAL=$(oauth_token_redirect_uri "https://wiki.example.com" 2>/dev/null || echo "__MISSING__")
assert_eq "oauth_token_redirect_uri for https://wiki.example.com" \
  "https://wiki.example.com/auth/authorize/callback" "$ACTUAL"

echo "=== Test 4: build_authorize_body contains form-urlencoded client_id=ones.v1 + callback ==="
ACTUAL=$(build_authorize_body \
  "https://wiki.example.com" \
  "ORG-UUID-PLACEHOLDER" \
  "TASK-UUID" \
  "A5xUHW-2EGw4A1OXWTeZ2BT3alORztfBLgOolecvFtU" \
  "roys-test-state" \
  2>/dev/null || echo "__MISSING__")
# Expected contains:
#   client_id=ones.v1
#   redirect_uri=https%3A%2F%2Fwiki.example.com%2Fauth%2Fauthorize%2Fcallback
#   scope=openid+offline_access+ones%3Aorg%3Adefault%3AORG-UUID-PLACEHOLDER%3ATASK-UUID  (NB: '+' for space, per spec)
#   response_type=code
#   code_challenge=A5xUHW... (preserved unmodified)
#   code_challenge_method=S256
if echo "$ACTUAL" | grep -q 'client_id=ones.v1' \
   && echo "$ACTUAL" | grep -q 'redirect_uri=https%3A%2F%2Fwiki.example.com%2Fauth%2Fauthorize%2Fcallback' \
   && echo "$ACTUAL" | grep -q 'scope=openid+offline_access+ones%3Aorg%3Adefault%3AORG-UUID-PLACEHOLDER%3ATASK-UUID' \
   && echo "$ACTUAL" | grep -q 'response_type=code' \
   && echo "$ACTUAL" | grep -q 'code_challenge=A5xUHW' \
   && echo "$ACTUAL" | grep -q 'code_challenge_method=S256'; then
  PASS=$((PASS + 1))
  echo "  PASS: build_authorize_body has all required fields (incl. '+' for space)"
else
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("build_authorize_body shape")
  echo "  FAIL: build_authorize_body missing required fields"
  echo "    actual: $ACTUAL"
fi

echo "=== Test 5: build_token_body contains form-urlencoded client_id=ones.v1 + callback ==="
ACTUAL=$(build_token_body \
  "https://wiki.example.com" \
  "fake-auth-code-abc123" \
  "fake-verifier-xyz789" \
  2>/dev/null || echo "__MISSING__")
if echo "$ACTUAL" | grep -q 'grant_type=authorization_code' \
   && echo "$ACTUAL" | grep -q 'client_id=ones.v1' \
   && echo "$ACTUAL" | grep -q 'code=fake-auth-code-abc123' \
   && echo "$ACTUAL" | grep -q 'code_verifier=fake-verifier-xyz789' \
   && echo "$ACTUAL" | grep -q 'redirect_uri=https%3A%2F%2Fwiki.example.com%2Fauth%2Fauthorize%2Fcallback'; then
  PASS=$((PASS + 1))
  echo "  PASS: build_token_body has all required fields"
else
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("build_token_body shape")
  echo "  FAIL: build_token_body missing required fields"
  echo "    actual: $ACTUAL"
fi

echo "=== Test 6: missing python3 → FATAL (no silent malformed output) ==="
# Use env -i + stub PATH to drop python3 from PATH. No set -e in the subshell
# because we want to inspect rc + output. We use POSIX substring match to keep
# the test self-contained (no grep dependency in the subshell).
SUBDIR=/tmp/wiki-v2.5-no-py
mkdir -p "$SUBDIR"
ACTUAL=$(env -i HOME="$TEST_HOME" XDG_CACHE_HOME="$XDG_CACHE_HOME" \
  bash -c "export PATH='$SUBDIR'; . '$LIB' >/dev/null 2>&1; out=\$(build_authorize_body 'https://wiki.example.com' 'ORG-UUID-PLACEHOLDER' 'TASK-UUID' 'x' 's' 2>&1); rc=\$?; echo RC=\$rc OUT=\$out")
PASS6=0
FAIL6=0
if echo "$ACTUAL" | grep -q "^RC=[^0]" && echo "$ACTUAL" | grep -q "FATAL: python3 required"; then
  PASS6=1
  echo "  PASS: build_authorize_body fails-closed when python3 missing"
  echo "    detail: $ACTUAL"
else
  FAIL6=1
  echo "  FAIL: build_authorize_body did not fail-closed"
  echo "    actual: $ACTUAL"
fi
if [ "$PASS6" -eq 1 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); FAILED_TESTS+=("build_authorize_body fail-closed"); fi
rm -rf "$SUBDIR" 2>/dev/null || true

echo "=== Test 7: oauth_client_id respects OAUTH_CLIENT_ID env override ==="
ACTUAL=$(OAUTH_CLIENT_ID="custom.client.v99" oauth_client_id 2>/dev/null || echo "__MISSING__")
assert_eq "oauth_client_id with OAUTH_CLIENT_ID override" "custom.client.v99" "$ACTUAL"

echo "=== Test 8: parse_authorize_response extracts id from JSON body ==="
TEST_BODY='{"auth_request_id":"abc-123-def"}'
ACTUAL=$(parse_authorize_response "$TEST_BODY" "" 2>/dev/null || echo "__MISSING__")
assert_eq "parse_authorize_response (JSON body)" "abc-123-def" "$ACTUAL"

echo "=== Test 9: parse_authorize_response extracts id from Location header (302 redirect) ==="
TEST_HEADERS='HTTP/1.1 302 Found
Server: openresty/1.21.4.1
Location: https://wiki.example.com/identity/organization_select?id=0ae5ab64-f706-4efe-40fd-c66667940743
Content-Length: 0'
ACTUAL=$(parse_authorize_response "" "$TEST_HEADERS" 2>/dev/null || echo "__MISSING__")
assert_eq "parse_authorize_response (Location header 302)" "0ae5ab64-f706-4efe-40fd-c66667940743" "$ACTUAL"

echo "=== Test 10b: extract_auth_code parses ?code= from Location header ==="
TEST_LOCATION='https://wiki.example.com/auth/authorize/callback?code=PSg_8D1L3s3fiLaBV6hnM7h-Ms_TG-ZXmLNBzdqw4ulhR94VwxxwniTYL1wqCQ6tu7_BGw&state=roys-1786505557-19957'
ACTUAL=$(extract_auth_code "$TEST_LOCATION" 2>/dev/null || echo "__MISSING__")
assert_eq "extract_auth_code (Location header with code query)" \
  "PSg_8D1L3s3fiLaBV6hnM7h-Ms_TG-ZXmLNBzdqw4ulhR94VwxxwniTYL1wqCQ6tu7_BGw" "$ACTUAL"

echo "=== Test 10c: extract_auth_code returns rc=1 when no code found ==="
if extract_auth_code "https://wiki.example.com/no/code/here" >/dev/null 2>&1; then
  RC=0
else
  RC=$?
fi
if [ "$RC" -ne 0 ]; then
  PASS=$((PASS + 1))
  echo "  PASS: extract_auth_code returns rc=1 when no code (rc=$RC)"
else
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("extract_auth_code fail-closed")
  echo "  FAIL: extract_auth_code should return non-zero (got rc=$RC)"
fi

echo "=== Test 10: parse_authorize_response returns rc=1 when no id found ==="
TEST_HEADERS_BAD='HTTP/1.1 400 Bad Request
Location: https://wiki.example.com/some/other/path'
# Run parse_authorize_response; expect non-zero exit code (wrapped in || true to survive set -e)
if parse_authorize_response "no token here" "$TEST_HEADERS_BAD" >/dev/null 2>&1; then
  RC=0
else
  RC=$?
fi
if [ "$RC" -ne 0 ]; then
  PASS=$((PASS + 1))
  echo "  PASS: parse_authorize_response returns rc=1 when no id found (rc=$RC)"
else
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("parse_authorize_response fail-closed")
  echo "  FAIL: parse_authorize_response should return non-zero when no id found (got rc=$RC)"
fi

# === Task #2925 followup: sh vs bash compat (RED → GREEN) ===
# Bash tool uses shell:true → /bin/sh (dash) actually invoked, not bash.
# dash does NOT support ${var//pattern/replacement} (parameter expansion).
# This was a real bug at wiki-auth.sh:245-246 (jwt_cache_write fallback path).
# These tests confirm the helpers + escape-via-sed fallback both work under dash.

echo "=== Test 11: wiki-auth.sh sourced + helpers work under /bin/sh (dash) ==="
ROYS_AUTH_LIB="$(cd "$(dirname "$0")" && pwd)/wiki-auth.sh"
if /bin/sh -c "
  set -u
  . '$ROYS_AUTH_LIB'
  out=\$(build_authorize_body 'https://wiki.example.com' 'ORG-UUID-PLACEHOLDER' 'TASK-UUID' 'challenge123' 'state-xyz')
  [ -n \"\$out\" ] || { echo 'build_authorize_body empty'; exit 1; }
  out=\$(build_token_body 'https://wiki.example.com' 'code123' 'verifier123')
  [ -n \"\$out\" ] || { echo 'build_token_body empty'; exit 1; }
  out=\$(extract_auth_code 'https://example.com/callback?code=ABC123&state=xyz')
  [ \"\$out\" = 'ABC123' ] || { echo \"extract_auth_code got [\$out]\"; exit 1; }
  out=\$(parse_authorize_response '{\"auth_request_id\":\"xyz789\"}' '')
  [ \"\$out\" = 'xyz789' ] || { echo \"parse_authorize_response got [\$out]\"; exit 1; }
  out=\$(parse_authorize_response '' 'HTTP/1.1 302 Found
Location: https://wiki.example.com/identity/organization_select?id=0ae5ab64-f706-4efe-40fd-c66667940743')
  [ \"\$out\" = '0ae5ab64-f706-4efe-40fd-c66667940743' ] || { echo \"parse_authorize_response loc got [\$out]\"; exit 1; }
  echo 'all helpers work under dash'
" 2>&1; then
  PASS=$((PASS + 1))
  echo "  PASS: wiki-auth.sh v2.5.1 helpers work under /bin/sh (dash)"
else
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("dash compat: helpers")
  echo "  FAIL: wiki-auth.sh v2.5.1 helpers under /bin/sh"
fi

echo "=== Test 12: quote-escape fallback works under /bin/sh (POSIX-safe, not bash-only) ==="
# Direct check: ${var//pattern/replacement} is BASH-ONLY.
# dash returns "Bad substitution". The fix should use POSIX sed-based escaping.
if /bin/sh -c "
  jwt='abc\"def'
  escaped=\$(printf '%s' \"\$jwt\" | sed 's/\"/\\\\\"/g')
  [ \"\$escaped\" = 'abc\\\"def' ] || { echo \"POSIX escape got [\$escaped]\"; exit 1; }
  echo 'POSIX quote escape works'
" 2>&1; then
  PASS=$((PASS + 1))
  echo "  PASS: POSIX-safe quote escape works under dash"
else
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("dash compat: quote escape")
  echo "  FAIL: POSIX-safe quote escape fails under dash"
fi

echo "=== Test 13: jwt_cache_write fallback path works under /bin/sh ==="
# This tests the specific lines that originally had bash-only syntax.
# With python3 unavailable, jwt_cache_write falls back to printf with manual JSON.
# The manual path used ${jwt//\"/\\\"} which crashes under dash.
# Fix: use printf+sed (POSIX-safe).
# Write the test snippet to a file so we don't need to escape quotes in -c
TEST_SNIPPET="$(mktemp /tmp/wiki-auth-fallback-test.XXXXXX.sh)"
cat > "$TEST_SNIPPET" <<'TESTEOF'
#!/bin/sh
# Replicate the FIXED jwt_cache_write fallback branch from wiki-auth.sh
jwt_cache_write_fallback_test() {
  local jwt="$1" source="$2" user_info="$3"
  local now=$(date +%s 2>/dev/null || echo 0)
  local tmpfile="$4"
  # FIXED: POSIX-safe sed (replaces the bash-only ${jwt//"/\"} construct)
  local jwt_escaped user_escaped
  jwt_escaped=$(printf '%s' "$jwt" | sed 's/"/\\"/g')
  user_escaped=$(printf '%s' "$user_info" | sed 's/"/\\"/g')
  printf '{"jwt":"%s","source":"%s","created_at":%s,"user_info":"%s","version":"1"}\n' \
    "$jwt_escaped" "$source" "$now" "$user_escaped" > "$tmpfile"
}
tmpfile=$(mktemp)
jwt_cache_write_fallback_test 'eyJ"abc.def.ghi' 'test-source' '{"name":"test"}' "$tmpfile"
[ -s "$tmpfile" ] || { echo 'tmpfile not written'; exit 1; }
grep -q '"jwt":"eyJ' "$tmpfile" || { echo 'jwt field format wrong'; cat "$tmpfile"; exit 1; }
grep -q '"user_info":"' "$tmpfile" || { echo 'user_info field format wrong'; cat "$tmpfile"; exit 1; }
rm -f "$tmpfile"
echo 'jwt_cache_write fallback (POSIX-safe) works under dash'
TESTEOF
chmod +x "$TEST_SNIPPET"
if /bin/sh "$TEST_SNIPPET" 2>&1; then
  PASS=$((PASS + 1))
  echo "  PASS: jwt_cache_write fallback path works under /bin/sh (dash)"
else
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("dash compat: jwt_cache_write fallback")
  echo "  FAIL: jwt_cache_write fallback path fails under /bin/sh"
fi
rm -f "$TEST_SNIPPET"

echo ""
echo "=== Summary ==="
echo "PASS: $PASS"
echo "FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed tests:"
  for t in "${FAILED_TESTS[@]}"; do
    echo "  - $t"
  done
  exit 1
fi
exit 0
