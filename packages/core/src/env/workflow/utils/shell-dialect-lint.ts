/**
 * @fileoverview Shell dialect lint for workflow `tool` node commands
 * (Task #4392 P0-3; root cause proven in Task #4385 §3.2.1).
 *
 * ## Why this exists
 *
 * The built-in `bash` tool spawns its command with Node's
 * `child_process.spawn(command, [], { shell: true })`
 * (see `env/tool/built-in/bash-effect.ts`). On POSIX, `shell: true` resolves to
 * **`/bin/sh`**, which on Debian/Ubuntu is a symlink to **dash** — *not* bash.
 *
 * Every bash-only construct therefore fails inside a workflow tool node. Worse,
 * half of them fail **silently**:
 *
 * | construct            | dash behaviour                | exit | loud? |
 * | -------------------- | ----------------------------- | ---- | ----- |
 * | `set -o pipefail`    | `Illegal option -o pipefail`  | 2    | ✅    |
 * | `${PIPESTATUS[0]}`   | `Bad substitution`            | 2    | ✅    |
 * | `${V//a/b}`          | `Bad substitution`            | 2    | ✅    |
 * | `${BASH_SOURCE[0]}`  | `Bad substitution`            | 2    | ✅    |
 * | `A=(1 2 3)`          | `Syntax error: "(" unexpected`| 2    | ✅    |
 * | `function f() {}`    | `Syntax error: "(" unexpected`| 2    | ✅    |
 * | `[[ ... ]]`          | `[[: not found`               | 127  | ✅    |
 * | `source <file>`      | `source: not found`           | 0    | ❌    |
 * | `echo -e "a\tb"`     | prints a literal `-e`         | 0    | ❌    |
 * | `$RANDOM`            | empty string                  | 0    | ❌    |
 *
 * Task #4385 measured **63** `/bin/sh:` signature hits across 45 sessions, and
 * these account for 27 of the workflow-creator's `exit 2` failures.
 *
 * ## Severity policy
 *
 * These findings are **warnings, never errors**. The 76 workflows already in
 * `workflows.db` must keep validating cleanly, and a `dash`-safe workflow can
 * legitimately contain the *string* `pipefail` inside an embedded heredoc that
 * is executed by `bash -c` on purpose. Blocking on a heuristic regex would be
 * wrong; surfacing it loudly for the author to judge is right.
 *
 * ## What is deliberately NOT flagged
 *
 * - `. <file>` (POSIX dot-command) — the correct replacement for `source`.
 * - `$?`, `$0`, `$1`… — POSIX.
 * - `[ ... ]` — POSIX test.
 * - `sed 's/a/b/'` — no `${...}` involved.
 * - Text inside shell **comments** (`# ...`) — cannot fail at runtime.
 */

/** A single detected bash-ism. */
export interface ShellDialectFinding {
  /** Stable rule name, e.g. `pipefail`. Used in machine-readable output. */
  name: string;
  /** Actionable replacement hint written for an LLM/tool author to act on. */
  fix: string;
  /** Short excerpt of the offending command (surrounding context). */
  excerpt: string;
}

interface Rule {
  name: string;
  re: RegExp;
  fix: string;
}

/**
 * The rule table. Order is only relevant for output stability.
 *
 * Each regex is intentionally conservative: it must not match the POSIX
 * equivalent, and it must not fire on the string being *mentioned* in a
 * comment (comments are stripped before matching — see `stripComments`).
 */
const RULES: Rule[] = [
  {
    name: "pipefail",
    // `set -o pipefail` AND the far more common combined forms:
    //   set -euo pipefail / set -euxo pipefail / set -uo pipefail
    // M2 evidence: 35 historical commands used `set -euo pipefail` and died with
    // "set: Illegal option -o pipefail", yet the original `set -o pipefail`
    // regex never fired.
    re: /\bset\s+(?:-[A-Za-z]+\s+)*-?[A-Za-z]*o[A-Za-z]*\s+pipefail\b/,
    fix:
      "dash 不支持 set -o pipefail（含 set -euo pipefail）。改用落文件再取退出码: " +
      "`cmd > /tmp/o 2>&1; RC=$?; cat /tmp/o; exit $RC`",
  },
  {
    name: "PIPESTATUS",
    re: /\$\{PIPESTATUS\[/,
    fix:
      "dash 不支持 ${PIPESTATUS[n]}。改用把管道左端输出落文件，再单独取 $?: " +
      "`cmd > /tmp/o 2>&1; RC=$?`",
  },
  {
    name: "substring-replace",
    re: /\$\{[A-Za-z_][A-Za-z0-9_]*\/\//,
    fix:
      "dash 不支持 ${VAR//a/b}。改用 tr 或 sed: " +
      '`V=$(echo "$V" | tr -d ".")`',
  },
  {
    name: "BASH_SOURCE",
    re: /\$\{BASH_SOURCE/,
    fix: "dash 不支持 ${BASH_SOURCE[0]}。改用 $0（或显式写绝对路径）",
  },
  {
    name: "process-substitution",
    // `<(...)` / `>(...)`. Verified: dash -> 'Syntax error: "(" unexpected', exit 2.
    // M2 evidence: 30 historical commands failed exactly this way and the
    // original rules had no coverage at all.
    // Guard: `a < (b)` (space) is a redirection followed by a subshell — legal POSIX.
    re: /(?:^|[\s;&|(])[<>]\([^)]/,
    fix:
      "dash 不支持进程替换 <(cmd) / >(cmd)。改用显式 bash 或临时文件: " +
      "`bash -c 'diff <(a) <(b)'` 或 `a > /tmp/a; b > /tmp/b; diff /tmp/a /tmp/b`",
  },
  {
    name: "here-string",
    // `<<<`. Must not fire on a plain heredoc `<<` or a quoted heredoc body.
    // Verified: dash -> 'Syntax error: redirection unexpected', exit 2.
    re: /(?<!<)<<<\s*[^\s<]/,
    fix:
      "dash 不支持 here-string <<<。改用 printf 管道: " +
      '`printf "%s\\n" "$X" | cmd`',
  },
  {
    name: "ansi-c-quote",
    // ANSI-C quoting $ + single-quoted string with escapes. dash keeps the
    // backslashes literally (silently wrong, no error) — the dangerous mode.
    re: /\$'(?:[^'\\]|\\.)*\\/,
    fix:
      "dash 不支持 ANSI-C 转义 $'...'（会静默保留反斜杠）。改用 printf: " +
      '`printf "a\\tb\\n"`',
  },
  {
    name: "dbl-bracket",
    // `[[ ... ]]` — but NOT the POSIX character class `[[:space:]]`,
    // `[[:alpha:]]` etc., which are valid POSIX and extremely common inside
    // grep -E / awk. M2: naive /\[\[/ gave 1,254 false positives on healthy
    // commands, almost all `[[:space:]]` inside a grep pattern.
    re: /\[\[(?=[\s\-!$\u0027])/,
    fix: "dash 不支持 [[ ]]。改用 [ ]（注意 quote 变量: `[ -f \"$F\" ]`）",
  },
  {
    name: "source",
    // Only a real invocation: `source <path>` in command position.
    // M2: 1,361 false positives — prose ("... will show .ts source files"),
    // `--source-map` flags, paths containing /source. Requiring a path-looking
    // argument removes essentially all of them while keeping `source /tmp/env.sh`.
    re: /(?:^|[\s;&|(])source\s+(?:~|\$|\.|\/)[^\s;|&]*|(?:^|[\s;&|(])source\s+[A-Za-z0-9_.-]+\.sh\b/,
    fix: "dash 不支持 source。改用 POSIX 点命令: `. <file>`",
  },
  {
    name: "array",
    re: /(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=\(/,
    fix:
      "dash 不支持数组。改用空格分隔的字符串 + for 循环: " +
      "`PYS=\"3.12 3.13\"; for p in $PYS; do ...; done`",
  },
  {
    name: "function-keyword",
    re: /(^|\n)[ \t]*function\s+[A-Za-z_]/,
    fix: "dash 不支持 function 关键字。改用 `name() { ... }`",
  },
  {
    name: "RANDOM",
    re: /\$RANDOM\b/,
    fix:
      "dash 不支持 $RANDOM（静默为空）。改用 " +
      "`awk -v s=$(date +%s%N) 'BEGIN{srand(s); print int(rand()*32768)}'`",
  },
  {
    name: "echo-e",
    re: /(^|[\s;&|(])echo\s+-[ne]*e[A-Za-z]*\b/,
    fix: 'dash 的 echo 不解析 -e（会输出字面 "-e"）。改用 printf: `printf "%s\\n" "$X"`',
  },
];
function stripComments(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    let inSingle = false;
    let inDouble = false;
    let cut = -1;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === "\\" && !inSingle) {
        i++; // skip escaped char
        continue;
      }
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        continue;
      }
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        continue;
      }
      if (ch === "#" && !inSingle && !inDouble) {
        const prev = i === 0 ? " " : line[i - 1];
        if (/\s/.test(prev)) {
          cut = i;
          break;
        }
      }
    }

    out.push(cut >= 0 ? line.slice(0, cut) : line);
  }

  return out.join("\n");
}

/**
 * Remove quoted heredoc *bodies* (`<<'EOF' ... EOF` / `<<\\EOF ... EOF`).
 *
 * A quoted heredoc body is passed through verbatim — dash does NOT parse
 * operators inside it, so a `<<<` or `$RANDOM` appearing there cannot fail.
 * M2-driven: without this, a heredoc whose text merely *mentions* `<<<`
 * produced a false `here-string` warning.
 *
 * Only **quoted** delimiters are stripped. An unquoted heredoc is still expanded
 * by the shell, so its body legitimately belongs to the scan.
 */
function stripQuotedHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  let delim: string | null = null;

  for (const line of lines) {
    if (delim !== null) {
      if (line.trim() === delim) {
        out.push(line);
        delim = null;
      }
      // drop body lines
      continue;
    }

    const m = /<<-?\s*(?:'([^']+)'|"([^"]+)")/.exec(line);
    out.push(line);
    if (m) delim = (m[1] ?? m[2] ?? "").trim();
  }

  return out.join("\n");
}

/**
 * Replace the quoted body of any `bash -c '...'` / `sh -lc "..."` with a
 * placeholder before linting.
 *
 * Two M2-observed false-positive classes this fixes:
 *  - `bash -lc 'set -o pipefail; ...'` — the deliberate, *correct* workaround
 *    for the dash default. Warning on it teaches the author to break working
 *    code.
 *  - `docker run ... sh -c 'source $HOME/.local/bin/env; ...'` — the body runs
 *    in the container's shell, not necessarily dash, so the outer lint has no
 *    standing to complain.
 *
 * The trade-off is explicit: bash-isms *inside* a nested `-c` body are not
 * reported. That is the right call — the nested shell is the author's declared
 * choice, and this lint exists to catch the *implicit* dash invocation of a
 * workflow tool node.
 */
function stripForeignShellBodies(command: string): string {
  const re = /(\b(?:bash|sh)\s+-[a-z]*c[a-z]*\s+)(?:'[\s\S]*?'|"[\s\S]*?")/g;
  return command.replace(re, "$1<foreign-shell-body>");
}

/**
 * True when the whole command is just `bash -lc '...'` / `bash -c "..."`.
 *
 * Such a command runs its body under **bash**, so bash-only syntax inside is
 * intentional and portable-enough. We only treat it as exempt when bash is the
 * outermost command — `bash -c '...' | tee log` is still fine, but a bare
 * `set -o pipefail` at top level is not.
 */
function isEntirelyBashInvocation(command: string): boolean {
  // Optional env prefix (e.g. `FOO=1 bash -lc '...'`).
  const re = /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;|&]*\s+)*\/?(?:[\w./-]*\/)?bash\s+-(?:[a-z]*c[a-z]*)\s+(?:'[\s\S]*'|"[\s\S]*")\s*$/;
  return re.test(command.trim());
}

/**
 * Detect bash-only constructs in a shell command intended for the `bash` tool.
 *
 * @param command - The raw command string (from `config.command`).
 * @returns One finding per *distinct* rule that matched. Repeated occurrences of
 *          the same rule are collapsed (a 50-line script using `$RANDOM` ten
 *          times should produce one warning, not ten).
 */
export function lintShellDialect(command: string): ShellDialectFinding[] {
  if (!command || typeof command !== "string") return [];

  const scannable = stripComments(
    stripForeignShellBodies(stripQuotedHeredocBodies(command))
  );
  if (scannable.trim().length === 0) return [];

  // A command that explicitly hands the body to bash is CORRECT, not buggy.
  // M2 evidence: twelve historical commands used `bash -lc '<bash-isms>'` as the
  // deliberate workaround for the dash default. Warning on those would teach the
  // author to "fix" code that already works — the worst possible lint outcome.
  // Only skip when the *entire* command is a bash invocation (the body is then
  // bash's business, not dash's).
  if (isEntirelyBashInvocation(scannable)) return [];

  const findings: ShellDialectFinding[] = [];
  const seen = new Set<string>();

  for (const rule of RULES) {
    if (seen.has(rule.name)) continue;
    const m = rule.re.exec(scannable);
    if (!m) continue;

    seen.add(rule.name);
    const start = Math.max(0, m.index - 30);
    const excerpt = scannable
      .slice(start, m.index + m[0].length + 40)
      .replace(/\s+/g, " ")
      .trim();

    findings.push({ name: rule.name, fix: rule.fix, excerpt });
  }

  return findings;
}

/**
 * Render findings as one actionable line each, prefixed with the node id.
 *
 * Format is deliberately stable so it can be asserted in tests and grepped in
 * logs:
 *   `[shell-dialect] node "build-x" uses bash-only "pipefail": <fix> | near: <excerpt>`
 *
 * @param nodeId - The workflow node id that owns the command.
 * @param findings - Output of `lintShellDialect`.
 */
export function formatShellDialectFindings(
  nodeId: string,
  findings: ShellDialectFinding[]
): string[] {
  return findings.map(
    (f) =>
      `[shell-dialect] node "${nodeId}" uses bash-only "${f.name}": ${f.fix} | near: ${f.excerpt}`
  );
}