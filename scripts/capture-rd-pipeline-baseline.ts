#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CATEGORY_KEYS, type BaselineCaptured, type Category, type CategoryMap } from "./verify-rd-pipeline-baseline";

export { CATEGORY_KEYS };
export type { Category };

export const COMMANDS: Record<Category, string> = {
  test: "bun test packages/core --parallel 4",
  lint: "bun --cwd packages/cli run lint",
  typecheck: "bun --cwd packages/core run typecheck",
  build: "bun run build:cli:dev:single",
  "cli-smoke": "bun packages/cli/dist/bin/roy-bot.js --help",
};

export const commandForStage = (stage: string, category: Category): string =>
  (stage === "e2e" || stage === "cli-e2e-test") && category === "test"
    ? "bun test packages/cli --parallel 4"
    : COMMANDS[category];

const STAGE_CATEGORIES: Record<string, Category[]> = {
  tdd: ["test", "lint", "typecheck"],
  review: ["test", "lint", "typecheck"],
  e2e: ["build", "test", "cli-smoke"],
  verify: ["test", "lint", "typecheck", "build", "cli-smoke"],
  core: ["test", "typecheck"],
  cli: ["test", "lint", "build", "cli-smoke"],
  all: [...CATEGORY_KEYS],
};

const normalizeWhitespace = (value: string): string => value.trim().replace(/\s+/g, " ");

const stableToken = (value: string): string =>
  normalizeWhitespace(value)
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[^a-zA-Z0-9_./@-]+/g, "_")
    .replace(/^_+|_+$/g, "");

export const normalizeCommandLines = (commandLines: string[]): string[] =>
  commandLines.map(normalizeWhitespace);

export const computeInvocationHash = (commandLines: string[]): string =>
  createHash("sha256")
    .update(normalizeCommandLines(commandLines).join("\n"))
    .digest("hex");

const currentFileFromLine = (line: string): string | undefined => {
  const match = line.match(/^(.+\.(?:[cm]?[jt]sx?|vue|svelte)):\s*$/);
  return match?.[1];
};

const parseTestFailure = (line: string, currentFile: string | undefined): string | undefined => {
  const match = line.match(/\(fail\)\s+(.+?)(?:\s+\[[^\]]+\])?\s*$/);
  if (!match) return undefined;
  const file = currentFile ?? "command";
  const symbol = stableToken(match[1]);
  return `test:${file}:${symbol || "unknown"}:E_TEST_FAILURE`;
};

const parseLintFailure = (line: string): string | undefined => {
  const match = line.match(/^(.+?):(\d+):\d+\s+(?:warning|error)\s+.*?\s+([@a-zA-Z0-9/_-]+)\s*$/i);
  if (!match) return undefined;
  return `lint:${match[1]}:${match[3]}:${match[2]}`;
};

const parseTypecheckFailure = (line: string): string | undefined => {
  const paren = line.match(/^(.+?)\((\d+),\d+\):\s*(?:error|warning)\s+(TS\d+)/i);
  if (paren) return `typecheck:${paren[1]}:${paren[3].toUpperCase()}:${paren[2]}`;
  const colon = line.match(/^(.+?):(\d+)(?::\d+)?\s+-?\s*(?:error|warning)\s+(TS\d+)/i);
  if (colon) return `typecheck:${colon[1]}:${colon[3].toUpperCase()}:${colon[2]}`;
  return undefined;
};

const parseBuildFailure = (line: string): string | undefined => {
  const diagnostic = line.match(/^(.+?):(\d+)(?::\d+)?\s*(?:error|ERROR)\s+(TS\d+|[A-Z][A-Z0-9_-]*)/);
  if (diagnostic) return `build:${diagnostic[1]}:${diagnostic[3]}:${diagnostic[2]}`;
  if (/\b(?:error|failed|failure)\b/i.test(line)) {
    return "build:command:build:E_BUILD_FAILURE";
  }
  return undefined;
};

const parseCliSmokeFailure = (line: string): string | undefined => {
  if (/\b(?:error|failed|failure|unknown command|not found)\b/i.test(line)) {
    return "cli-smoke:roy-bot:help:E_CLI_SMOKE";
  }
  return undefined;
};

const fallbackFailureId = (category: Category, exitCode: number): string | undefined => {
  if (exitCode === 0) return undefined;
  switch (category) {
    case "test":
      return `test:command:all:E_TEST_EXIT_${exitCode}`;
    case "lint":
      return `lint:command:all:E_LINT_EXIT_${exitCode}`;
    case "typecheck":
      return `typecheck:command:all:E_TYPECHECK_EXIT_${exitCode}`;
    case "build":
      return `build:command:build:E_BUILD_EXIT_${exitCode}`;
    case "cli-smoke":
      return `cli-smoke:roy-bot:help:E_EXIT_${exitCode}`;
  }
};

export const parseFailureIds = (category: Category, output: string, exitCode: number): string[] => {
  const ids: string[] = [];
  let currentFile: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    currentFile = currentFileFromLine(line) ?? currentFile;
    const id =
      category === "test"
        ? parseTestFailure(line, currentFile)
        : category === "lint"
          ? parseLintFailure(line)
          : category === "typecheck"
            ? parseTypecheckFailure(line)
            : category === "build"
              ? parseBuildFailure(line)
              : parseCliSmokeFailure(line);
    if (id) ids.push(id);
  }

  const unique = [...new Set(ids)].sort();
  if (unique.length > 0 || exitCode === 0 || output.trim().length === 0) return unique;
  const fallback = fallbackFailureId(category, exitCode);
  return fallback ? [fallback] : unique;
};

const tailLines = (output: string, limit = 20): string[] =>
  output.split(/\r?\n/).filter(Boolean).slice(-limit);

const emptyCategoryMap = <T>(factory: () => T): CategoryMap<T> =>
  Object.fromEntries(CATEGORY_KEYS.map((category) => [category, factory()])) as CategoryMap<T>;

interface CommandResult {
  output: string;
  exitCode: number;
  timedOut: boolean;
}

const runCommand = (command: string, timeoutMs: number): CommandResult => {
  const result = spawnSync(command, {
    cwd: process.cwd(),
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      CI: "0",
      BUN_PARALLEL: "4",
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const exitCode = typeof result.status === "number" ? result.status : timedOut ? 124 : 1;
  return { output, exitCode, timedOut };
};

const atomicWriteJson = (path: string, value: unknown): void => {
  const absolutePath = resolve(path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tempPath, absolutePath);
};

const valuesFromArg = (name: string): string[] => {
  const argv = process.argv;
  const values: string[] = [];
  argv.forEach((value, index) => {
    if (value === name && argv[index + 1]) values.push(argv[index + 1]);
  });
  return values;
};

const firstArg = (name: string): string | undefined => valuesFromArg(name)[0];

export const categoriesForStage = (stage: string, categoryArg?: string): Category[] => {
  const normalizedStage = stage === "tdd-implement" ? "tdd" : stage === "code-review" ? "review" : stage === "cli-e2e-test" ? "e2e" : stage === "final-verify" ? "verify" : stage;
  if (!categoryArg || categoryArg === "all") return [...(STAGE_CATEGORIES[normalizedStage] ?? STAGE_CATEGORIES.all)];
  const requested = categoryArg.split(/[,|\s]+/).filter(Boolean) as Category[];
  return [...new Set(requested.filter((category) => CATEGORY_KEYS.includes(category)))];
};

export const capture = (options: {
  stage: string;
  categories: Category[];
  taskId: number;
  outPath: string;
  timeoutMs: number;
}): BaselineCaptured => {
  const failures = emptyCategoryMap<string[]>(() => []);
  const passCounts = emptyCategoryMap<number>(() => 0);
  const exitCodes = emptyCategoryMap<number>(() => 0);
  const logTail = emptyCategoryMap<string[]>(() => []);
  const commandLines = options.categories.map((category) => `${category}=${commandForStage(options.stage, category)}`);
  const captureErrors: string[] = [];

  for (const category of options.categories) {
    const command = commandForStage(options.stage, category);
    const result = runCommand(command, options.timeoutMs);
    failures[category] = parseFailureIds(category, result.output, result.exitCode);
    exitCodes[category] = result.exitCode;
    logTail[category] = tailLines(result.output);
    passCounts[category] = (result.output.match(/\(pass\)|\bpassed\b|\bwarning\b/gi) ?? []).length;
    if (result.timedOut) captureErrors.push(`timeout:${category}`);
  }

  const captureOutput: BaselineCaptured & { capture_errors?: string[] } = {
    schema: "roy-rd-pipeline-baseline/v1",
    stage: options.stage,
    task_id: options.taskId,
    captured_at: new Date().toISOString(),
    invocation_hash: computeInvocationHash(commandLines),
    worktree_path: process.cwd(),
    command_lines: commandLines,
    failures,
    pass_counts: passCounts,
    exit_codes: exitCodes,
    log_tail: logTail,
    ...(captureErrors.length > 0 ? { capture_errors: captureErrors } : {}),
  };
  atomicWriteJson(options.outPath, captureOutput);
  return captureOutput;
};

const runCli = (): void => {
  const stage = firstArg("--stage") ?? "all";
  const categoryArg = firstArg("--category");
  const outPath = firstArg("--out");
  const timeoutMs = Number(firstArg("--timeout-ms") ?? 120_000);
  if (!outPath || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error(
      "Usage: bun scripts/capture-rd-pipeline-baseline.ts --stage <stage> --category <category[,category]> --out <path> [--task-id <id>] [--timeout-ms <ms>]",
    );
    process.exitCode = 2;
    return;
  }

  const taskId = Number(firstArg("--task-id") ?? process.env.ROY_TASK_ID ?? 0);
  const categories = categoriesForStage(stage, categoryArg);
  if (!Number.isInteger(taskId) || taskId < 0 || categories.length === 0) {
    console.error(JSON.stringify({ pass: false, reasons_for_fail: ["invalid_capture_arguments"] }));
    process.exitCode = 2;
    return;
  }

  try {
    const output = capture({ stage, categories, taskId, outPath, timeoutMs });
    console.log(
      JSON.stringify({
        schema: output.schema,
        stage: output.stage,
        task_id: output.task_id,
        out: resolve(outPath),
        categories,
        exit_codes: output.exit_codes,
        failure_counts: Object.fromEntries(
          CATEGORY_KEYS.map((category) => [category, output.failures[category].length]),
        ),
      }),
    );
    // Non-zero command exits are data in a baseline capture, not a capture-process error.
    process.exitCode = 0;
  } catch (error) {
    console.error(
      JSON.stringify({
        pass: false,
        reasons_for_fail: ["capture_write_failed"],
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 2;
  }
};

if (import.meta.main) runCli();
