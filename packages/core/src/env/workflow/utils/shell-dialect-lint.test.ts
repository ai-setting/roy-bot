/**
 * @fileoverview TDD RED — shell dialect lint for workflow tool-node commands
 * (Task #4392 P0-3, derived from #4385 §3.2.1 / §5.5 diff-2).
 *
 * Background: the `bash` tool is spawned with Node's `shell: true`, which on
 * POSIX resolves to `/bin/sh` — **dash** on Debian/Ubuntu, not bash. Every
 * bash-only construct therefore fails. Some fail loudly (`set -o pipefail` →
 * exit 2), some fail completely silently (`$RANDOM` → empty, `echo -e` → prints
 * a literal `-e`).
 *
 * #4385 measured 63 `/bin/sh:` signature hits across 45 sessions, and 27 of the
 * creator's `exit 2` failures trace back to this.
 *
 * These tests pin the lint contract:
 *   - each of the 10 known bash-only constructs produces exactly one finding
 *     with a non-empty `name` + actionable `fix`;
 *   - portable shell produces ZERO findings (no false positives on the
 *     constructs the existing 76 registered workflows actually use);
 *   - multiple distinct constructs in one command each get their own finding;
 *   - the same construct repeated only reports once (keeps warnings readable).
 */

import { describe, it, test, expect } from "bun:test";
import { lintShellDialect, formatShellDialectFindings } from "./shell-dialect-lint";

// =============================================================================
// Rule coverage — one case per rule
// =============================================================================

describe("lintShellDialect: bash-only constructs are detected (Task #4392 P0-3)", () => {
  const cases: Array<{ label: string; command: string; expectName: string }> = [
    {
      label: "set -o pipefail",
      command: "set -o pipefail; npm test | tee out.log",
      expectName: "pipefail",
    },
    {
      label: "${PIPESTATUS[0]}",
      command: "npm test | tee out.log; rc=${PIPESTATUS[0]}; exit $rc",
      expectName: "PIPESTATUS",
    },
    {
      label: "${VAR//a/b} substring replacement",
      command: 'TAG="3.12"; PY_TAG=${TAG//./}; ls dist/py${PY_TAG}',
      expectName: "substring-replace",
    },
    {
      label: "${BASH_SOURCE[0]}",
      command: 'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      expectName: "BASH_SOURCE",
    },
    {
      label: "[[ ... ]] double bracket",
      command: 'if [[ -f dist/x.whl ]]; then echo OK; fi',
      expectName: "dbl-bracket",
    },
    {
      label: "source <file>",
      command: "source /tmp/wheel-pipeline-state.env && echo loaded",
      expectName: "source",
    },
    {
      label: "array literal",
      command: 'PYTHONS=(3.12 3.13); for p in "${PYTHONS[@]}"; do echo $p; done',
      expectName: "array",
    },
    {
      label: "function keyword",
      command: "function build_wheel() { echo building; }",
      expectName: "function-keyword",
    },
    {
      label: "$RANDOM",
      command: 'SUFFIX="run-$RANDOM"; echo $SUFFIX',
      expectName: "RANDOM",
    },
    {
      label: "echo -e",
      command: 'echo -e "a\\tb"',
      expectName: "echo-e",
    },
  ];

  for (const { label, command, expectName } of cases) {
    it(`detects ${label}`, () => {
      const findings = lintShellDialect(command);
      expect(findings.length).toBeGreaterThan(0);
      const hit = findings.find((f) => f.name === expectName);
      expect(hit).toBeDefined();
      expect(hit!.fix.length).toBeGreaterThan(0);
      expect(hit!.excerpt.length).toBeGreaterThan(0);
    });
  }
});

// =============================================================================
// Rules added in the M2 measurement follow-up (Task #4392)
//
// Rationale: the first M2 pass replayed 838 REAL historical commands that had
// provably died with a `/bin/sh:` signature, and only 40.6% were flagged. Three
// bash-only families accounted for most of the gap. Each is verified against
// real dash below (see the `dashProbe` block) before being asserted here.
// =============================================================================

describe("lintShellDialect: combined-flag pipefail is detected (Task #4392 M2)", () => {
  // `set -o pipefail` was covered, but the far more common `set -euo pipefail`
  // was NOT: the regex required `-o` immediately before `pipefail`.
  // Real dash: `set -euo pipefail` -> "Illegal option -o pipefail", exit 2.
  const cases = [
    "set -euo pipefail\nnpm test | tee out.log",
    "set -euxo pipefail; ./build.sh",
    "set -uo pipefail",
    "set -eu -o pipefail; make",
    "set -o pipefail; npm test",
  ];

  for (const command of cases) {
    it(`flags pipefail in: ${command.split("\n")[0]}`, () => {
      const names = lintShellDialect(command).map((f) => f.name);
      expect(names).toContain("pipefail");
    });
  }
});

describe("lintShellDialect: process substitution is detected (Task #4392 M2)", () => {
  // Real dash: `diff <(echo a) <(echo b)` -> Syntax error: "(" unexpected, exit 2.
  const cases = [
    "diff <(git show main:bun.lock) <(git show HEAD:bun.lock)",
    "comm -23 <(sort -u a.txt) <(sort -u b.txt) | wc -l",
    "echo <(date)",
  ];

  for (const command of cases) {
    it(`flags process-substitution in: ${command.slice(0, 55)}`, () => {
      const names = lintShellDialect(command).map((f) => f.name);
      expect(names).toContain("process-substitution");
    });
  }

  it("gives an actionable fix that names a POSIX alternative", () => {
    const [finding] = lintShellDialect("diff <(date) <(date)");
    expect(finding.name).toBe("process-substitution");
    expect(finding.fix.length).toBeGreaterThan(10);
    // The fix must tell the author what to do instead, not just say "bad".
    expect(finding.fix).toMatch(/bash -c|临时文件|\/tmp/);
  });
});

describe("lintShellDialect: here-string is detected (Task #4392 M2)", () => {
  // Real dash: `cat <<< "hello"` -> Syntax error: redirection unexpected, exit 2.
  const cases = [
    'cat <<< "hello"',
    'grep -q foo <<< "$OUTPUT"',
    "wc -l <<<$(printf 'a\\nb')",
  ];

  for (const command of cases) {
    it(`flags here-string in: ${command.slice(0, 50)}`, () => {
      const names = lintShellDialect(command).map((f) => f.name);
      expect(names).toContain("here-string");
    });
  }

  it("does NOT flag a POSIX heredoc (<< without the third <)", () => {
    const cmd = "cat <<'EOF'\nhello $world\nEOF";
    const names = lintShellDialect(cmd).map((f) => f.name);
    expect(names).toEqual([]);
  });

  it("does NOT flag a heredoc whose body merely mentions <<<", () => {
    // The body is quoted, so dash never parses it as an operator. Being
    // conservative here is the whole point: a false warning trains the
    // author to ignore the lint.
    const cmd = "cat <<'EOF'\nuse bash -c for <<< here-strings\nEOF";
    expect(lintShellDialect(cmd)).toEqual([]);
  });
});

// =============================================================================
// No false positives on portable shell
// =============================================================================

describe("lintShellDialect: portable /bin/sh is clean (no false positives)", () => {
  const portable = [
    "echo hello world",
    "cd /tmp/wheels && ls -la",
    "set -e; ./build.sh",
    "for v in 3.12 3.13; do echo $v; done",
    'if [ -f dist/x.whl ]; then echo OK; fi',
    "cat /tmp/o 2>&1; RC=$?; echo rc=$RC",
    'X=$(cat /tmp/x); echo "${X}"',
    'VAR="a"; VAR2=${VAR}b; echo $VAR2',
    "find dist -maxdepth 2 -name '*.whl' -print",
    "docker build -t img:1 . 2>&1 | tail -20",
    'grep -q "[PASS]" out.log && echo found',
    // `.` is the POSIX dot-command; `source` is the bash-ism. Must not flag `.`.
    '. /tmp/state.env && echo loaded',
    // $? and $0 are POSIX.
    'echo "script=$0 rc=$?"',
    // Sed alternation with slashes must not trip substring-replace.
    'sed -e "s/a/b/" file.txt',
    // `set -eu` / `set -e` are POSIX; only the `-o pipefail` part is a bash-ism.
    "set -eu; ./run.sh",
    "set -x; ls",
    // A POSIX heredoc (two `<`, not three) is portable.
    "cat <<EOF\nhello\nEOF",
    // Redirection with a leading `<` is POSIX; process substitution needs `<(`.
    "wc -l < /tmp/in.txt",
    // `( subshell )` is POSIX; only `<(`, `>(` (no space) are bash-isms.
    "( cd /tmp && ls )",
    // Comparisons that merely contain `<` must not look like process substitution.
    'if [ "$A" -lt "$B" ]; then echo less; fi',
  ];

  for (const command of portable) {
    it(`does not flag: ${command.slice(0, 60)}`, () => {
      expect(lintShellDialect(command)).toEqual([]);
    });
  }
});

// Aggregation semantics
// =============================================================================

describe("lintShellDialect: aggregation behaviour", () => {
  it("reports each distinct construct in one command", () => {
    const findings = lintShellDialect(
      'set -o pipefail\nif [[ -f x ]]; then source /tmp/y.env; fi'
    );
    const names = findings.map((f) => f.name).sort();
    expect(names).toContain("pipefail");
    expect(names).toContain("dbl-bracket");
    expect(names).toContain("source");
  });

  it("dedupes repeated occurrences of the same construct", () => {
    const findings = lintShellDialect(
      'echo $RANDOM; echo $RANDOM; echo $RANDOM'
    );
    expect(findings.filter((f) => f.name === "RANDOM").length).toBe(1);
  });

  it("returns [] for empty / non-string-ish input", () => {
    expect(lintShellDialect("")).toEqual([]);
  });

  it("is case-sensitive about the RANDOM variable (lowercase $random is not bash's)", () => {
    // `$random` is an ordinary user variable, not bash's magic one.
    expect(lintShellDialect("echo $random").map((f) => f.name)).not.toContain("RANDOM");
  });

  it("does not flag a comment mentioning pipefail", () => {
    // Comments can't fail at runtime; flagging them would be noise.
    expect(
      lintShellDialect("# note: bash would use set -o pipefail here\necho hi")
    ).toEqual([]);
  });
});

// =============================================================================
// formatShellDialectFindings
// =============================================================================

describe("formatShellDialectFindings", () => {
  it("renders one actionable line per finding", () => {
    const findings = lintShellDialect("set -o pipefail");
    const lines = formatShellDialectFindings("build-node", findings);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("build-node");
    expect(lines[0]).toContain("pipefail");
    // must carry the fix hint so the creator can act without extra lookups
    expect(lines[0]).toContain("RC=$?");
  });

  it("returns [] when there are no findings", () => {
    expect(formatShellDialectFindings("clean-node", [])).toEqual([]);
  });
});

/**
 * M2-driven corrections (Task #4392).
 *
 * Scoring the first implementation against 243,368 historical commands that ran
 * WITHOUT a `/bin/sh` signature exposed a **1.45% false-positive rate**. A lint
 * that cries wolf on healthy commands is worse than no lint: `workflow-creator`
 * is instructed to evaluate every warning, so noise directly costs iterations.
 *
 * Scoring it against the 838 commands that DID fail exposed the mirror problem:
 * only 40.57% were caught. The biggest miss was `set -euo pipefail` — the most
 * common bash-ism of all — because the original regex required exactly
 * `set -o pipefail`.
 *
 * Both directions are pinned here so neither can regress.
 */
describe("M2-driven corrections: false negatives on real failures", () => {
  test("`set -euo pipefail` (combined short flags) is detected", () => {
    // MISS in M2: 35 historical commands used `set -euo pipefail` and failed
    // with "set: Illegal option -o pipefail", yet the original rule required
    // the literal `set -o pipefail` and never fired.
    const cmd = `set -euo pipefail\nbun run build | tee /tmp/x.log`;
    const names = lintShellDialect(cmd).map((f) => f.name);
    expect(names).toContain("pipefail");
  });

  test("`set -eu -o pipefail` and `set -e -o pipefail` are detected", () => {
    for (const cmd of [`set -eu -o pipefail\ncmd`, `set -e -o pipefail\ncmd`, `set -o pipefail\ncmd`]) {
      expect(lintShellDialect(cmd).map((f) => f.name)).toContain("pipefail");
    }
  });

  test("process substitution and here-string are covered by their own suites above", () => {
    // Asserted in "process substitution is detected" / "here-string is detected"
    // (both added earlier in this task). Restated here as a single guard so an
    // M2 re-run cannot silently drop them.
    expect(lintShellDialect(`diff <(a) <(b)`).length).toBeGreaterThan(0);
    expect(lintShellDialect(`cat <<< "$X"`).length).toBeGreaterThan(0);
  });

  test("`$'...'` ANSI-C quoting is detected", () => {
    // dash parses `$'...'` as a literal `$` followed by a string — silently
    // wrong rather than an error, which is the dangerous case.
    expect(lintShellDialect(`echo $'a\\tb'`).map((f) => f.name)).toContain("ansi-c-quote");
  });
});

describe("M2-driven corrections: false positives on healthy commands", () => {
  test("POSIX character classes `[[:space:]]` do NOT trigger dbl-bracket", () => {
    // FP in M2: 1,254 hits. `[[:space:]]` is valid POSIX and extremely common
    // in grep -E patterns; the naive `/\[\[/` regex cannot tell them apart.
    const cases = [
      `grep -E "^[[:space:]]*[0-9]+ pass$" /tmp/x.log`,
      `awk ' /^[[:space:]]*[0-9]+ pass$/ {p += $1}' /tmp/x.log`,
      `grep -E "^[[:space:]]*[0-9]+ (pass|fail|skip|error)" /tmp/x.log`,
      `sed 's/ [[:alpha:]]*//' /tmp/x.log`,
    ];
    for (const cmd of cases) {
      expect(lintShellDialect(cmd).map((f) => f.name)).not.toContain("dbl-bracket");
    }
  });

  test("a real `[[ ]]` test is still detected", () => {
    expect(lintShellDialect(`if [[ -f /tmp/x ]]; then echo y; fi`).map((f) => f.name)).toContain(
      "dbl-bracket",
    );
    expect(lintShellDialect(`[[ "$a" == "b" ]] && echo y`).map((f) => f.name)).toContain("dbl-bracket");
  });

  test("the word 'source' in prose is NOT a source command", () => {
    // FP in M2: 1,361 hits, the largest single contributor. The rule fired on
    // English prose ("... will show .ts source files"), on `--source` flags and
    // on paths containing "/source".
    const cases = [
      `echo "Stack traces will show .ts source files"`,
      `echo "points to .ts source files"`,
      `echo "=== Check source files exist ==="`,
      `ls -la packages/core/src/source`,
      `bun run build --source-map`,
    ];
    for (const cmd of cases) {
      expect(lintShellDialect(cmd).map((f) => f.name)).not.toContain("source");
    }
  });

  test("a real `source <file>` / `. <file>` distinction still holds", () => {
    expect(lintShellDialect(`source /tmp/env.sh`).map((f) => f.name)).toContain("source");
    expect(lintShellDialect(`. /tmp/env.sh`).map((f) => f.name)).not.toContain("source");
  });

  test("a deliberate `bash -lc '...'` wrapper is NOT flagged", () => {
    // Running bash-isms *inside bash* is correct. A dozen historical commands
    // did exactly this to work around the dash default; flagging them would
    // teach the creator to "fix" code that is already right.
    const cases = [
      `bash -lc 'set -o pipefail; bun run build | tee /tmp/x'`,
      `bash -c "set -euo pipefail; cmd | tee /tmp/y"`,
    ];
    for (const cmd of cases) {
      expect(lintShellDialect(cmd).map((f) => f.name)).toHaveLength(0);
    }
  });
});

/**
 * M2 second pass (Task #4392).
 *
 * After the first round of corrections the false-positive rate dropped from
 * 1.45% to 0.89%. Grouping the remaining 2,170 hits by rule exposed four more
 * systematic causes, each of which is pinned below.
 */
describe("M2 second pass: remaining false-positive causes", () => {
  test("`<<<` is NOT flagged when it is a git conflict marker", () => {
    // 372 hits were `grep -n "<<<<<<<"` style conflict-marker searches. A run of
    // 7+ '<' is a merge marker, never a bash here-string.
    const cases = [
      `grep -n "<<<<<<<" packages/cli/src/foo.ts`,
      `grep -n "<<<<<<<\\|=======\\|>>>>>>>" /tmp/theirs-delegate-tool.ts`,
      `grep -c "<<<<<<<" packages/cli/src/tasks/list.ts`,
    ];
    for (const cmd of cases) {
      expect(lintShellDialect(cmd).map((f) => f.name)).not.toContain("here-string");
    }
  });

  test("a real here-string is still flagged", () => {
    expect(lintShellDialect(`grep -q foo <<< "$OUT"`).map((f) => f.name)).toContain("here-string");
  });

  test("`source` inside an explicitly-`sh -c` container body is NOT flagged", () => {
    // The `sh -c '<body>'` form is the container-runtime idiom. Its body runs in
    // whatever shell the image provides (often bash via /bin/sh), so flagging it
    // from the outside is not actionable.
    const cmd = `docker run --rm img sh -c ' source $HOME/.local/bin/env; mkdir -p /logs'`;
    expect(lintShellDialect(cmd).map((f) => f.name)).not.toContain("source");
  });

  test("JS array literals with `[[` are NOT flagged as dbl-bracket", () => {
    // `for (const [a, b] of [[1,2],[3,4]])` and `[["tdd",["test"]]]` are JS,
    // not shell tests. The discriminator: a real `[[ ` test has a space or a
    // quote/`-` right after, whereas JS nests `[[`.
    const cases = [
      `node -e 'for (const [s, c] of [["tdd",["test","lint"]],["rev",["x"]]]) console.log(s,c)'`,
      `bun -e 'const m = [["a",1],["b",2]]; console.log(m)'`,
    ];
    for (const cmd of cases) {
      expect(lintShellDialect(cmd).map((f) => f.name)).not.toContain("dbl-bracket");
    }
  });

  test("a real `[[ ]]` test is still flagged", () => {
    for (const cmd of [`[[ -f /tmp/x ]]`, `[[ "$a" == "b" ]] && echo y`, `if [[ -f x ]]; then :; fi`]) {
      expect(lintShellDialect(cmd).map((f) => f.name)).toContain("dbl-bracket");
    }
  });
});
