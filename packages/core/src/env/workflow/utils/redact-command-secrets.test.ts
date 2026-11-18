/**
 * @fileoverview TDD tests for `redactCommandSecrets` (Task #4419, from #4417 §B-1).
 *
 * Background: #4392 P0-2 added this masker so that a failing `Tool exited with
 * code N` message can carry the command that ran without leaking inline
 * credentials into `workflow.node.end` → session messages → next LLM context.
 *
 * #4417 §B-1 found 9 of 14 real-world command shapes still leaked the secret,
 * and a 15th shape (a bare URL) silently *ate* the surrounding quotes. This
 * file pins every shape (leaking + already-correct + must-stay-readable), plus
 * the idempotency promise `redact(redact(x)) === redact(x)`.
 *
 * All secrets are obviously-fake `SEKRET_*` sentinels — never real keys.
 */

import { describe, it, expect } from "bun:test";
import { redactCommandSecrets, summarizeCommand } from "./redact-command-secrets";

/** Every fake secret in these tests starts with this prefix. */
const S = "SEKRET_";

/** Extracts every surviving fake secret from a redacted string. */
function leaks(redacted: string): string[] {
  return redacted.match(new RegExp(`${S}\\w+`, "g")) ?? [];
}

/** Asserts no `SEKRET_*` survived, and that masking is idempotent. */
function expectClean(input: string, expected?: string): string {
  const once = redactCommandSecrets(input);
  expect(leaks(once)).toEqual([]);
  // Idempotency promise: masking an already-masked string is a no-op.
  expect(redactCommandSecrets(once)).toBe(once);
  if (expected !== undefined) {
    expect(once).toBe(expected);
  }
  return once;
}

// =============================================================================
// Group 1 — the 9 leaking shapes from #4417 §B-1 (RED before the fix)
// =============================================================================

describe("redactCommandSecrets: auth header schemes (§B-1 shape 1/2/3/9)", () => {
  it("masks `Authorization: Bearer <token>` (the highest-frequency leak)", () => {
    const out = expectClean(
      'curl -H "Authorization: Bearer SEKRET_sk_cp_abc123def456" https://api.example.com/v1'
    );
    expect(out).toContain("Authorization");
    expect(out).toContain("Bearer");
    expect(out).toContain("https://api.example.com/v1");
  });

  it("masks `Authorization: Basic <base64>`", () => {
    const out = expectClean(
      'curl -H "Authorization: Basic SEKRET_YWQ6bWlucGFzcw==" https://api.example.com'
    );
    expect(out).toContain("Authorization");
    expect(out).toContain("Basic");
  });

  it("masks `--header 'Authorization: Bearer ...'`", () => {
    const out = expectClean(
      "curl --header 'Authorization: Bearer SEKRET_tok_999888777' https://api.example.com"
    );
    expect(out).toContain("Authorization");
    expect(out).toContain("https://api.example.com");
  });

  it("masks `X-Api-Key:` header (already worked — pinned as regression)", () => {
    const out = expectClean(
      'curl -H "X-Api-Key: SEKRET_xapikey_42" https://api.example.com'
    );
    expect(out).toContain("X-Api-Key");
    expect(out).toContain("https://api.example.com");
  });

  it("masks `Authorization: Token <value>` (third scheme variant)", () => {
    expectClean('curl -H "Authorization: Token SEKRET_gh_123abc" https://api.github.com');
  });

  it("preserves diagnostics outside the masked value", () => {
    const out = redactCommandSecrets(
      'curl -sS -X POST -H "Authorization: Bearer SEKRET_zzz" -d @body.json https://api.example.com/upload'
    );
    expect(out).toContain("-sS");
    expect(out).toContain("-X POST");
    expect(out).toContain("-d @body.json");
    expect(out).toContain("https://api.example.com/upload");
    expect(leaks(out)).toEqual([]);
  });
});

describe("redactCommandSecrets: URL query / userinfo (§B-1 shape 4/5)", () => {
  it("masks `?token=` query value", () => {
    const out = expectClean("curl https://api.example.com/v1?token=SEKRET_abcdef123456");
    expect(out).toContain("https://api.example.com/v1?token=");
  });

  it("masks `&api_key=` query value", () => {
    expectClean('curl "https://api.example.com/v1?x=1&api_key=SEKRET_key_987654"');
  });

  it("masks `&secret=` / `&sig=` / `&access_token=` query values", () => {
    expectClean('curl "https://api.example.com/v1?a=1&secret=SEKRET_sec_555"');
    expectClean('curl "https://api.example.com/v1?a=1&sig=SEKRET_sig_777"');
    expectClean('curl "https://api.example.com/v1?a=1&access_token=SEKRET_at_888"');
  });

  it("masks `git clone https://user:TOKEN@host` userinfo", () => {
    const out = expectClean(
      "git clone https://user:SEKRET_ghp_abc123def456@github.com/x/y.git"
    );
    expect(out).toContain("github.com/x/y.git");
    expect(out).toContain("user");
  });

  it("does not touch a URL that merely has a port", () => {
    const input = "curl https://api.example.com:8443/v1/health";
    expect(redactCommandSecrets(input)).toBe(input);
  });

  it("does not touch harmless query params", () => {
    const input = 'curl "https://api.example.com/v1?page=2&limit=50&sort=asc"';
    expect(redactCommandSecrets(input)).toBe(input);
  });
});

describe("redactCommandSecrets: short-option credentials (§B-1 shape 6/7/8)", () => {
  it("masks `curl -u user:pass`", () => {
    const out = expectClean("curl -u admin:SEKRET_SuperSecret123 https://x.com");
    expect(out).toContain("admin:");
    expect(out).toContain("https://x.com");
  });

  it("masks `docker login -p <pw>`", () => {
    const out = expectClean(
      "docker login -p SEKRET_dockerpw -u bob registry.example.com"
    );
    expect(out).toContain("docker login");
    expect(out).toContain("registry.example.com");
  });

  it("masks `mysql -pVALUE` (attached short-option value)", () => {
    const out = expectClean("mysql -u root -pSEKRET_mysqlpw -h db.internal");
    expect(out).toContain("mysql");
    expect(out).toContain("-h db.internal");
  });

  it("`mkdir -p <dir>` must NOT be masked (no over-redaction)", () => {
    const input = "mkdir -p /tmp/build/release && cp -r dist /tmp/build/release";
    expect(redactCommandSecrets(input)).toBe(input);
  });

  it("`mysql -u root` without a colon must NOT be masked", () => {
    const input = "mysql -u root -h db.internal -e 'select 1'";
    expect(redactCommandSecrets(input)).toBe(input);
  });
});

// =============================================================================
// Group 2 — shapes that already worked (must not regress)
// =============================================================================

describe("redactCommandSecrets: assignment / flag shapes already supported", () => {
  it("masks `export API_KEY=...`", () => {
    expectClean("export API_KEY=SEKRET_export1", "export API_KEY=[REDACTED]");
  });

  it("masks `docker run -e PASSWORD=...`", () => {
    expectClean("docker run -e PASSWORD=SEKRET_pw1 img", "docker run -e PASSWORD=[REDACTED] img");
  });

  it("masks `PASSWORD='quoted value'`", () => {
    expectClean("PGPASSWORD='SEKRET_quoted9' psql -c 'select 1'");
  });

  it("masks `--password=value` and `--password value`", () => {
    expectClean("twine upload --password=SEKRET_twine1 dist/*.whl");
    expectClean("twine upload --password SEKRET_twine2 dist/*.whl");
  });

  it("masks `--api-key` / `--token` / `--client-secret`", () => {
    expectClean("tool --api-key SEKRET_a1 --token=SEKRET_a2");
    expectClean("tool --client-secret 'SEKRET_a3'");
  });

  it("masks credential-bearing env prefixes inside a pipeline", () => {
    expectClean("NPM_TOKEN=SEKRET_npm1 npm publish && echo done");
  });
});

// =============================================================================
// Group 3 — no over-redaction on ordinary commands & arguments
// =============================================================================

describe("redactCommandSecrets: ordinary commands stay readable", () => {
  const untouched = [
    "cd /tmp/wheels && ./validate.sh --python cp312",
    "pytest --output /tmp/x.json -v",
    "git commit -m 'fix: mask tokens in error messages'",
    "bun test packages/core/src/env/workflow --parallel 4",
    "docker run --rm -v $PWD:/app -w /app node:20 npm ci",
    "curl -fsSL https://get.example.com/install.sh | sh",
    "ls -la /tmp && echo $HOME",
  ];

  for (const input of untouched) {
    it(`leaves unchanged: ${input.slice(0, 48)}`, () => {
      expect(redactCommandSecrets(input)).toBe(input);
    });
  }
});

// =============================================================================
// Group 4 — structural promises: idempotency, multiline, no corruption
// =============================================================================

describe("redactCommandSecrets: structural promises", () => {
  it("is idempotent across every leaking shape (property-style sweep)", () => {
    const inputs = [
      'curl -H "Authorization: Bearer SEKRET_p1" https://a.example.com',
      'curl -H "Authorization: Basic SEKRET_p2" https://a.example.com',
      "curl https://a.example.com/v1?token=SEKRET_p3",
      'curl "https://a.example.com/v1?a=1&api_key=SEKRET_p4"',
      "git clone https://u:SEKRET_p5@github.com/x/y.git",
      "curl -u admin:SEKRET_p6 https://a.example.com",
      "docker login -p SEKRET_p7 -u bob registry.example.com",
      "mysql -u root -pSEKRET_p8 -h db.internal",
      "export API_KEY=SEKRET_p9",
      "docker run -e PASSWORD=SEKRET_p10 img",
    ];
    for (const input of inputs) {
      const once = redactCommandSecrets(input);
      expect(leaks(once)).toEqual([]);
      expect(redactCommandSecrets(once)).toBe(once);
      expect(redactCommandSecrets(redactCommandSecrets(once))).toBe(once);
    }
  });

  it("does not eat surrounding quotes / punctuation (no corruption)", () => {
    const out = redactCommandSecrets(
      'curl -H "X-Api-Key: SEKRET_q1" "https://api.example.com/v1?a=1&api_key=SEKRET_q2"'
    );
    expect(leaks(out)).toEqual([]);
    // The closing quote of each argument must survive.
    expect((out.match(/"/g) ?? []).length).toBe(4);
    expect(out).toMatch(/\[REDACTED\]"$/);
  });

  it("handles multi-line commands and keeps masking after newlines", () => {
    const out = redactCommandSecrets(
      "set -e\ncurl -H 'Authorization: Bearer SEKRET_m1' https://a.example.com\nmysql -pSEKRET_m2 -e 'select 1'"
    );
    expect(leaks(out)).toEqual([]);
    expect(out).toContain("set -e");
  });

  it("returns empty / whitelist input untouched", () => {
    expect(redactCommandSecrets("")).toBe("");
    expect(redactCommandSecrets("echo hello")).toBe("echo hello");
  });

  it("`[REDACTED]` sentinel is stable and never double-applied", () => {
    expect(redactCommandSecrets("API_KEY=[REDACTED]")).toBe("API_KEY=[REDACTED]");
    expect(
      redactCommandSecrets('curl -H "Authorization: Bearer [REDACTED]" https://a.example.com')
    ).toBe('curl -H "Authorization: Bearer [REDACTED]" https://a.example.com');
  });
});

// =============================================================================
// Group 5 — summarizeCommand stays compatible (used by tool-node)
// =============================================================================

describe("summarizeCommand", () => {
  it("collapses newlines and truncates", () => {
    expect(summarizeCommand("a\n  b\n\tc")).toBe("a b c");
    const long = summarizeCommand("x".repeat(200), 20);
    expect(long.length).toBe(21); // 20 chars + ellipsis
    expect(long.endsWith("…")).toBe(true);
  });

  it("returns empty string for empty input", () => {
    expect(summarizeCommand("")).toBe("");
  });
});

// =============================================================================
// Group 6 — linear-time guarantee (ReDoS / quadratic backtracking guard)
//
// The masker runs on arbitrary tool output, which can legitimately contain
// multi-KB single tokens (a base64 blob, a minified JS line, a long hash). The
// original `ASSIGNMENT_RE` re-scanned the entire token as a *key* once per byte
// (`[A-Za-z0-9_.-]*` retried at every offset), i.e. O(n²) — measured 7954 ms for
// an 80 KB bare word. This is reachable from `stdout tail` because redaction
// happens on the full stdout before slicing.
// =============================================================================
describe("redactCommandSecrets: linear time on pathological input", () => {
  /** Soft ceiling — a linear implementation needs <10 ms; O(n²) needs seconds. */
  const BUDGET_MS = 400;

  const pathological: Array<[string, string]> = [
    ["80KB bare word (no separator)", "a".repeat(80_000)],
    ["80KB dotted token", "a.".repeat(40_000)],
    ["80KB colon chain", "a:".repeat(40_000)],
    ["80KB equals chain", "k=".repeat(40_000)],
    ["80KB query chain", `https://x.example.com/?${"token=".repeat(10_000)}`],
  ];

  for (const [name, input] of pathological) {
    it(`completes under ${BUDGET_MS}ms: ${name}`, () => {
      const started = Date.now();
      redactCommandSecrets(input);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(BUDGET_MS);
    });
  }

  it("still masks correctly after the linear-time rework", () => {
    // Guard against "make it fast by making it not match anything".
    expectClean("export API_KEY=SEKRET_perf1");
    expectClean("POSTGRES_PASSWORD=SEKRET_perf2 psql -c 'select 1'");
    expectClean('curl -H "X-Api-Key: SEKRET_perf3" https://x.example.com');
  });
});

// =============================================================================
// Group 7 — cross-validation findings (Task #4419 xval: C1-C6)
//
// An independent reviewer found that the first cut of the new rules traded one
// class of bugs for another: the bare-value class treated `( ) < >` as
// terminators (so only the secret's prefix got masked — strictly worse than
// before for `PASSWORD=abc(def`), and several heuristics matched far too
// eagerly, corrupting ordinary diagnostic text. Both directions are pinned here.
// =============================================================================

describe("redactCommandSecrets: C1 — the whole secret is masked, not just its prefix", () => {
  // Regression: the bare class stopped at `(` / `)`, leaving the tail in clear.
  const shapes: Array<[string, string]> = [
    ["assignment", "export PASSWORD=abc(def"],
    ["--password=", "twine upload --password=abc(def dist/*.whl"],
    ["bearer header", 'curl -H "Authorization: Bearer abc(def" https://x.com'],
    ["mysql -p", "mysql -pabc(def -h db"],
    ["docker login -p", "docker login -p abc(def -u bob"],
  ];

  for (const [name, input] of shapes) {
    it(`masks the full value: ${name}`, () => {
      const out = redactCommandSecrets(input);
      // No fragment of the secret may survive on either side of the sentinel.
      expect(out).not.toContain("abc");
      expect(out).not.toContain("(def");
      expect(leaks(out)).toEqual([]);
    });
  }

  it("does not leave a redirect target dangling after a masked value", () => {
    const out = redactCommandSecrets("export PASSWORD=abc(def > /tmp/out.log");
    expect(out).not.toContain("abc");
    expect(out).toContain("> /tmp/out.log");
  });
});

describe("redactCommandSecrets: C2 — `psql`/`pg_dump` -p is a PORT, not a password", () => {
  const portShapes = [
    "psql -p 5432 -U alice -d appdb -c 'select 1'",
    "pg_dump -p 5433 mydb",
    "psql -p 5432 -h db.internal -U alice",
  ];

  for (const input of portShapes) {
    it(`leaves intact: ${input}`, () => {
      expect(redactCommandSecrets(input)).toBe(input);
    });
  }
});

describe("redactCommandSecrets: C3 — auth schemes only with real auth context", () => {
  // British-prose false positives: "your token", "Basic authentication".
  const prose = [
    'echo "Please provide your token to continue"',
    'echo "Basic authentication is required"',
    'echo "Digest verification failed"',
    "printf 'token expired, please re-auth\\n'",
  ];

  for (const input of prose) {
    it(`leaves prose intact: ${input}`, () => {
      expect(redactCommandSecrets(input)).toBe(input);
    });
  }

  it("still masks a genuine header without a scheme prefix match on prose", () => {
    expectClean('curl -H "Authorization: Bearer SEKRET_c3a" https://x.example.com');
    expectClean("Authorization: Bearer SEKRET_c3b");
  });
});

describe("redactCommandSecrets: C4 — query names match as whole words, not substrings", () => {
  // "sig" ⊂ "design", "auth" ⊂ "author" — substring matching corrupted these.
  const benign = [
    'curl "https://x.example.com/v1?design=blue"',
    'curl "https://x.example.com/v1?author=jane"',
    'curl "https://x.example.com/v1?tokenizer=utf8"',
    'curl "https://x.example.com/v1?signatureVersion=v4"',
  ];

  for (const input of benign) {
    it(`leaves benign query intact: ${input}`, () => {
      expect(redactCommandSecrets(input)).toBe(input);
    });
  }

  it("still masks real query credentials", () => {
    expectClean('curl "https://x.example.com/v1?sig=SEKRET_c4a"');
    expectClean('curl "https://x.example.com/v1?auth=SEKRET_c4b"');
    expectClean('curl "https://x.example.com/v1?access_token=SEKRET_c4c"');
  });
});

describe("redactCommandSecrets: C5/C6 — narrow, position-aware guards", () => {
  it("leaves `docker run -u uid:gid` intact (not a credential)", () => {
    const input = "docker run --rm -u 1000:1000 alpine echo hi";
    expect(redactCommandSecrets(input)).toBe(input);
  });

  it("leaves a path mentioning mysql intact", () => {
    const input = "cd /opt/mysql && mkdir -p build";
    expect(redactCommandSecrets(input)).toBe(input);
  });

  it("still masks a real mysql -p password after such a path", () => {
    expectClean("cd /opt/mysql && mysql -pSEKRET_c6a -e 'select 1'");
  });

  it("still masks a real `docker login -p` password", () => {
    expectClean("docker login -p SEKRET_c6b -u bob registry.example.com");
  });
});

describe("redactCommandSecrets: -u gating by value shape (not by tool name)", () => {
  it("masks -u credentials even with an env prefix (tool-name whitelist missed this)", () => {
    expectClean("A=1 curl -H 'X: y' https://x.example.com -u a:SEKRET_u1");
    expectClean("TOKEN=x curl -u admin:SEKRET_u2 https://x.example.com");
  });

  it("masks -u credentials after a URL / in the middle of a pipeline", () => {
    expectClean("curl https://x.example.com -u a:SEKRET_u3");
  });

  it("does not treat uid:gid as a credential", () => {
    for (const input of [
      "docker run --rm -u 1000:1000 alpine echo hi",
      "docker exec -u 0:0 ctr id",
    ]) {
      expect(redactCommandSecrets(input)).toBe(input);
    }
  });
});

describe("redactCommandSecrets: C7 — long-form --user and AWS secrets", () => {
  it("masks `curl --user user:pass` (long form was missed)", () => {
    const out = expectClean("curl --user admin:SEKRET_c7a https://x.example.com");
    expect(out).toContain("admin:");
    expect(out).toContain("https://x.example.com");
  });

  it("masks `--user=user:pass`", () => {
    expectClean("curl --user=admin:SEKRET_c7b https://x.example.com");
  });

  it("masks AWS secret access key env prefix and config-style pair", () => {
    expectClean("AWS_SECRET_ACCESS_KEY=SEKRET_c7c aws s3 ls");
    expectClean("aws_secret_access_key = SEKRET_c7d");
  });

  it("leaves a bare `--user` with no colon intact (username only is not a secret)", () => {
    const input = "curl --user alice https://x.example.com";
    expect(redactCommandSecrets(input)).toBe(input);
  });
});

// =============================================================================
// Group 8 — N1/N2: never leak something `main` used to mask (monotonicity)
//
// The performance lookbehind `(?<![A-Za-z0-9_.-])` in ASSIGNMENT_RE was too
// strict: it rejected keys that legitimately start with a digit (`1.PASSWORD`,
// `2token`) because the *preceding* character was part of a token. Separately,
// FLAG_RE's separator `(=|\s+)` did not accept `= ` (equals followed by space),
// so `--password= <v>` stopped matching.
//
// Both were introduced by this branch and both made it leak MORE than main —
// strictly unacceptable for a security fix. The invariant pinned here:
// masking may only ever widen, never narrow, relative to main.
// =============================================================================

describe("redactCommandSecrets: N1/N2 — masked-never-narrowed invariants", () => {
  const regressions = [
    "cmd --password= SEKRET_n1a",
    "cmd --token= SEKRET_n1b",
    "cmd --api-key= SEKRET_n1c",
    "cmd --secret= SEKRET_n1d",
    'cmd --password= "SEKRET_n1e"',
    "1.PASSWORD=SEKRET_n2a",
    "9aws_secret_access_key=SEKRET_n2b",
    "2token=SEKRET_n2c",
  ];

  for (const input of regressions) {
    it(`masks (main did): ${input}`, () => {
      expectClean(input);
    });
  }

  it("still accepts the plain no-space forms", () => {
    expectClean(
      "cmd --password=SEKRET_n1f --token=SEKRET_n1g --api-key=SEKRET_n1h"
    );
  });

  it("still accepts space-separated flag forms", () => {
    expectClean("cmd --password SEKRET_n1i --token SEKRET_n1j");
  });

  it("does not regress ordinary flags into over-masking", () => {
    for (const input of [
      "pytest --output /tmp/x.json -v",
      "curl --compressed -sS https://x.example.com",
      "docker run --rm -v $PWD:/app node:20 npm ci",
    ]) {
      expect(redactCommandSecrets(input)).toBe(input);
    }
  });
});

// =============================================================================
// Group 9 — coverage gaps + polish (cross-validation round 2: N3-N9)
// =============================================================================

describe("redactCommandSecrets: N3 — bare user:pass in auth-failure output", () => {
  // This is exactly the B-2 scenario: a failing script echoes the credential on
  // stdout/stderr without any `-u`/`--user` flag to anchor on.
  it("masks credentials after an auth-failure context word", () => {
    expectClean("curl: auth failed for admin:SEKRET_n3a");
    expectClean("login failed for deploy:SEKRET_n3b (403)");
    expectClean("invalid credentials alice:SEKRET_n3c");
  });

  it("does not touch URL schemes or ordinary headers", () => {
    for (const input of [
      "curl https://x.example.com/v1",
      'curl -H "Content-Type: application/json" https://x.example.com',
      "echo 12:30",
    ]) {
      expect(redactCommandSecrets(input)).toBe(input);
    }
  });
});

describe("redactCommandSecrets: N4 — quoted -p values keep their quotes", () => {
  it("does not leave a dangling quote", () => {
    const out = redactCommandSecrets('mysql -p "SEKRET_n4a" -u root');
    expect(leaks(out)).toEqual([]);
    expect((out.match(/"/g) ?? []).length).toBe(2);
  });

  it("handles single-quoted -p values the same way", () => {
    const out = redactCommandSecrets("mysql -p 'SEKRET_n4b' -u root");
    expect(leaks(out)).toEqual([]);
    expect((out.match(/'/g) ?? []).length).toBe(2);
  });
});

describe("redactCommandSecrets: N6 — more password-flag tools", () => {
  it("masks `helm registry login -p`", () => {
    expectClean("helm registry login -p SEKRET_n6a registry.example.com");
  });

  it("masks `redis-cli -a`", () => {
    expectClean("redis-cli -a SEKRET_n6c ping");
  });

  it("leaves `gsutil cp` / unrelated flags alone", () => {
    for (const input of ["gsutil cp a gs://bucket", "redis-cli -h cache.internal ping"]) {
      expect(redactCommandSecrets(input)).toBe(input);
    }
  });

  // ---- R2 (re-review): 这些工具的 `-p` 不是密码，不能打码 ----
  it("★ `gsutil -p <project>` is --project, not a password", () => {
    const input = "gsutil -p my-gcp-project cp a gs://bucket";
    expect(redactCommandSecrets(input)).toBe(input);
  });

  it("★ `pgcli -p <host>` / `psql -p <port>` are ports, not passwords", () => {
    for (const input of [
      "pgcli -p db.internal -u app",
      "psql -p 5432 -h db.internal",
      "pg_dump -p 5432 mydb",
    ]) {
      expect(redactCommandSecrets(input)).toBe(input);
    }
  });

  it("★ `svn -p` / `htpasswd -p` are not password flags", () => {
    for (const input of [
      "svn -p 9000 co https://svn.example.com/repo",
      "htpasswd -p /etc/nginx/.htpasswd alice",
    ]) {
      expect(redactCommandSecrets(input)).toBe(input);
    }
  });

  it("★ spaced `-a` must not swallow the next flag (tar -a -cf)", () => {
    const input = "redis-cli -h cache -a SEKRET_n6d ping && tar -a -cf out.tar dir";
    const out = expectClean(input);
    // -a 的密码被脱敏，但 tar 的 -cf 必须原样保留
    expect(out).toContain("-a [REDACTED]");
    expect(out).toContain("tar -a -cf out.tar");
  });
});

describe("redactCommandSecrets: N7 — AWS CLI space-separated secret keys", () => {
  it("masks `aws configure set aws_secret_access_key <value>`", () => {
    expectClean("aws configure set aws_secret_access_key SEKRET_n7a");
  });

  it("masks aws_session_token with space separator", () => {
    expectClean("aws configure set aws_session_token SEKRET_n7b");
  });

  it("leaves non-secret aws config keys alone", () => {
    const input = "aws configure set output json";
    expect(redactCommandSecrets(input)).toBe(input);
  });
});

describe("redactCommandSecrets: N9 — `--user root:root` is not a credential", () => {
  it("leaves an identical user:group pair intact", () => {
    const input = "docker run --user root:root alpine id";
    expect(redactCommandSecrets(input)).toBe(input);
  });

  it("still masks a real --user credential", () => {
    expectClean("curl --user admin:SEKRET_n9a https://x.example.com");
  });
});

// =============================================================================
// R1/R3 (re-review 2026-10-21) — 真实泄漏 / 覆盖收窄
// =============================================================================

describe("redactCommandSecrets: R1 — userinfo password containing `@`", () => {
  it("masks the whole password up to the LAST `@` (not just its prefix)", () => {
    const input = "curl https://user:p@ss@host.example.com/x";
    const out = redactCommandSecrets(input);

    expect(out).not.toContain("p@ss");
    expect(out).not.toContain("ss@");
    expect(out).toBe("curl https://user:[REDACTED]@host.example.com/x");
  });

  it("is still idempotent for that shape", () => {
    const once = redactCommandSecrets("curl https://user:p@ss@host/x");
    expect(redactCommandSecrets(once)).toBe(once);
  });
});

describe("redactCommandSecrets: R3 — scheme words must not disable masking", () => {
  it("masks `PASSWORD=token` / `PASSWORD=bearer` (assignment form)", () => {
    for (const input of ["PASSWORD=token", "PASSWORD=bearer", "api_key=digest"]) {
      expectClean(input);
    }
  });

  it("still keeps the scheme word in a real auth header (diagnostic value)", () => {
    const out = expectClean('curl -H "Authorization: Bearer SEKRET_r3a"');
    expect(out).toContain("Authorization");
    expect(out).toContain("Bearer");
  });

  it("is idempotent on the auth-header shape", () => {
    const once = redactCommandSecrets('curl -H "Authorization: Bearer SEKRET_r3b"');
    expect(redactCommandSecrets(once)).toBe(once);
  });
});
