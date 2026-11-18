/**
 * @fileoverview Shared chalk mock factory for vi.mock("chalk", ...) calls.
 *
 * 背景：
 *   - bun:test 运行 vitest 的 vi.mock("chalk", ...) 时，模块 mock 会在同一次
 *     `bun test` 进程里**跨测试文件泄漏**（不像 jest 那样每文件独立）。
 *   - 之前的内联 mock 只覆盖 blue/gray/green/red，导致后续测试 import
 *     stream-output.service.ts 时 chalk.bold/chalk.dim/chalk.hex/chalk.white
 *     等变成 undefined，触发 "chalk.X is not a function" / "undefined is not
 *     an object"。
 *   - 本文件提供一个 Proxy 驱动的 chalk mock：
 *       * 任何 chalk.X 属性访问都返回 chainable identity 函数（不抛错）
 *       * 跟踪 "lastColor"，使 chalk.bold.whiteBright("text") 在 level>0
 *         时正确输出 whiteBright ANSI 转义
 *       * chalk.X("#hex" | "namedColor") 设置 lastColor 并返回 proxy（链式）
 *       * chalk.X("text") 用 lastColor 包装文本 ANSI；level=0 返回 identity
 *
 * 使用：
 *   vi.mock("chalk", () => require("../test-utils/chalk-mock").createChalkMock());
 */

export type ChalkLikeFn = ((...args: unknown[]) => string) & ChalkLikeProxy;

export interface ChalkLikeProxy {
  [key: string]: ChalkLikeFn;
}

export function createChalkMock(): { default: ChalkLikeFn } & ChalkLikeFn {
  // The chainable identity. Stored as `let` so the Proxy can reference itself.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chalkLike: any;

  // Per-instance mutable state. Tracks chalk.level (0..3) and the last color
  // token accessed (so chalk.bold.whiteBright("text") still wraps "text" in
  // the whiteBright ANSI escape).
  const state: { level: number; lastColor: string | null } = {
    level: 0,
    lastColor: null,
  };

  const NAMED_COLORS_16: Record<string, [number, number]> = {
    black: [30, 39],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    blue: [34, 39],
    magenta: [35, 39],
    cyan: [36, 39],
    white: [37, 39],
    gray: [90, 39],
    grey: [90, 39],
    blackBright: [90, 39],
    redBright: [91, 39],
    greenBright: [92, 39],
    yellowBright: [93, 39],
    blueBright: [94, 39],
    magentaBright: [95, 39],
    cyanBright: [96, 39],
    whiteBright: [97, 39],
  };

  const isColorLike = (s: unknown): boolean => {
    if (typeof s !== "string") return false;
    if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return true; // hex
    if (NAMED_COLORS_16[s] !== undefined) return true; // named
    return false;
  };

  // Convert "#rrggbb" or "#rgb" -> [r, g, b]
  const hexToRgb = (hex: string): [number, number, number] => {
    let h = hex.replace(/^#/, "");
    if (h.length === 3) {
      h = h.split("").map((c) => c + c).join("");
    }
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return [r, g, b];
  };

  const basic16ForHex = (r: number, g: number, b: number): number => {
    const max = Math.max(r, g, b);
    if (max < 64) return 90; // gray -> bright black
    if (r >= g && r >= b) return 91; // bright red
    if (g >= r && g >= b) return 92; // bright green
    if (b >= r && b >= g) return 94; // bright blue
    if (r > 128 && g > 128) return 93; // bright yellow
    if (r > 128 && b > 128) return 95; // bright magenta
    if (g > 128 && b > 128) return 96; // bright cyan
    return 97; // bright white
  };

  const rgbToAnsi256 = (r: number, g: number, b: number): number => {
    if (r === g && g === b) {
      if (r < 8) return 16;
      if (r > 248) return 231;
      return Math.round(((r - 8) / 240) * 24) + 232;
    }
    const ri = Math.round((r / 255) * 5);
    const gi = Math.round((g / 255) * 5);
    const bi = Math.round((b / 255) * 5);
    return 16 + 36 * ri + 6 * gi + bi;
  };

  const openAnsiFor = (colorLike: string): string | null => {
    if (state.level === 0) return null;
    if (/^#[0-9a-fA-F]{6}$/i.test(colorLike) || /^#[0-9a-fA-F]{3}$/i.test(colorLike)) {
      const [r, g, b] = hexToRgb(colorLike);
      if (state.level >= 3) return `\x1b[38;2;${r};${g};${b}m`;
      if (state.level === 2) return `\x1b[38;5;${rgbToAnsi256(r, g, b)}m`;
      return `\x1b[${basic16ForHex(r, g, b)}m`;
    }
    const named = NAMED_COLORS_16[colorLike];
    if (named) {
      const [open] = named;
      return `\x1b[${open}m`;
    }
    return null;
  };

  const stringJoin = (args: unknown[]): string => {
    if (args.length === 0) return "";
    if (args.length === 1) return String(args[0] ?? "");
    return args.map((a) => String(a ?? "")).join(" ");
  };

  // Wrap text in ANSI codes when state.level > 0 and state.lastColor is set.
  const wrapAnsi = (text: string): string => {
    if (state.level === 0 || state.lastColor === null) return text;
    const open = openAnsiFor(state.lastColor);
    if (open === null) return text;
    return `${open}${text}\x1b[39m`;
  };

  const handler: ProxyHandler<object> = {
    get(_target, prop): unknown {
      if (prop === "default") {
        return chalkLike;
      }
      if (prop === "level") {
        return state.level;
      }
      if (prop === Symbol.toPrimitive || prop === "then") {
        return undefined;
      }
      if (prop === "toString" || prop === "valueOf") {
        return () => "";
      }
      // Track the last color token accessed so the final apply can wrap.
      if (typeof prop === "string") {
        if (
          NAMED_COLORS_16[prop] !== undefined ||
          /^#[0-9a-fA-F]{3,8}$/.test(prop)
        ) {
          state.lastColor = prop;
        }
        // Modifiers (bold/dim/etc.) don't change lastColor.
      }
      return chalkLike;
    },
    set(_target, prop, value): boolean {
      if (prop === "level") {
        state.level = Number(value);
        return true;
      }
      return true;
    },
    apply(_target, _thisArg, args): unknown {
      // chalk.X("#hex" | "namedColor") -> return chalkLike so it can be called
      // again with text: chalk.hex("#ff6b6b")(s).
      if (args.length === 1 && isColorLike(args[0])) {
        state.lastColor = args[0] as string;
        return chalkLike;
      }
      // chalk.X("text", ...) -> wrap text in ANSI if state.lastColor is set
      // and level > 0; otherwise return identity.
      const text = stringJoin(args);
      return wrapAnsi(text);
    },
  };

  // Proxy that acts as both a function (apply) and an object (get/set).
  chalkLike = new Proxy(function () {}, handler);

  return chalkLike as unknown as { default: ChalkLikeFn } & ChalkLikeFn;
}