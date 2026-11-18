#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# 片5 failure-set detector — captures the failure shapes bun can emit.
# ═══════════════════════════════════════════════════════════════════════════
#
# WHY THIS EXISTS (Task #4674 lesson, reused per Task #4679):
#   bun's **module load failure** is printed OUTSIDE the `^(fail)` lines, e.g.
#       # Unhandled error between tests
#       error: Cannot find module './x.js' from '/p/x.test.ts'
#   A detector that only greps `^(fail)` therefore **silently under-reports** —
#   it would claim "0 new failures" while two files were failing to even load.
#
#   ⇒ We capture FIVE classes:
#       1. `^(fail)` lines                    — ordinary assertion failures
#       2. `SyntaxError:` / `TypeError:` …    — bad named export / bad type
#       3. `error: Cannot find module`        — unresolved relative import
#       4. `error: Cannot find package`       — unresolved bare package
#       5. `error: <anything else>`           — e.g. a **syntax error**, which
#                                                bun reports WITHOUT a type
#                                                name (`error: Expected
#                                                identifier but found "{"`).
#                                                This class must be LAST and
#                                                must not swallow classes
#                                                3/4.
#
#   ⚠️ COVERAGE LIMIT (measured in Task #4681): the FIVE classes above cover
#   every *content* line bun prints for a failure — verified by measuring the
#   "2 errors" counter in the summary against the captured set: both records
#   ("Failed to initialize OpenTUI render library…" and "ReferenceError:
#   Cannot access 'isParallelRun' before initialization.") DO appear in the
#   captured set (via class 5 and class 2 respectively).
#   What is NOT captured is the bare **marker** line
#       # Unhandled error between tests
#   and the summary counter line "N errors" — those are *containers*, not
#   failure identities; the failure content inside them IS captured. The
#   marker count is still comparable across runs (2 before ⇒ 2 after).
#   ⇒ So a "NEW = 0" verdict is sound for failure CONTENT. Do not read this
#   script as capturing bun's internal error *count*.
#
#   ⚠️ THREE gotchas already paid for in blood:
#     (a) The `(fail)` line carries a **variable timing suffix** (`[0.09ms]`)
#         that changes every run — it MUST be stripped or every comparison
#         reports 100% churn.
#     (b) `[^\r]` in POSIX bracket notation excludes the LITERAL chars `\`
#         and `r` — NOT a carriage return. Using it truncates every match at
#         the first "r" ("Expo**r**t", "f**r**om"). Use `.*` instead.
#     (c) Class 5 must exclude the already-captured `Cannot find module` /
#         `Cannot find package` forms, otherwise the generic `error:` branch
#         double-counts them.
#
# USAGE:
#   scripts/tui-solid/failset.sh <label>              # full suite
#   scripts/tui-solid/failset.sh <label> <cmd...>     # custom command
#
# OUTPUT: stdout = raw bun output; /tmp/failset-<label>.txt = normalised set
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

LABEL="${1:?usage: failset.sh <label> [cmd...]}"
shift || true

LOG="/tmp/phase5-run-${LABEL}.log"
OUT="/tmp/failset-${LABEL}.txt"

if [ "$#" -gt 0 ]; then
  CMD=("$@")
else
  CMD=(bun run test:packages:fast)
fi

echo "[failset] label=${LABEL}"
echo "[failset] cmd=${CMD[*]}"
echo "[failset] log=${LOG}"
echo "[failset] out=${OUT}"

"${CMD[@]}" 2>&1 | tee "$LOG"
RC=${PIPESTATUS[0]}
echo "[failset] exit=${RC}"

# ── normalise ────────────────────────────────────────────────────────────
# Strip the variable timing suffix " [12.34ms]" that bun appends to (fail).
strip_timing() { sed -E 's/ \[[0-9]+(\.[0-9]+)?ms\]$//'; }

{
  # class 1 — ordinary assertion failures
  grep -E '^\(fail\)' "$LOG" | strip_timing || true

  # class 2 — module-load: bad named export / bad type / bad reference
  grep -E '^[[:space:]]*(SyntaxError|TypeError|ReferenceError|ImportError): ' "$LOG" \
    | sed -E 's/^[[:space:]]+//' \
    | sed -E 's/^/(fail) [module-load] /' || true

  # class 3 — module-load: unresolved RELATIVE import
  grep -E "^[[:space:]]*error: Cannot find module" "$LOG" \
    | sed -E 's/^[[:space:]]+//' \
    | sed -E "s|^error: Cannot find module '(.*)' from '(.*)'|(fail) [module-load] Cannot find module '\1' from '\2'|" || true

  # class 4 — module-load: unresolved BARE package
  grep -E "^[[:space:]]*error: Cannot find package" "$LOG" \
    | sed -E 's/^[[:space:]]+//' \
    | sed -E "s|^error: Cannot find package '(.*)' from '(.*)'|(fail) [module-load] Cannot find package '\1' from '\2'|" || true

  # class 5 — any other unhandled `error:` (NOT the two forms above).
  #   This is where a **syntax error** lands: bun reports
  #     error: Expected identifier but found "{"
  #   with no type name at all, so class 2 cannot see it.
  grep -E "^[[:space:]]*error: " "$LOG" \
    | sed -E 's/^[[:space:]]+//' \
    | grep -vE "^error: Cannot find (module|package) " \
    | sed -E 's/^/(fail) [module-load] /' || true
} | sed -E 's/[[:space:]]+$//' \
  | grep -v '^$' \
  | sort -u > "$OUT"

echo "[failset] captured $(wc -l < "$OUT") unique failures -> ${OUT}"
cat "$OUT"
exit "$RC"
