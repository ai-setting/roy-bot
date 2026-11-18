/**
 * @fileoverview ESLint rule: list-output-json-key-order
 *
 * Enforces that list-style JSON output (constructed via `output.json({...})`
 * or `JSON.stringify({...})`) places metadata keys BEFORE array keys in the
 * source-order of the object literal.
 *
 * Why this matters
 * ----------------
 * `ToolComponent.truncateOutput` (in `packages/core/src/components/tool/`)
 * tail-truncates long outputs (typically to keep within LLM context budgets
 * or shell pipelines). If `total`/`count`/etc. sit AFTER `tasks`, they can
 * be silently dropped when the result is large, causing the LLM / CLI user
 * to misjudge the size of the underlying list.
 *
 * Convention
 * ----------
 *   Metadata keys (must come BEFORE array keys):
 *     total, count, truncated, limit, offset, depth
 *
 *   Array keys (must come AFTER metadata keys):
 *     tasks, items, results, data, list, rows, entries, records
 *
 * Unknown keys (e.g. `keywords`, `parent_task_id`):
 *   Treated as "neither" — they may appear in either group, but must
 *   never end up AFTER an array key. The fix groups them between
 *   metadata and array keys (preserving their original relative order).
 *
 * Background (Code Review Suggestion S-3)
 * --------------------------------------
 * Without an automated check, the "total-first" convention has been
 * accidentally violated 4 times across the codebase:
 *   - eeaad3ab fix(task-tools): move total field to JSON front + truncated flag
 *   - 04b02d89 fix(cli):      move total field to JSON front + truncated flag
 *   - 5a46462d polish(cli):   echo depth field in tasks list output
 *   - c18ab1d2 refactor(cli): unify tasks search/list JSON output
 *
 *   This rule prevents future regressions.
 *
 * Scope of detection
 * ------------------
 *   The rule inspects ONLY the FIRST argument of these call shapes:
 *     - `output.json(<expr>)` — OutputService.json() wrapper
 *     - `JSON.stringify(<expr>)` — raw JS serializer
 *
 *   It does NOT inspect other callees, callees without an object-literal
 *   first argument, or nested objects deep inside values.
 *
 * Auto-fix
 * --------
 *   When a violation is reported, ESLint's `--fix` reorders the object
 *   properties so:
 *     [metadata keys (relative order preserved)]
 *     [unknown keys (relative order preserved)]
 *     [array keys (relative order preserved)]
 *
 *   The fix preserves the source text of each individual property
 *   (including comments, trailing commas on the original last key, and
 *   per-key formatting).
 */

// Metadata-style keys — these document "summary info about the result set"
// and MUST appear BEFORE any array-style keys.
//
// Note on `available_tags` and `keywords`: they are technically arrays, but
// they live in the "metadata block" of the JSON output. We deliberately do
// NOT classify them as either metadata OR array — by keeping them out of
// both sets, the rule treats them as "other" and groups them in the middle
// (between pure metadata and the payload array), which produces the
// canonical "metadata → middle → array" ordering automatically.
//
// Background (Code Review Suggestion S-4 polish):
//   Pre-S-4, the rule's ARRAY_KEYS whitelist missed domain-specific plural
//   keys. Adding them keeps the rule effective as new list-style commands
//   are introduced (workflows/agents/tools/skills/etc.).
const METADATA_KEYS = new Set([
  "total",
  "count",
  "truncated",
  "limit",
  "offset",
  "depth",
  "page", // 1-based page number for paginated list outputs (workflow list)
]);

// Array-style keys — these carry the actual payload. MUST come last so
// downstream tail-truncation trims them, not the metadata.
const ARRAY_KEYS = new Set([
  // 通用数组 (generic array keys)
  "tasks",
  "items",
  "results",
  "data",
  "list",
  "rows",
  "entries",
  "records",
  // 复数名词 (domain-specific plural keys) — Code Review S-4 polish.
  // Conservative whitelist: only well-known plural nouns from roy-bot
  // CLI commands. Add more if a new list-style command uses a different
  // key naming convention.
  "workflows",  // workflow list / workflow search
  "agents",     // agents list (reserved for future)
  "tools",      // tools list
  "skills",     // skills list / search
  "runs",       // workflow runs
  "files",      // filesystem list commands
  "children",   // task children list
  "parents",    // task parents list
  "operations", // task operations log list
  "tags",       // tag definitions / per-record tag arrays
  "hooks",      // plugin / hook list
  "plugins",    // plugin list
  "events",     // event stream list
  "commands",   // command registry
  "sessions",   // session list
  "messages",   // message log
]);

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Enforce metadata-first key order for list-style JSON output " +
        "(total/count/... must precede tasks/items/...)",
      category: "Best Practices",
      recommended: false,
      url: "https://github.com/ai-setting/roy-bot/blob/main/packages/cli/eslint-plugin-local/rules/list-output-json-key-order.js",
    },
    fixable: "code",
    schema: [],
    messages: {
      badOrder:
        "List-style JSON output should put metadata keys (total/count/truncated/limit/offset/depth) " +
        "BEFORE array keys (tasks/items/results/data/list/rows/entries/records). " +
        "Array keys must come last so downstream tail-truncation cannot drop summary metadata.",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode;

    /**
     * Is `node` a `output.json(...)` or `JSON.stringify(...)` call?
     * Returns true for both shapes; false for everything else
     * (including `console.log`, deep property chains, etc.).
     */
    function isTargetCall(node) {
      if (node.callee.type !== "MemberExpression") return false;
      const { object, property } = node.callee;
      if (property.type !== "Identifier") return false;

      // JSON.stringify(...)
      if (
        object.type === "Identifier" &&
        object.name === "JSON" &&
        property.name === "stringify"
      ) {
        return true;
      }

      // output.json(...)        — object is the Identifier "output"
      // service.output.json(...) — object is a MemberExpression ending in "output"
      if (property.name === "json") {
        if (object.type === "Identifier" && object.name === "output") {
          return true;
        }
        if (
          object.type === "MemberExpression" &&
          object.property.type === "Identifier" &&
          object.property.name === "output"
        ) {
          return true;
        }
      }

      return false;
    }

    /**
     * Extract the key name from an `ObjectExpression` property.
     * Returns `null` for computed keys, spread elements, or unknown shapes.
     */
    function getKeyName(prop) {
      if (prop.type !== "Property") return null;
      if (prop.computed) return null;
      const key = prop.key;
      if (key.type === "Identifier") return key.name;
      if (key.type === "Literal" && typeof key.value === "string") {
        return key.value;
      }
      return null;
    }

    /**
     * Classify a property by key name. Returns one of:
     *   "meta"   — known metadata key
     *   "array"  — known array key
     *   "other"  — non-computed key, not in either set
     *   null     — spread element, computed key, or unknown shape (skip)
     */
    function classify(prop) {
      const name = getKeyName(prop);
      if (name === null) return null;
      if (METADATA_KEYS.has(name)) return "meta";
      if (ARRAY_KEYS.has(name)) return "array";
      return "other";
    }

    /**
     * Determine if `props` has a "bad ordering" — i.e. an array key
     * appears BEFORE a metadata key (or any kind of array key after a
     * metadata key in a way that violates the invariant).
     *
     * Equivalent: does any "meta" key come AFTER any "array" key in source order?
     * (Unknown keys can be in either group as long as they don't end up
     * AFTER an array key.)
     *
     * Returns the index of the first offending "array" key, or -1.
     */
    function findFirstViolation(props) {
      let firstArrayIdx = -1; // index of first array key
      let firstMetaAfterArrayIdx = -1; // index of first metadata key AFTER an array key

      for (let i = 0; i < props.length; i++) {
        const cls = classify(props[i]);
        if (cls === null) continue; // spread / computed — skip
        if (cls === "array") {
          if (firstArrayIdx === -1) firstArrayIdx = i;
        }
        if (firstArrayIdx !== -1 && cls === "meta") {
          // Metadata key AFTER an array key — violation.
          return i;
        }
      }
      return -1;
    }

    /**
     * Find the LAST metadata key in source order. Properties AFTER this
     * index are guaranteed to be "array" or "other"; the rule's invariant
     * only requires metadata keys to not appear after this position.
     *
     * Returns -1 if no metadata keys are present.
     */
    function lastMetaIndex(props) {
      let lastIdx = -1;
      for (let i = 0; i < props.length; i++) {
        if (classify(props[i]) === "meta") lastIdx = i;
      }
      return lastIdx;
    }

    /**
     * Reorder `props` to: [meta, other, array] and build replacement text.
     * Preserves per-property source text (so comments and formatting stay).
     */
    function buildFix(obj, props) {
      const metaProps = [];
      const otherProps = [];
      const arrayProps = [];

      for (const p of props) {
        const cls = classify(p);
        if (cls === "meta") metaProps.push(p);
        else if (cls === "array") arrayProps.push(p);
        // "other" and null (spread/computed) both go to the middle group,
        // preserving their source position in the output.
        else otherProps.push(p);
      }

      // Detect multi-line vs single-line object.
      const openBrace = sourceCode.getFirstToken(obj);
      const closeBrace = sourceCode.getLastToken(obj);
      const innerRange = [openBrace.range[1], closeBrace.range[0]];
      const originalInner = sourceCode.getText().slice(...innerRange);
      const isMultiLine = originalInner.includes("\n");

      // Extract base indentation from the first non-empty inner line.
      let baseIndent = "";
      if (isMultiLine) {
        const firstProp = props.find((p) => p.loc.start.line !== obj.loc.start.line);
        if (firstProp) {
          const firstPropLine = sourceCode.lines[firstProp.loc.start.line - 1];
          const leadingWs = firstPropLine.match(/^\s*/)[0];
          baseIndent = leadingWs;
        } else {
          baseIndent = "  ";
        }
        // If baseIndent is empty (first prop on same line as brace), fall back to 2 spaces.
        if (baseIndent === "") baseIndent = "  ";
      }

      // Detect the closing-brace indent: the original `}` line's leading
      // whitespace. We use this so the closing brace aligns with the
      // surrounding context after the fix.
      let closeIndent = "";
      if (isMultiLine) {
        const closeLine = sourceCode.lines[closeBrace.loc.start.line - 1];
        const leadingWs = closeLine.match(/^\s*/)[0];
        // Strip the `{` token itself from the leadingWs (rare edge case).
        closeIndent = leadingWs;
      }

      // Strip leading indentation AND trailing comma from each property's
      // text, then re-indent uniformly with `baseIndent` below.
      const propTexts = [...metaProps, ...otherProps, ...arrayProps].map(
        (p) => {
          return sourceCode
            .getText(p)
            .replace(/^\s+/, "") // strip leading whitespace (incl. indent)
            .replace(/,\s*$/, ""); // strip trailing comma
        },
      );

      // Check whether the ORIGINAL object had a trailing comma before `}`.
      const trimmedInner = originalInner.trimEnd();
      const hadTrailingComma = trimmedInner.endsWith(",");

      let newInner;
      if (isMultiLine) {
        const lines = propTexts.map((t) => baseIndent + t).join(",\n");
        newInner = `\n${lines}${hadTrailingComma ? "," : ""}\n${closeIndent}`;
      } else {
        newInner = " " + propTexts.join(", ") + (hadTrailingComma ? "," : "") + " ";
      }

      return {
        range: innerRange,
        text: newInner,
      };
    }

    return {
      CallExpression(node) {
        if (!isTargetCall(node)) return;
        const arg = node.arguments[0];
        if (!arg || arg.type !== "ObjectExpression") return;
        const props = arg.properties;
        if (!props || props.length === 0) return;

        // Bail on spread elements (we cannot verify ordering through them).
        if (
          props.some(
            (p) =>
              p.type === "SpreadElement" || p.type === "ExperimentalSpreadProperty",
          )
        ) {
          return;
        }

        const violationIdx = findFirstViolation(props);
        if (violationIdx === -1) return;

        context.report({
          node: arg,
          messageId: "badOrder",
          fix(fixer) {
            const fixInfo = buildFix(arg, props);
            return fixer.replaceTextRange(fixInfo.range, fixInfo.text);
          },
        });
      },
    };
  },
};

export default rule;
