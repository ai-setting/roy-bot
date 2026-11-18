/**
 * @fileoverview redact-command-secrets.ts — Mask inline secrets in shell commands
 * before they are embedded in a user/agent-visible error message (Task #4392 P0-2).
 *
 * Background: #4385 §5.5 diff-1 asks for `Tool exited with code N` to be enriched
 * with the command that was run. That command may legitimately contain inline
 * credentials (`twine upload --password=...`, `curl -H "Authorization: Bearer ..."`,
 * `PIP_INDEX_TOKEN=... npm publish`), which must NOT leak into:
 *   - `workflow.node.end` session messages,
 *   - trace span attributes,
 *   - the LLM context of the next turn.
 *
 * This helper is a *best-effort* shell-string masker (complementary to
 * `sensitive-redact.ts`, which only redacts object **field names**). It never
 * tries to parse shell; it matches the common credential shapes:
 *
 *   1. `KEY=value` / `KEY: value` / `--flag value` / `--flag=value`
 *      where KEY looks sensitive (`ASSIGNMENT_RE`, `FLAG_RE`).
 *   2. `<Scheme> <credential>` auth headers — `Authorization: Bearer <token>`,
 *      `Basic <base64>`, `Token <value>`, `Digest <value>` (`AUTH_SCHEME_RE`).
 *      The value is a *separate* word from the scheme, hence its own rule.
 *   3. URL query credentials — `?token=`, `&api_key=`, `&secret=`, `&sig=`
 *      (`URL_QUERY_RE`).
 *   4. URL userinfo credentials — `https://user:pass@host` (`URL_USERINFO_RE`).
 *   5. Short-option credentials — `curl -u user:pass`, `docker login -p <pw>`,
 *      `mysql -pVALUE` (`SHORT_CRED_RE`).
 *
 * ## Why rules 2–5 exist (Task #4419, from #4417 §B-1)
 *
 * The original implementation only had rules 1, and its bare-value branch stops
 * at the first whitespace. `Authorization: Bearer <token>` is *two* words, so it
 * masked `Bearer` and left the token intact. #4417 measured 9 of 14 real command
 * shapes still leaking. Rules 2–5 close those holes.
 *
 * ## Ordering / idempotency
 *
 * The rules are applied in a fixed order and each rule already skips values that
 * equal the `[REDACTED]` sentinel, so `redact(redact(x)) === redact(x)` holds.
 * Rule 2 is applied **before** rule 1: rule 1 would otherwise see
 * `Authorization: Bearer` and mask only the scheme word, leaving an
 * `Authorization: [REDACTED] <token>` remainder that rule 2 can no longer anchor.
 *
 * ## Non-goals
 *
 * - No shell parsing / word-splitting (quoting, `$VAR` expansion, heredocs).
 * - Environment-variable *references* (`$TOKEN`, `${TOKEN}`) are left alone —
 *   the variable name is not itself a secret, and masking it destroys the
 *   diagnostic value of the message.
 */

/** Sentinel substituted in place of a secret value. */
const MASK = "[REDACTED]";

/**
 * Keys that must never be echoed. Matched case-insensitively as a *substring*
 * of the key token so `LDAP_PASSWORD`, `--api-key`, `nexusPassword` all match.
 */
const SENSITIVE_KEY_RE =
  /(?:pass(?:word|wd|phrase)?|token|secret|api[_-]?key|apikey|credential|authorization|private[_-]?key)/i;

/**
 * `KEY=value` / `KEY: value` (assignments, env prefixes, YAML-ish pairs).
 *
 * Ordering note: the value group is tried in priority order — double-quoted,
 * single-quoted, then bare.
 *
 * The bare class (`BARE_VALUE`) allows most punctuation *inside* a value (so a
 * secret like `abc(def` is masked whole, not just its `abc` prefix) but must not
 * *end* on an argument delimiter, otherwise a bare value inside `"..."` swallows
 * the enclosing closing quote.
 *
 * Performance note (Task #4419): the `(?<![A-Za-z0-9_.-])` lookbehind anchors
 * the key at a word boundary. Without it the engine retries the greedy key
 * class at *every* offset inside a long token, so redacting an 80 KB bare word
 * took ~8 s (O(n²)); with the anchor it is ~1 ms. This is reachable in practice
 * because tool output routinely contains base64 blobs / minified lines.
 */
const BARE_VALUE = `[^\\s;&|]+[^\\s;&|"'<>()]|[^\\s;&|]`;

const ASSIGNMENT_RE = new RegExp(
  `(?<![A-Za-z0-9_.-])([A-Za-z0-9_][A-Za-z0-9_.-]*)\\s*[=:]\\s*(?:"([^"]*)"|'([^']*)'|(${BARE_VALUE}))`,
  "g"
);

/**
 * `--flag value` / `--flag=value` (CLI flags).
 */
const FLAG_RE = new RegExp(
  `(^|[\\s])(--?[A-Za-z0-9][A-Za-z0-9_.-]*)(=\\s*|\\s+)(?:"([^"]*)"|'([^']*)'|(${BARE_VALUE}))`,
  "g"
);

/**
 * HTTP auth header schemes followed by a *separate* credential word.
 *
 * Anchored on real auth context: the scheme must be immediately preceded by
 * `Authorization:` / `Proxy-Authorization:` (optionally quoted, as in
 * `-H "Authorization: Bearer <tok>"`). An unanchored match eats ordinary
 * English — `Please provide your token to continue` and
 * `Basic authentication is required` both used to lose a word.
 *
 * The value charset covers base64 (`+/=`) and JWT-ish tokens (`.-_~:`), and
 * accepts a bare `[REDACTED]` sentinel so re-running the masker is a no-op.
 */
const AUTH_SCHEME_RE = new RegExp(
  `((?:Proxy-)?Authorization["']?\\s*[:=]\\s*["']?\\s*)(Bearer|Basic|Token|Digest)\\s+(${BARE_VALUE}|\\[REDACTED\\])`,
  "gi"
);

/**
 * Query parameter names whose presence marks the value as a credential:
 * `?token=`, `&api_key=`, `&secret=`, `&sig=`, `&access_token=`, `&password=`, …
 *
 * Matched against the captured name **in code** rather than as a substring of a
 * single regex, because `[A-Za-z0-9_.-]*<keyword>` backtracks away the keyword
 * and silently never matches (`?token=` → greedy name eats `token`).
 */
const SENSITIVE_QUERY_KEY_RE = new RegExp(
  [
    // Whole-token match only: `auth` must not match `author`, and `sig` must
    // not match `design` / `signatureVersion`. Tokens are `_`/`-` separated.
    "^pass(?:word|wd)?$",
    "^pwd$",
    "^token$",
    "^access[_-]?token$",
    "^refresh[_-]?token$",
    "^id[_-]?token$",
    "^secret$",
    "^client[_-]?secret$",
    "^api[_-]?key$",
    "^apikey$",
    "^credential$",
    "^credentials$",
    "^sig$",
    "^signature$",
    "^auth$",
    "^authorization$",
    "^private[_-]?key$",
  ].join("|"),
  "i"
);

/** Any URL query pair: `?name=value` / `&name=value`. */
const URL_QUERY_RE = /([?&])([A-Za-z_][A-Za-z0-9_.-]*)(=)([^&#\s"']+)/g;

/**
 * URL userinfo: `//user:password@host`.
 *
 * The value class is **greedy** (`[^/\s"']+` instead of `[^@...]+`) and relies
 * on backtracking to the **last** `@`: passwords may legitimately contain `@`
 * (`//user:p@ss@host`). Matching up to the *first* `@` would leave `ss@host`
 * in the clear — a real leak, not just an over/under-redaction trade-off.
 *
 * Requires a colon before the credential and an `@` after it, so
 * `https://host:8443/path` (port, no `@`) is untouched.
 */
const URL_USERINFO_RE = /(\/\/[^/\s:@]+:)([^/\s"']+)(@)/g;

/**
 * Bare `user:password` following an auth-failure context word.
 *
 * This is the #B-2 scenario in its rawest form: a failing script echoes
 * `auth failed for admin:<password>` with no `-u`/`--user` flag and no URL to
 * anchor on. Anchoring on the context word keeps ordinary `12:30`, header
 * pairs (`Content-Type: ...`) and URL schemes (`https:`) out of scope.
 */
const AUTH_FAILURE_CRED_RE =
  /(\b(?:auth(?:entication|orization)?|login|credentials?|password|passwd|token)\b[^\n:]{0,40}?[\s"'])([A-Za-z0-9_.-]{1,64}):([^\s;&|"'<>]{3,})/gi;

/**
 * Short-option credentials (`-u user:pass`). The colon is required, so a bare
 * `-u alice` does not match; uid:gid pairs are rejected in code via `UID_GID_RE`.
 * The `-p` variants (`-p <pw>` / `-p<pw>`) are separate — see
 * `PASSWORD_FLAG_TOOL_RE` and `looksLikePasswordValue`.
 */
const SHORT_U_RE = /(^|\s)(-u\s+)([^:\s]+:)([^\s;&|"']+)/g;

/**
 * Long-form equivalent of `SHORT_U_RE`: `curl --user user:pass` /
 * `--user=user:pass`. Gated on the value containing a colon, so a bare
 * `--user alice` (username only, not a secret) is left alone.
 */
const LONG_USER_RE = /(^|\s)(--user(?:=|\s+))([^:\s]+:)([^\s;&|"']+)/g;

/**
 * `-u 1000:1000` is `uid:gid` (docker run/exec), not a credential.
 *
 * Detected by value shape rather than by tool name: a tool-name whitelist
 * missed perfectly good `-u` credentials whenever the command was prefixed
 * (`A=1 curl ... -u u:p`), and matched `docker` even when the flag belonged to
 * a different program in the same pipeline. A username/password pair that is
 * *entirely* numeric on both sides is vanishingly rare, so this shape test is
 * both safe and strlen-cheap.
 */
const UID_GID_RE = /^\d+$/;

/**
 * `-p VALUE` (space-separated). Accepts a quoted value so the quotes survive
 * (capture groups: dq / sq / bare), avoiding a dangling quote after masking.
 */
const SHORT_P_SPACED_RE = new RegExp(
  `(^|\\s)(-p\\s+)(?:"([^"]*)"|'([^']*)'|(${BARE_VALUE}))`,
  "g"
);

/** `-pVALUE` (attached). */
const SHORT_P_ATTACHED_RE = new RegExp(
  `(^|\\s)(-p)(?:"([^"]*)"|'([^']*)'|(${BARE_VALUE}))`,
  "g"
);

const isMasked = (value: string | undefined): boolean => (value ?? "").trim() === MASK;

/**
 * Auth scheme words. When one of these is the *value* of an
 * `Authorization: ...`-ish assignment, it is a scheme label, not the
 * credential — the credential itself was masked by `AUTH_SCHEME_RE` in the
 * previous step.
 *
 * Without this guard, `Authorization: Bearer [REDACTED]` degrades to
 * `Authorization: [REDACTED] [REDACTED]`: the scheme label is destroyed, which
 * both loses diagnostic context and makes the function's output depend on
 * whether the input was already masked (sentinel instability). Note the
 * pre-#4419 implementation had the same information loss — it was a latent
 * defect, not one introduced here.
 */
const AUTH_SCHEME_WORD_RE = /^(?:bearer|basic|token|digest|negotiate|ntlm)$/i;

/**
 * Rebuild a `match` after replacing its trailing `value` with `MASK`, without
 * relying on `indexOf`/`slice` arithmetic against the *value* text (which broke
 * on values containing regex-special or repeated substrings).
 *
 * @param match - The full regex match.
 * @param value - The captured value to replace (may be quoted).
 * @param quoted - The exact raw slice that appears in `match` for that value.
 */
function replaceTrailing(match: string, raw: string): string {
  if (raw.length === 0) return match;
  const idx = match.lastIndexOf(raw);
  if (idx < 0) return match;
  return match.slice(0, idx) + MASK;
}

/**
 * Tools for which a short `-p` means "password".
 *
 * ## Deliberately excluded (their `-p` is NOT a password)
 *
 * - `psql` / `pg_dump` / `pgcli` → `-p` is `--port`
 * - `ssh` / `scp` → `-p` / `-P` are ports
 * - `gsutil` → `-p` is `--project`
 * - `svn` / `htpasswd` → `-p` is not a password flag (`htpasswd -p` takes no
 *   value at all, so including it masks the *next argument*)
 * - `redis-cli` → `-p` is `--port` (`-a` is the password flag, handled below)
 * - `mongo` / `mongodump` / `mongorestore` → `-p` is `--port`; their password
 *   flag is `--password`
 *
 * A tool-name whitelist here is genuinely error-prone, so each entry is pinned
 * by a "must stay readable" test in `redact-command-secrets.test.ts`.
 *
 * The tool name only has to appear somewhere in the string — not strictly at a
 * command position — because credentials legitimately show up mid-line:
 * `connecting mysql -p<pw> ...` echoed on stdout, or `docker login -p <pw>`
 * after a `set -x` prefix. The `(?<![\w/.-])` lookbehind keeps path components
 * from counting (`cd /opt/mysql` is not a `mysql` invocation), and
 * `looksLikePasswordValue` rejects path-shaped / numeric `-p` arguments, which
 * is what protects `mkdir -p build`.
 */
const PASSWORD_FLAG_TOOL_RE =
  /(?<![\w/.-])(?:docker\s+login|helm\s+(?:registry\s+)?login|mysql|mysqldump|mariadb|sshpass)\b/i;

/**
 * Tools for which a short `-a` means "password" (`redis-cli -a <pw>`).
 *
 * Kept separate from `PASSWORD_FLAG_TOOL_RE` because the flag letter differs:
 * `redis-cli -p` is a port, so it must NOT be treated as a password tool.
 */
const SHORT_A_TOOL_RE = /(?<![\w/.-])redis-cli\b/i;

/**
 * `-a <secret>` is redis-cli's password flag.
 *
 * `(?!-)` keeps the spaced form from swallowing the *next flag*:
 * `redis-cli -a pw && tar -a -cf out.tar` must not turn `-cf` into a secret.
 */
const SHORT_A_SECRET_RE = new RegExp(`(^|\\s)(-a\\s+)(?!-)(${BARE_VALUE})`, "g");

/**
 * `-aVALUE` (attached).
 */
const SHORT_A_ATTACHED_RE = new RegExp(`(^|\\s)(-a)(${BARE_VALUE})`, "g");

/**
 * AWS CLI passes secrets as `aws configure set <key> <value>` — the key and
 * value are whitespace separated with no `=`, so the assignment rule misses it.
 * The negative lookahead skips the `set` verb itself so the key name is not
 * mistaken for the value.
 */
const AWS_SET_SECRET_RE = new RegExp(
  // The value must not start with `=`: otherwise `aws_secret_access_key = <v>`
  // would consume the `=` as the value and leave the real secret in clear.
  `\\b((?:aws[_-])?(?:secret[_-]?access[_-]?key|session[_-]?token))\\s+(?!set\\b)([^=\\s;&|][^\\s;&|]*[^\\s;&|"'<>()]|[^=\\s;&|])`,
  "gi"
);

/**
 * A `-p` value is only masked when it actually looks like a password and does
 * not look like a path, a number (port), or nothing at all. This is what keeps
 * `mkdir -p /tmp/build`, `mkdir -p build`, `tar -p -czf` and `cp -p src dst`
 * intact even when the command mentions one of the tools above.
 */
const PATH_LIKE_RE = /^(?:\/|\.\/|\.\.\/|~\/)/;
const NUMERIC_RE = /^\d+$/;

function looksLikeCredentialCommand(command: string): boolean {
  return PASSWORD_FLAG_TOOL_RE.test(command);
}

/** `redis-cli` 的 `-a <password>` 才需要脱敏（`-p` 是端口）。 */
function looksLikeShortATool(command: string): boolean {
  return SHORT_A_TOOL_RE.test(command);
}

/**
 * Reject values that are clearly not passwords.
 *
 * @param value - The captured `-p` argument.
 */
function looksLikePasswordValue(value: string): boolean {
  if (value.length === 0) return false;
  if (PATH_LIKE_RE.test(value)) return false;
  if (NUMERIC_RE.test(value)) return false;
  return true;
}

/**
 * Mask inline secrets inside a single shell command string.
 *
 * Idempotent: masked values (`[REDACTED]`) are left as-is.
 *
 * @param command - The raw command string (may be multi-line).
 * @returns The command with sensitive values replaced by `[REDACTED]`.
 */
export function redactCommandSecrets(command: string): string {
  if (!command) return command;

  let out = command;

  // 1. Auth header schemes: `Authorization: Bearer <token>`.
  //    Must run before the generic assignment rule (see file header).
  out = out.replace(
    AUTH_SCHEME_RE,
    (match, prefix: string, scheme: string, value: string) =>
      isMasked(value) ? match : `${prefix}${scheme} ${MASK}`
  );

  // 2. URL userinfo: `//user:pass@host`.
  out = out.replace(URL_USERINFO_RE, (match, head: string, value: string, at: string) =>
    isMasked(value) ? match : `${head}${MASK}${at}`
  );

  // 3. URL query credentials: `?token=...`, `&api_key=...`.
  out = out.replace(
    URL_QUERY_RE,
    (match, amp: string, name: string, eq: string, value: string) => {
      if (!SENSITIVE_QUERY_KEY_RE.test(name)) return match;
      if (isMasked(value)) return match;
      return `${amp}${name}${eq}${MASK}`;
    }
  );

  // 4. Short-option credentials (credential-bearing commands only for `-p`).
  out = out.replace(
    SHORT_U_RE,
    (match, lead: string, flag: string, user: string, pass: string) => {
      if (isMasked(pass)) return match;
      // `docker run -u 1000:1000` — uid:gid, not a username/password pair.
      const name = user.slice(0, -1);
      // `1000:1000` (uid:gid) and `root:root` (user:group) are not credentials.
      if (UID_GID_RE.test(name) && UID_GID_RE.test(pass)) return match;
      if (name === pass) return match;
      return `${lead}${flag}${user}${MASK}`;
    }
  );

  out = out.replace(
    LONG_USER_RE,
    (match, lead: string, flag: string, user: string, pass: string) => {
      if (isMasked(pass)) return match;
      const name = user.slice(0, -1);
      // `1000:1000` (uid:gid) and `root:root` (user:group) are not credentials.
      if (UID_GID_RE.test(name) && UID_GID_RE.test(pass)) return match;
      if (name === pass) return match;
      return `${lead}${flag}${user}${MASK}`;
    }
  );

  if (looksLikeCredentialCommand(command)) {
    const maskPassword = (
      match: string,
      lead: string,
      flag: string,
      dq?: string,
      sq?: string,
      bare?: string
    ): string => {
      const value = dq ?? sq ?? bare ?? "";
      if (isMasked(value) || !looksLikePasswordValue(value)) return match;
      // Preserve the original quoting so the diagnostic stays well-formed.
      if (dq !== undefined) return `${lead}${flag}"${MASK}"`;
      if (sq !== undefined) return `${lead}${flag}'${MASK}'`;
      return lead + flag + MASK;
    };
    out = out.replace(SHORT_P_SPACED_RE, maskPassword as never);
    out = out.replace(SHORT_P_ATTACHED_RE, maskPassword as never);
  }

  // N3: bare `user:password` after an auth-failure context word.
  out = out.replace(
    AUTH_FAILURE_CRED_RE,
    (match, head: string, user: string, pass: string) =>
      isMasked(pass) ? match : `${head}${user}:${MASK}`
  );

  // N7: `aws configure set <secret-key> <value>` (no `=`).
  out = out.replace(
    AWS_SET_SECRET_RE,
    (match, key: string, value: string) =>
      isMasked(value) ? match : `${key} ${MASK}`
  );

  // N6: redis-cli `-a <password>` / `-a<password>`.
  if (looksLikeShortATool(command)) {
    out = out.replace(
      SHORT_A_SECRET_RE,
      (match, lead: string, flag: string, value: string) =>
        isMasked(value) || !looksLikePasswordValue(value) ? match : `${lead}${flag}${MASK}`
    );
    out = out.replace(
      SHORT_A_ATTACHED_RE,
      (match, lead: string, flag: string, value: string) =>
        isMasked(value) || !looksLikePasswordValue(value) ? match : `${lead}${flag}${MASK}`
    );
  }

  // 5. Assignments: `PASSWORD=...`, `API_KEY: ...`, `token=...`.
  out = out.replace(
    ASSIGNMENT_RE,
    (match, key: string, dq?: string, sq?: string, bare?: string) => {
      if (!SENSITIVE_KEY_RE.test(key)) return match;
      const value = dq ?? sq ?? bare ?? "";
      if (value === MASK) return match;
      // `Authorization: Bearer [REDACTED]` — the scheme word is a label, not the
      // credential (already masked by AUTH_SCHEME_RE). Keeping it is both
      // idempotent and more useful as diagnostic context.
      //
      // ⚠️ 只对 authorization 类 key 生效：早期实现对所有敏感 key 都跳过
      // scheme 词，导致 `PASSWORD=token` / `--password digest` 这类真实口令
      // 完全不打码（覆盖被收窄）。口令恰好等于 scheme 词虽然罕见，但没有理由
      // 为它开一个洞。
      const isAuthHeaderKey = /^(?:proxy-)?authorization$/i.test(key);
      if (isAuthHeaderKey && AUTH_SCHEME_WORD_RE.test(value)) return match;
      const raw = dq !== undefined ? `"${value}"` : sq !== undefined ? `'${value}'` : value;
      return replaceTrailing(match, raw);
    }
  );

  // 6. CLI flags: `--password X`, `--token=X`, `--api-key X`.
  out = out.replace(
    FLAG_RE,
    (match, lead: string, flag: string, _sep: string, dq?: string, sq?: string, bare?: string) => {
      if (!SENSITIVE_KEY_RE.test(flag)) return match;
      const value = dq ?? sq ?? bare ?? "";
      if (value === MASK) return match;
      const raw = dq !== undefined ? `"${value}"` : sq !== undefined ? `'${value}'` : value;
      void lead;
      return replaceTrailing(match, raw);
    }
  );

  return out;
}

/**
 * Collapse a multi-line command into a single readable line and truncate it.
 *
 * Rationale: error messages are rendered as one line in `workflow.node.end`
 * messages and in most logs; embedding raw newlines makes them unreadable and
 * breaks naive `grep`-based diagnosis.
 *
 * @param command - Raw command (possibly multi-line, possibly huge).
 * @param maxLen - Maximum length of the returned string (default 120).
 * @returns Single-line, whitespace-normalized, truncated command.
 */
export function summarizeCommand(command: string, maxLen = 120): string {
  if (!command) return "";
  const collapsed = command.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen)}…`;
}
