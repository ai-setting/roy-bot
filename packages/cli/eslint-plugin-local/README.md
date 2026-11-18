# eslint-plugin-local

Local ESLint rules for `@ai-setting/roy-bot-cli`. Houses
project-specific lint rules that don't belong in any public plugin.

## Rules

### `local/list-output-json-key-order`

**Status**: warn (does not block commit)

Enforces that list-style JSON output (constructed via
`output.json({...})` or `JSON.stringify({...})`) places
**metadata keys before array keys** in the object literal's
source order.

#### Why?

`ToolComponent.truncateOutput` tail-truncates long outputs to fit
LLM context budgets / shell pipelines. If `total`/`count`/etc.
sit *after* `tasks` in the JSON, they can be silently dropped
when the result is large — causing the LLM or CLI user to
misjudge the size of the underlying list.

This rule exists because the "total first" convention was
accidentally violated 4 times across the codebase (commits
`eeaad3ab`, `04b02d89`, `5a46462d`, `c18ab1d2`).

#### Convention

| Group    | Keys                                                          |
| -------- | ------------------------------------------------------------- |
| Metadata | `total`, `count`, `truncated`, `limit`, `offset`, `depth`     |
| Array    | `tasks`, `items`, `results`, `data`, `list`, `rows`, `entries`, `records` |

Unknown keys (e.g. `keywords`, `parent_task_id`) are placed
between the two groups.

#### Examples

✅ **Correct**:
```ts
output.json({
  total: 5,
  count: 2,
  truncated: true,
  limit: 20,
  offset: 0,
  keywords: ["k1"],
  tasks: [...],
});
```

❌ **Violating** (and auto-fixable):
```ts
output.json({
  keywords: ["k1"],
  tasks: [...],       // <-- array key BEFORE metadata
  total: 5,
  count: 2,
});
```

Run `pnpm exec eslint --fix src/` to apply the autofix.

#### Test cases

See `rules/list-output-json-key-order.test.js` — 16 tests
covering detection, false-positive avoidance, autofix, and
call-shape edge cases.

## Adding a new rule

1. Create `rules/<rule-name>.js` exporting an ESLint rule object
   (`{ meta, create }`).
2. Register it in `./index.js` under `rules.<rule-name>`.
3. Add tests in `rules/<rule-name>.test.js` (use
   `bun:test` + `Linter` from `eslint`).
4. Wire it up in `../eslint.config.js` (set severity — `warn`
   for non-blocking conventions, `error` for invariants).
5. Run the test suite + the CLI lint and confirm no regressions.
