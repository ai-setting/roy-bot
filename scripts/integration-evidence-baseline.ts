// Integration evidence: demonstrate baseline set-diff logic with real + synthetic data
import { diffBaselineVsModified } from "./verify-rd-pipeline-baseline";

// Read actual baseline
const baseline = JSON.parse(await Bun.file("reports/2121-capture-dryrun.json").text());
console.log("=== Real baseline ===");
console.log("invocation_hash:", baseline.invocation_hash.slice(0, 16) + "...");
console.log("failures.test:", baseline.failures.test.length, "items");
console.log("pass_counts.test:", baseline.pass_counts.test);

type Scenario = { name: string; modified: any; expectedPass: boolean };
const scenarios: Scenario[] = [
  {
    name: "A: identical (modified=baseline)",
    modified: JSON.parse(JSON.stringify(baseline)),
    expectedPass: true,
  },
  {
    name: "B: new test failure introduced (regression)",
    modified: (() => {
      const m = JSON.parse(JSON.stringify(baseline));
      m.failures.test = [...m.failures.test, "test:packages/core/src/example.test.ts:test_regression:E_TEST_FAILURE"];
      return m;
    })(),
    expectedPass: false,
  },
  {
    name: "C: pre-existing 3 failures (modified ⊆ baseline)",
    modified: (() => {
      const base = JSON.parse(JSON.stringify(baseline));
      base.failures.test = [
        "test:packages/core/src/example.test.ts:test_a:E_TEST_FAILURE",
        "test:packages/core/src/example.test.ts:test_b:E_TEST_FAILURE",
        "test:packages/core/src/example.test.ts:test_c:E_TEST_FAILURE",
      ];
      return JSON.parse(JSON.stringify(base));
    })(),
    expectedPass: true,
  },
  {
    name: "D: pre-existing failures reduced (improvement)",
    modified: (() => {
      const base = JSON.parse(JSON.stringify(baseline));
      base.failures.test = [
        "test:packages/core/src/example.test.ts:test_a:E_TEST_FAILURE",
        "test:packages/core/src/example.test.ts:test_b:E_TEST_FAILURE",
        "test:packages/core/src/example.test.ts:test_c:E_TEST_FAILURE",
      ];
      const m = JSON.parse(JSON.stringify(base));
      m.failures.test = ["test:packages/core/src/example.test.ts:test_a:E_TEST_FAILURE"];
      return m;
    })(),
    expectedPass: true,
  },
  {
    name: "E: command drift (invocation_hash mismatch)",
    modified: (() => {
      const m = JSON.parse(JSON.stringify(baseline));
      m.invocation_hash = "deadbeef00000000000000000000000000000000000000000000000000000000";
      return m;
    })(),
    expectedPass: false,
  },
];

let allOk = true;
scenarios.forEach((s, i) => {
  // For scenario C, we need to use the synthetic baseline (3 failures)
  let baselineForTest = baseline;
  if (s.name.startsWith("C:") || s.name.startsWith("D:")) {
    baselineForTest = (() => {
      const base = JSON.parse(JSON.stringify(baseline));
      base.failures.test = [
        "test:packages/core/src/example.test.ts:test_a:E_TEST_FAILURE",
        "test:packages/core/src/example.test.ts:test_b:E_TEST_FAILURE",
        "test:packages/core/src/example.test.ts:test_c:E_TEST_FAILURE",
      ];
      return base;
    })();
  }
  const r = diffBaselineVsModified(baselineForTest, s.modified, {});
  const match = r.pass === s.expectedPass;
  if (!match) allOk = false;
  console.log(`\n=== Scenario ${s.name} ===`);
  console.log("expected pass:", s.expectedPass, "got:", r.pass, match ? "✅" : "❌");
  if (!r.pass) console.log("  reasons_for_fail:", r.reasons_for_fail);
  if (Object.keys(r.new_regressions).some(k => r.new_regressions[k].length > 0)) {
    console.log("  new_regressions:", JSON.stringify(r.new_regressions));
  }
  if (r.fixed_pre_existing && Object.keys(r.fixed_pre_existing).some(k => r.fixed_pre_existing[k].length > 0)) {
    console.log("  fixed_pre_existing:", JSON.stringify(r.fixed_pre_existing));
  }
});

console.log("\n=== Integration Evidence ===");
console.log("All 5 scenarios match expected pass/fail:", allOk ? "✅ YES" : "❌ NO");
process.exit(allOk ? 0 : 1);
