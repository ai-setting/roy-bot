#!/usr/bin/env bash
# @fileoverview wiki-auth.sh — Wiki/ONES authentication library (Task #2900 P0-B)
#
# This library is sourced by the get-jwt node bash command (and related
# wiki auth nodes). It provides:
#
#   - safe_run_dir <runId>           → unique, writable per-run temp directory
#   - preflight_check <base_url>     → JSON {healthy:true|false} DNS+HTTP probe
#   - jwt_lock_acquire <timeout_sec> → flock-based concurrent dedup
#   - jwt_lock_release               → best-effort release of the flock
#   - jwt_cache_exists               → 0 iff ~/.cache/roy-bot/jwt.json present
#   - jwt_cache_age_seconds          → echoes age in seconds (empty if missing)
#   - jwt_cache_read                 → echoes JWT string (empty if missing)
#   - jwt_cache_write <jwt> <src> <info>  → atomic cache write
#   - cookie_extract_sid <raw>       → echoes ones-ids-sid value (or empty)
#   - is_retryable_error <response>  → 0 iff retryable (network/5xx)
#   - is_non_retryable_error <resp>  → 0 iff non-retryable (401/403/4xx auth)
#
# SECURITY (Task #2776):
#   - LDAP password must come from LDAP_PASSWORD env var (NEVER logged).
#   - Cache file is mode 0600.
#   - flock uses /tmp/roy-bot/.jwt.lock (per-user).
#
# Design goals:
#   - POSIX-ish bash (works on macOS bash 3.2 + Linux bash 4+).
#   - No external deps beyond flock/curl/jq-or-grep/python3.
#   - Functions fail closed (return non-zero on misconfiguration).

set -u

# ============================================================================
# Path constants
# ============================================================================

# Use XDG_CACHE_HOME if set, else ~/.cache (matches ~/.cache/roy-bot convention)
_wiki_cache_dir() {
  if [ -n "${XDG_CACHE_HOME:-}" ]; then
    printf '%s/roy-bot' "$XDG_CACHE_HOME"
  else
    printf '%s/.cache/roy-bot' "${HOME:-/tmp}"
  fi
}

CACHE_DIR="$(_wiki_cache_dir)"
CACHE_FILE="$CACHE_DIR/jwt.json"
LOCK_FILE="$CACHE_DIR/.jwt.lock"
mkdir -p "$CACHE_DIR" 2>/dev/null || true
# Tight permissions on cache file (created lazily on write)
[ -f "$CACHE_FILE" ] && chmod 600 "$CACHE_FILE" 2>/dev/null || true
[ -f "$LOCK_FILE" ] && chmod 600 "$LOCK_FILE" 2>/dev/null || true

# Per-run temp dir base
RUN_DIR_BASE="/tmp/roy-bot"

# ============================================================================
# safe_run_dir <runId>
# Echoes a unique writable directory under $RUN_DIR_BASE. Two calls with the
# same runId return DIFFERENT paths (collision-resistant via $$ + RANDOM).
# Creates the directory if it does not exist.
# ============================================================================
safe_run_dir() {
  local run_id="${1:-}"
  local pid=$$
  local rnd="${RANDOM:-0}$(date +%N 2>/dev/null || echo 0)"
  local dir="$RUN_DIR_BASE/wiki-${run_id:-norunid}-${pid}-${rnd}"
  mkdir -p "$dir" 2>/dev/null || {
    echo "FATAL: cannot create $dir" >&2
    return 1
  }
  printf '%s' "$dir"
}

# ============================================================================
# preflight_check <base_url>
# Probes DNS resolution and HTTP reachability for base_url. Returns JSON.
#   {"healthy":true,  "latency_ms":123, "dns":"ok", "http":"ok"}
#   {"healthy":false, "reason":"dns",  "detail":"..."}
# ============================================================================
preflight_check() {
  local base="${1:-}"
  local host="" latency_ms=0 start=0 end=0 rc=0
  if [ -z "$base" ]; then
    echo '{"healthy":false,"reason":"no_url"}'
    return 0
  fi
  # Extract host (strip protocol + path)
  host=$(printf '%s' "$base" | sed -E 's|^https?://||; s|/.*$||; s|:.*$||')
  if [ -z "$host" ]; then
    echo '{"healthy":false,"reason":"invalid_url"}'
    return 0
  fi
  # DNS probe
  if ! getent hosts "$host" >/dev/null 2>&1 && ! host "$host" >/dev/null 2>&1 && ! nslookup "$host" >/dev/null 2>&1; then
    echo "{\"healthy\":false,\"reason\":\"dns\",\"detail\":\"$host unresolvable\"}"
    return 0
  fi
  # HTTP probe (best-effort, 10s timeout)
  start=$(date +%s%3N 2>/dev/null || date +%s)
  local http_code
  http_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$base" 2>/dev/null || echo "000")
  end=$(date +%s%3N 2>/dev/null || date +%s)
  latency_ms=$((end - start))
  rc=$?
  if [ "$rc" -ne 0 ] || [ "$http_code" = "000" ]; then
    echo "{\"healthy\":false,\"reason\":\"http\",\"detail\":\"curl rc=$rc\"}"
    return 0
  fi
  echo "{\"healthy\":true,\"latency_ms\":$latency_ms,\"dns\":\"ok\",\"http\":\"ok\",\"status\":$http_code}"
  return 0
}

# ============================================================================
# jwt_lock_acquire <timeout_sec>
# Acquires exclusive flock on $LOCK_FILE with timeout. Echoes "ok" on success,
# "" on timeout. Caller should release with jwt_lock_release.
# ============================================================================
# Hold the FD in a global so release can close it
_WIKI_LOCK_FD=""

jwt_lock_acquire() {
  local timeout="${1:-30}"
  # Open FD 9 on lockfile; flock waits up to $timeout seconds
  if command -v flock >/dev/null 2>&1; then
    eval "exec 9>\"$LOCK_FILE\""
    if flock -w "$timeout" 9; then
      _WIKI_LOCK_FD=9
      echo "ok"
      return 0
    fi
    eval "exec 9>&-"
    echo ""
    return 1
  fi
  # flock not available — fallback: mkdir-based lock
  local lockdir="$LOCK_FILE.dir"
  local waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if mkdir "$lockdir" 2>/dev/null; then
      _WIKI_LOCK_FD="dir:$lockdir"
      echo "ok"
      return 0
    fi
    sleep 1
    waited=$((waited+1))
  done
  echo ""
  return 1
}

jwt_lock_release() {
  if [ -n "${_WIKI_LOCK_FD:-}" ]; then
    case "$_WIKI_LOCK_FD" in
      dir:*)
        rm -rf "${_WIKI_LOCK_FD#dir:}" 2>/dev/null || true
        ;;
      *)
        eval "exec ${_WIKI_LOCK_FD}>&-" 2>/dev/null || true
        ;;
    esac
    _WIKI_LOCK_FD=""
  fi
  return 0
}

# ============================================================================
# JWT cache helpers (Task #2776 Phase 2 — 7-day TTL)
# Cache format (JSON):
#   {"jwt":"<jwt>","source":"ldap-login|cache-hit|cookie","created_at":<unix_ts>,
#    "user_info":"<email|uuid>","version":"1"}
# ============================================================================

jwt_cache_exists() {
  [ -f "$CACHE_FILE" ] && [ -r "$CACHE_FILE" ]
}

jwt_cache_age_seconds() {
  if ! jwt_cache_exists; then
    echo ""
    return 0
  fi
  local now file_mtime age
  now=$(date +%s 2>/dev/null || echo 0)
  # Try stat -c first (GNU), fall back to stat -f (BSD/macOS)
  file_mtime=$(stat -c '%Y' "$CACHE_FILE" 2>/dev/null || stat -f '%m' "$CACHE_FILE" 2>/dev/null || echo 0)
  if [ "$file_mtime" -eq 0 ]; then
    echo ""
    return 0
  fi
  age=$((now - file_mtime))
  if [ "$age" -lt 0 ]; then
    age=0
  fi
  echo "$age"
}

jwt_cache_read() {
  if ! jwt_cache_exists; then
    echo ""
    return 0
  fi
  # Extract the "jwt" field from JSON without jq (use python3 or grep fallback)
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "
import json,sys
try:
  with open('$CACHE_FILE') as f: d=json.load(f)
  print(d.get('jwt',''))
except Exception: print('')
" 2>/dev/null
    return 0
  fi
  # Fallback: grep-based extraction (less robust but works without python)
  grep -oE '"jwt"[[:space:]]*:[[:space:]]*"[^"]*"' "$CACHE_FILE" 2>/dev/null \
    | sed -E 's/^"jwt"[[:space:]]*:[[:space:]]*"([^"]*)"/\1/' \
    | head -1
}

jwt_cache_write() {
  local jwt="${1:-}"
  local source="${2:-ldap-login}"
  local user_info="${3:-}"
  if [ -z "$jwt" ]; then
    echo "FATAL: jwt_cache_write requires non-empty jwt" >&2
    return 1
  fi
  local now tmpfile
  now=$(date +%s 2>/dev/null || echo 0)
  tmpfile="$CACHE_FILE.tmp.$$"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$tmpfile" "$jwt" "$source" "$user_info" "$now" <<'PYEOF'
import json, sys
tmpfile, jwt, source, user_info, now = sys.argv[1:6]
data = {
  "jwt": jwt,
  "source": source,
  "created_at": int(now) if now.isdigit() else 0,
  "user_info": user_info,
  "version": "1",
}
with open(tmpfile, 'w') as f:
  json.dump(data, f)
PYEOF
  else
    # Fallback: write JSON manually (escape quotes in jwt/user_info)
    # Task #2925 followup: use POSIX-safe sed (dash doesn't support ${var//pat/repl}).
    local jwt_escaped user_escaped
    jwt_escaped=$(printf '%s' "$jwt" | sed 's/"/\\"/g')
    user_escaped=$(printf '%s' "$user_info" | sed 's/"/\\"/g')
    printf '{"jwt":"%s","source":"%s","created_at":%s,"user_info":"%s","version":"1"}\n' \
      "$jwt_escaped" "$source" "$now" "$user_escaped" > "$tmpfile"
  fi
  chmod 600 "$tmpfile" 2>/dev/null || true
  mv "$tmpfile" "$CACHE_FILE" 2>/dev/null || {
    rm -f "$tmpfile" 2>/dev/null || true
    echo "FATAL: cannot write $CACHE_FILE" >&2
    return 1
  }
  return 0
}

# ============================================================================
# cookie_extract_sid <raw_cookie>
# Extracts the ones-ids-sid value from a raw cookie header string.
# ============================================================================
cookie_extract_sid() {
  local raw="${1:-}"
  if [ -z "$raw" ]; then
    echo ""
    return 0
  fi
  # Look for ones-ids-sid=VALUE; (until ; or end-of-string)
  echo "$raw" | grep -oE 'ones-ids-sid[[:space:]]*=[[:space:]]*[^;[:space:]]*' 2>/dev/null \
    | head -1 \
    | sed -E 's/^ones-ids-sid[[:space:]]*=[[:space:]]*//' \
    || echo ""
}

# ============================================================================
# is_retryable_error <response> / is_non_retryable_error <response>
# Classify JSON / text responses for retry policy.
# Retryable: 5xx, network errors (timeout/connection), JSON parse failures
# Non-retryable: 401, 403, 400 (bad request, auth failure)
# ============================================================================
is_retryable_error() {
  local resp="${1:-}"
  if [ -z "$resp" ]; then
    # Empty response = network failure = retryable
    return 0
  fi
  # 5xx
  if echo "$resp" | grep -qE '"status"[[:space:]]*:[[:space:]]*5[0-9][0-9]'; then
    return 0
  fi
  # Network error keywords
  if echo "$resp" | grep -qE '(timeout|connection refused|ECONN|ENOTFOUND|ETIMEDOUT|curl.*failed)'; then
    return 0
  fi
  # 4xx other than 401/403/400 = NOT retryable here (let caller decide)
  return 1
}

is_non_retryable_error() {
  local resp="${1:-}"
  if [ -z "$resp" ]; then
    return 1
  fi
  # Auth failures = non-retryable
  if echo "$resp" | grep -qE '"status"[[:space:]]*:[[:space:]]*(401|403)'; then
    return 0
  fi
  # Bad request = non-retryable
  if echo "$resp" | grep -qE '"status"[[:space:]]*:[[:space:]]*400'; then
    return 0
  fi
  # ONES-specific "NotFound.TemporarySession" error = auth session expired
  if echo "$resp" | grep -qE 'NotFound\.TemporarySession|invalid.*credentials|Unauthorized'; then
    return 0
  fi
  return 1
}

# ============================================================================
# v2.5.0 OAuth helpers (Task #2925)
#
# Background: ONES wiki upgraded their OAuth client_id from per-org to a
# built-in value "ones.v1". PKCE flow with the previous client_id (orgUUID)
# returned "missing client_id" / "invalid_client". /identity/authorize and
# /identity/oauth/token also require application/x-www-form-urlencoded
# (not application/json), and the redirect_uri MUST be <base>/auth/authorize/callback.
#
# These helpers centralize the constants so get-jwt nodes and tests stay in sync.
# ============================================================================

# v2.5.0 fixed OAuth client_id (was orgUUID in v2.4.0; ONES upgrade rejected it).
# Overridable via OAUTH_CLIENT_ID env var for ONES upgrades without re-release.
oauth_client_id() {
  printf '%s' "${OAUTH_CLIENT_ID:-ones.v1}"
}

# v2.5.0 fixed authorize/token redirect_uri
# Both /identity/authorize and /identity/oauth/token require the same value.
oauth_authorize_redirect_uri() {
  local base="${1:-}"
  if [ -z "$base" ]; then
    echo "FATAL: oauth_authorize_redirect_uri requires base url" >&2
    return 1
  fi
  printf '%s/auth/authorize/callback' "$base"
}

# alias for symmetry with get-jwt node logic
oauth_token_redirect_uri() {
  oauth_authorize_redirect_uri "${1:-}"
}

# Internal: url-encode a string using python3 (form-urlencoded uses '+' for space,
# per https://url.spec.whatwg.org/#application-x-www-form-urlencoded). Fail-closed
# if python3 is missing — silent printf fallback would emit malformed body that
# ONES would reject with no clear error in v2.5.0 auth chain.
_wiki_url_encode() {
  local raw="${1:-}"
  if ! command -v python3 >/dev/null 2>&1; then
    echo "FATAL: python3 required for URL encoding (wiki-auth.sh v2.5.0+)" >&2
    return 1
  fi
  printf '%s' "$raw" | python3 -c "import sys,urllib.parse;print(urllib.parse.quote_plus(sys.stdin.read(),safe=''))"
}

# Build the /identity/authorize POST body (form-urlencoded).
# Usage: build_authorize_body <base> <org_uuid> <org_user_uuid> <code_challenge> <state>
build_authorize_body() {
  local base="${1:-}" org_uuid="${2:-}" org_user_uuid="${3:-}" challenge="${4:-}" state="${5:-}"
  if [ -z "$base" ] || [ -z "$org_uuid" ] || [ -z "$org_user_uuid" ] || [ -z "$challenge" ]; then
    echo "FATAL: build_authorize_body missing arg (base/org/org_user/challenge required)" >&2
    return 1
  fi
  # Note: state is optional (for back-compat) but recommended.
  local scope redirect_uri
  scope="openid offline_access ones:org:default:${org_uuid}:${org_user_uuid}"
  redirect_uri=$(oauth_authorize_redirect_uri "$base")
  # urlencoded scope/redirect_uri/state segments (quote_plus: space → '+')
  local scope_enc redirect_enc state_enc
  scope_enc=$(_wiki_url_encode "$scope") || return 1
  redirect_enc=$(_wiki_url_encode "$redirect_uri") || return 1
  state_enc=$(_wiki_url_encode "$state") || return 1
  printf 'client_id=%s&scope=%s&response_type=code&code_challenge_method=S256&code_challenge=%s&redirect_uri=%s&state=%s' \
    "$(oauth_client_id)" "$scope_enc" "$challenge" "$redirect_enc" "$state_enc"
}

# Build the /identity/oauth/token POST body (form-urlencoded).
# Usage: build_token_body <base> <code> <code_verifier>
build_token_body() {
  local base="${1:-}" code="${2:-}" verifier="${3:-}"
  if [ -z "$base" ] || [ -z "$code" ] || [ -z "$verifier" ]; then
    echo "FATAL: build_token_body missing arg (base/code/verifier required)" >&2
    return 1
  fi
  local redirect_uri redirect_enc
  redirect_uri=$(oauth_authorize_redirect_uri "$base")
  redirect_enc=$(_wiki_url_encode "$redirect_uri") || return 1
  printf 'grant_type=authorization_code&client_id=%s&code=%s&code_verifier=%s&redirect_uri=%s' \
    "$(oauth_client_id)" "$code" "$verifier" "$redirect_enc"
}

# ============================================================================
# v2.5.1 authorize callback handler (Task #2925)
#
# Background: After finalize returns {"callback_url":"/authorize/callback?id=X"},
# we need to GET that URL (with sid cookie), which returns 302 redirect to
# /auth/authorize/callback?code=<auth_code>&state=<our_state>.
#
# This helper extracts the authorization `code` from the redirect Location.
# Usage: extract_auth_code <location_header>
# Echoes: <code> on stdout; empty + rc=1 if not found.
# ============================================================================
extract_auth_code() {
  local location="${1:-}"
  local code=""

  # Strategy 1: "?code=XXX" in Location query string
  code=$(printf '%s' "$location" | sed -nE 's|.*[?&]code=([^&[:space:]]+).*|\1|p' | head -1)
  if [ -n "$code" ]; then
    printf '%s' "$code"
    return 0
  fi

  # Strategy 2: some servers put it in fragment (#code=) — uncommon in OAuth code flow
  code=$(printf '%s' "$location" | sed -nE 's|.*#code=([^&[:space:]]+).*|\1|p' | head -1)
  if [ -n "$code" ]; then
    printf '%s' "$code"
    return 0
  fi

  return 1
}
#
# Background: After ONES upgrade, /identity/authorize now returns
#   HTTP 302 + Location: /identity/organization_select?id=<auth_request_id>
# instead of returning JSON {"auth_request_id":"..."} inline. The multi-org
# user must confirm org selection before getting an auth_request_id.
#
# This helper accepts the response BODY + HEADERS and extracts the auth_request_id:
#   - Strategy 1 (legacy): parse body as JSON, take .auth_request_id
#   - Strategy 2 (current): look for "?id=<uuid>" in the redirected Location
# Usage: parse_authorize_response <body> <headers_dump>
# Echoes: <auth_request_id> on stdout; empty + rc=1 if not found.
# ============================================================================
parse_authorize_response() {
  local body="${1:-}" headers="${2:-}"
  local id=""

  # Strategy 1: JSON body (legacy v2.4.0 path; JSON returned inline)
  id=$(printf '%s' "$body" | python3 -c "import json,sys;
try:
  d = json.load(sys.stdin);
  print(d.get('auth_request_id',''));
except Exception:
  print('')" 2>/dev/null || echo "")
  if [ -n "$id" ]; then
    printf '%s' "$id"
    return 0
  fi

  # Strategy 2: redirected Location header (current ONES upgrade behaviour)
  if [ -n "$headers" ]; then
    # Location: <url> ... ?id=<uuid>
    id=$(printf '%s' "$headers" | grep -i '^[Ll]ocation:' | tail -1 | sed -nE 's|.*[?&]id=([a-fA-F0-9-]+).*|\1|p' | head -1)
    if [ -n "$id" ]; then
      printf '%s' "$id"
      return 0
    fi
  fi

  # No id found
  return 1
}

# ============================================================================
# Bootstrap self-test (silent unless WIKI_AUTH_SELFTEST=1)
# ============================================================================
if [ "${WIKI_AUTH_SELFTEST:-0}" = "1" ]; then
  echo "wiki-auth.sh loaded from $0"
  echo "  CACHE_FILE=$CACHE_FILE"
  echo "  LOCK_FILE=$LOCK_FILE"
  echo "  RUN_DIR_BASE=$RUN_DIR_BASE"
  echo "  OAUTH_CLIENT_ID=$(oauth_client_id)"
  echo "  AUTHORIZE_REDIRECT_URI=$(oauth_authorize_redirect_uri https://wiki.example.com)"
fi