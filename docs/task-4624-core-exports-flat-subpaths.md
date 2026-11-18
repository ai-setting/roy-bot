# Task #4624 — core `exports` map: flat-file sub-paths

Status: **fix shipped** — `core` / `cli` 1.7.62, plugin 0.7.2
(cross-validation round 1 found a plugin Stop-hook regression introduced by the
parent task; fixed and shipped in 0.7.2 — see the last section).
Date: 2026-10-29.

## Symptom

The published `@ai-setting/roy-bot-cli` (1.7.59 / 1.7.61) died at runtime with

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'.../node_modules/@ai-setting/roy-bot-core/dist/env/error-reply/index.js'
```

as soon as a module that deep-imports a core **file** sub-path was loaded.

## Root cause (measured, not inferred)

`packages/core/package.json` publishes directory-shaped patterns:

```json
"./*":   { "import": "./dist/*/index.js" },
"./*/*": { "import": "./dist/*/*/index.js" }
```

`bunup.config.ts` only listed `src/**/index.ts` (+ `src/utils/**/index.ts`) as
entries, so `bunup` emitted exactly one `dist/<dir>/index.js` per source
directory — never `dist/<file>.js`.

A specifier such as `@ai-setting/roy-bot-core/env/error-reply` therefore
matched `./*/*` and resolved to `dist/env/error-reply/index.js`, which does not
exist.

**Rejected fix: an exports array with a fallback.**

```json
"./*": { "import": ["./dist/*/index.js", "./dist/*.js"] }
```

Node's `exports` arrays are *not* "try each candidate" — the first candidate is
selected and, if the target file is missing, the resolver throws. Measured in
`/tmp` with a minimal package on node 24: `ERR_MODULE_NOT_FOUND`, no fallback.

## Fix

1. `packages/core/bunup.config.ts` — the 12 flat sources that a host imports by
   name are now explicit entries, so each produces a real `dist/<path>.js`:

   ```
   env/error-reply                     env/event-source/idempotency-key
   env/lark-mention-utils              env/task/delegate/delegate-tool
   env/tool/types                      env/log-trace/logger
   env/event-source/event-store        env/agent/agent-component
   env/event-source/cli-command-handler  env/task/plugins/lark-card-patch-notifier
   env/event-source/event-source-handlers  test-utils/child-process-mock
   ```

2. `packages/core/package.json` — an explicit `exports` entry per flat
   sub-path (`import` → `./dist/<path>.js`, `types` → `./dist/<path>.d.ts`).
   The `.d.ts` files already existed; `tsc -p tsconfig.dts.json` emits the full
   tree.

`env/task/plugins/lark-card-patch-notifier` is the twelfth: the handover note
counted 11 and had classified it as a directory. It is a file, and before this
change it resolved to the same non-existent `.../index.js`.

## Guard (TDD: RED first, then GREEN)

`packages/core/src/env/task/exports-flat-subpaths.test.ts` asserts, for every
flat sub-path:

- the source file exists,
- `bunup.config.ts` lists it as an entry,
- `package.json#exports` has an explicit entry pointing at `dist/<path>.js`
  and `dist/<path>.d.ts`,
- after a build, both files exist on disk,
- **a real `node` subprocess** can `import()` all of them through Node's
  self-reference resolution (bun runs the test, so `process.execPath` would
  not exercise Node's resolver — the test spawns `node`).

## Verification actually run

| Check | Result |
| --- | --- |
| `bun test packages/core` (full) | 6448 tests, **NEW failures = ∅** (`comm -13` against `/tmp/fails-feat.txt`, the pre-change baseline on this branch) |
| plain `node` 24 import of every specifier consumers use (30 unique, from cli src + core src + plugin src) | 30/30 OK |
| `npm pack` tarball contains `dist/<flat>.js` + `.d.ts` | OK |
| clean dir: `@ai-setting/roy-bot-cli@1.7.59` + `@ai-setting/roy-bot-core@1.7.62` | `--version` → `1.7.59`, `tasks list --limit 2` → OK (was `ERR_MODULE_NOT_FOUND` before) |
| clean dir: cli 1.7.62 + core 1.7.62 | `--version` → `1.7.62`, `tasks list` → OK |
| `publish-full.ts` (live) | 567 s, EXIT 0; core + cli 1.7.62 published, verifyInstall passed |
| plugin `scripts/publish.ts --package plugin` | 0.7.1 and 0.7.2 published (PUT 202 each); the in-script verify step hits registry abbreviation lag (ETARGET) when it installs the just-published version — manual re-verify passes |
| plugin 0.7.2 installed from registry | `deps {"@ai-setting/roy-bot-core":"1.7.62"}`, `bun` import smoke OK, `roy-task --version` → `0.7.2`, tarball contains `dist/claude-plugin/hooks/find-open-task.mjs` |
| plugin test suite (`bun test --parallel=4`) | 775 pass / 3 skip / 0 fail (778 tests total) |

## Known limitation (pre-existing, not introduced here)

The `./*` and `./*/*` wildcards still advertise *every* source file as an
entry point, while `bunup` only emits directory barrels. 273 source modules
have no `dist/<path>.js`; importing one of them by name still fails. That was
already true before this task and is orthogonal: this task fixed every file
sub-path that a real consumer imports. Making the wildcard honest would mean
either emitting the whole tree or dropping the wildcards — a separate change.

## Cross-validation (2 rounds, independent model)

`claude-minimax` was unusable (the wrapped model returned
`unrecognized_model` / HTTP 429), so the rounds ran on
`opencode-go/gpt-6-luna` under a hard `timeout 1500`, with the same adversarial
brief. Raw logs and the archived summary:
`docs/cross-validation-2026-10-29-task4622-final.txt`.

**Round 1 — FAIL, two findings**

1. *273 wildcard-only modules still unreachable* (274 on merged `main`,
   which added new modules) — ruled **pre-existing and
   non-blocking** in round 2: `env/errors`, `env/mcp/client`,
   `env/session/session-store` fail identically on the previously published
   core 1.7.61. A 227-specifier sweep found 48 importable on 1.7.61 and 60 on
   1.7.62: **nothing that worked stopped working; 12 became importable.**
2. *Plugin Stop hook can miss an open task* — a **real regression introduced by
   the parent task** (#4619), not by this one, but found here and therefore
   fixed here.

**Round 2 — PASS** on the published artifacts: 31/31 consumer specifiers
import under plain node, CLI 1.7.59 recovers on core 1.7.62, the three public
APIs export identically to 1.7.61, the 15 checked `import`/`types` target pairs
exist in the tarball, and the published `find-open-task.mjs` returns the open
task in the 300-newer-completed reproducer.

### The Stop-hook regression (fixed in plugin 0.7.2)

`claude/hooks/stop-check.mjs` replaced a SQL query

```sql
SELECT id, title, status FROM task
WHERE status IN ('todo','active') ORDER BY updated_at DESC LIMIT 1
```

with `backend.listTasks({ limit: 200 })` + an in-memory filter. `listTasks`
applies its own filters **in memory** and then slices `[offset, offset+limit)`,
and promises no ordering — so 200 newer completed tasks pushed an older
still-open task off the page and the hook approved stopping.

`findOpenTask` now lives in `claude/hooks/find-open-task.mjs`: it queries each
open status with its own filter, drains every page and returns the most
recently updated match. RED-first coverage:
`packages/cli/tests/stop-check-open-task.test.ts` (300 finished + 1 open; 700
open tasks spanning pages).
