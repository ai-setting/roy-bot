#!/usr/bin/env bash
# @fileoverview TDD RED — wiki-auth.sh library contract tests (Task #2900 P0-B)
#
# This test sources the library under test and exercises each exported function.
# Tests run against a real bash interpreter with a temporary HOME/cache dir
# so they don't pollute the user's actual ~/.cache/roy-bot/jwt.json.
#
# Usage:   bash wiki-auth.test.sh
# Exit:    0 on all-pass, non-zero otherwise (set -euo pipefail)
#
# Functions under test (from get-jwt node bash command in workflows.db):
#   - safe_run_dir <runId>
#   - preflight_check <base_url>
#   - jwt_lock_acquire <timeout_sec>
#   - jwt_lock_release
#   - jwt_cache_exists
#   - jwt_cache_age_seconds
#   - jwt_cache_read
#   - jwt_cache_write <jwt> <source> <user_info>
#   - cookie_extract_sid <raw_cookie>
#   - is_retryable_error <response>
#   - is_non_retryable_error <response>

set -euo pipefail

# Locate the library under test
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$LIB_DIR/wiki-auth.sh"
if [ ! -f "$LIB" ]; then
  echo "FAIL: $LIB not found" >&2
  exit 99
fi

# Use isolated HOME/cache so the user's real cache is untouched
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
    PASS=$((PASS+1))
    echo "  ok   $label"
  else
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("$label")
    echo "  FAIL $label — expected='$expected' actual='$actual'"
  fi
}

assert_match() {
  local label="$1"
  local pattern="$2"
  local actual="$3"
  if echo "$actual" | grep -Eq "$pattern"; then
    PASS=$((PASS+1))
    echo "  ok   $label"
  else
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("$label")
    echo "  FAIL $label — pattern='$pattern' actual='$actual'"
  fi
}

echo "=== safe_run_dir ==="
RUN_ID="run-test-12345"
DIR1=$(safe_run_dir "$RUN_ID")
assert_match "creates dir under /tmp/roy-bot" '^/tmp/roy-bot/wiki-'"$RUN_ID" "$DIR1"
[ -d "$DIR1" ] || { FAIL=$((FAIL+1)); echo "  FAIL safe_run_dir did not create dir"; }

# Two calls with same runId must produce DIFFERENT paths (avoid collision
# in concurrent invocations of the same runId)
DIR2=$(safe_run_dir "$RUN_ID")
if [ "$DIR1" != "$DIR2" ]; then
  PASS=$((PASS+1))
  echo "  ok   safe_run_dir is collision-resistant (same runId → different paths)"
else
  FAIL=$((FAIL+1))
  FAILED_TESTS+=("safe_run_dir collision")
  echo "  FAIL safe_run_dir produced same path for same runId"
fi

echo ""
echo "=== preflight_check ==="
PF=$(preflight_check "https://example.com" 2>&1 || true)
assert_match "preflight returns JSON" '"healthy":(true|false)' "$PF"

echo ""
echo "=== jwt_lock_acquire / jwt_lock_release ==="
if jwt_lock_acquire 5; then
  PASS=$((PASS+1))
  echo "  ok   jwt_lock_acquire returns 0 on success"
  if jwt_lock_release 2>/dev/null; then
    PASS=$((PASS+1))
    echo "  ok   jwt_lock_release returns 0"
  else
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("jwt_lock_release")
    echo "  FAIL jwt_lock_release failed"
  fi
else
  FAIL=$((FAIL+1))
  FAILED_TESTS+=("jwt_lock_acquire")
  echo "  FAIL jwt_lock_acquire failed"
fi

echo ""
echo "=== jwt_cache_exists / jwt_cache_age_seconds / jwt_cache_read / jwt_cache_write ==="
# Initially: cache should not exist (fresh HOME)
if jwt_cache_exists; then
  FAIL=$((FAIL+1)); FAILED_TESTS+=("cache initially absent")
  echo "  FAIL cache should be absent on fresh HOME"
else
  PASS=$((PASS+1))
  echo "  ok   cache absent on fresh HOME"
fi

AGE_INITIAL=$(jwt_cache_age_seconds 2>/dev/null || echo "")
if [ -z "$AGE_INITIAL" ] || [ "$AGE_INITIAL" = "-1" ]; then
  PASS=$((PASS+1))
  echo "  ok   jwt_cache_age_seconds returns empty when cache absent"
else
  FAIL=$((FAIL+1)); FAILED_TESTS+=("cache age when absent")
  echo "  FAIL jwt_cache_age_seconds when absent: '$AGE_INITIAL'"
fi

# Write a cache entry and verify
TEST_JWT="eyJ0eXAiOiJKV1QifQ.eyJzdWIiOiJ0ZXN0In0.SIGNATURE"
jwt_cache_write "$TEST_JWT" "ldap-login" "testuser" >/dev/null 2>&1

if jwt_cache_exists; then
  PASS=$((PASS+1))
  echo "  ok   cache exists after write"
else
  FAIL=$((FAIL+1)); FAILED_TESTS+=("cache after write")
  echo "  FAIL cache missing after write"
fi

AGE=$(jwt_cache_age_seconds 2>/dev/null || echo "")
if [ -n "$AGE" ] && [ "$AGE" -ge 0 ] && [ "$AGE" -lt 60 ]; then
  PASS=$((PASS+1))
  echo "  ok   jwt_cache_age_seconds returns small positive int (got $AGE)"
else
  FAIL=$((FAIL+1)); FAILED_TESTS+=("cache age after write")
  echo "  FAIL jwt_cache_age_seconds after write: '$AGE'"
fi

READ=$(jwt_cache_read 2>/dev/null || echo "")
assert_eq "jwt_cache_read returns written JWT" "$TEST_JWT" "$READ"

echo ""
echo "=== cookie_extract_sid ==="
# Standard cookie string with ones-ids-sid
RAW_COOKIE="ones-ids-sid=abc123def456; Path=/; HttpOnly"
SID=$(cookie_extract_sid "$RAW_COOKIE")
assert_eq "extracts ones-ids-sid from standard cookie" "abc123def456" "$SID"

# Empty cookie
EMPTY_SID=$(cookie_extract_sid "")
if [ -z "$EMPTY_SID" ]; then
  PASS=$((PASS+1))
  echo "  ok   cookie_extract_sid returns empty on empty input"
else
  FAIL=$((FAIL+1)); FAILED_TESTS+=("cookie empty")
  echo "  FAIL cookie_extract_sid on empty: '$EMPTY_SID'"
fi

# No ones-ids-sid in cookie
NO_SID=$(cookie_extract_sid "session=xyz; theme=dark")
if [ -z "$NO_SID" ]; then
  PASS=$((PASS+1))
  echo "  ok   cookie_extract_sid returns empty when ones-ids-sid absent"
else
  FAIL=$((FAIL+1)); FAILED_TESTS+=("cookie missing sid")
  echo "  FAIL cookie_extract_sid when missing: '$NO_SID'"
fi

echo ""
echo "=== is_retryable_error / is_non_retryable_error ==="
# Retryable: network errors, 5xx
if is_retryable_error '{"status":500,"message":"internal error"}'; then
  PASS=$((PASS+1))
  echo "  ok   500 is retryable"
else
  FAIL=$((FAIL+1)); FAILED_TESTS+=("retry 500")
  echo "  FAIL 500 should be retryable"
fi

# Non-retryable: auth failures
if is_non_retryable_error '{"status":401,"message":"invalid credentials"}'; then
  PASS=$((PASS+1))
  echo "  ok   401 is non-retryable"
else
  FAIL=$((FAIL+1)); FAILED_TESTS+=("nonretry 401")
  echo "  FAIL 401 should be non-retryable"
fi

# Both false on a success response
if is_retryable_error '{"status":200,"data":"ok"}'; then
  FAIL=$((FAIL+1)); FAILED_TESTS+=("200 retryable (should be false)")
  echo "  FAIL 200 should NOT be retryable"
else
  PASS=$((PASS+1))
  echo "  ok   200 is not retryable"
fi

if is_non_retryable_error '{"status":200,"data":"ok"}'; then
  FAIL=$((FAIL+1)); FAILED_TESTS+=("200 nonretry (should be false)")
  echo "  FAIL 200 should NOT be non-retryable"
else
  PASS=$((PASS+1))
  echo "  ok   200 is not non-retryable"
fi

echo ""
echo "==================================="
echo "Results: PASS=$PASS FAIL=$FAIL"
if [ $FAIL -gt 0 ]; then
  echo "Failed tests:"
  for t in "${FAILED_TESTS[@]}"; do
    echo "  - $t"
  done
  exit 1
fi
exit 0