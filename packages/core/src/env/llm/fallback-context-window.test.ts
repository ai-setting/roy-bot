/**
 * @fileoverview Task #5017 — 回归测试：fallback 链里不能出现「小上下文窗口」模型
 *
 * ★ 原 bug（2026-11-05 飞书反馈）
 *   「sub-agent 撞了上下文上限（96307/120000）」
 *
 *   现象：sub-agent 报 `Context threshold exceeded: 96307/120000 (80.3%)`，
 *   但 sub-agent 继承的主模型是 `minimax/MiniMax-M3.1-Flash`
 *   （contextWindow=1000000 → 阈值 800000），根本不可能撞到 96307。
 *
 *   真根因：`~/.roy-bot/config.jsonc` 的 `llm.fallbackModels` 是**有序数组**，
 *   第 3 位 `tong/deepseek-v4-flash-s1` 在 `tong` provider 的 `limits` 里配的是
 *   `contextWindow: 120000`（阈值 96000）。主模型失败后降级到它，
 *   而阈值检查是按**实际调用的那个模型**的 limits 算的：
 *     agent-component.ts resolveFallbackModels()  → llm.ts getModelLimits()
 *     → getContextThresholdConfig() → checkContextThreshold()
 *   报错模板的分母取的是 `contextWindow` 本身（不是阈值），所以显示 `/120000`。
 *
 * ★ 为什么这个坑值得写死一个测试
 *   小窗口模型当**主模型**完全没问题（用户自己选的）；
 *   但当 **fallback** 就是「给已经很长的会话兜底」——上下文只会更大不会更小，
 *   于是「兜底模型」成了「最先撞墙的模型」，比没有兜底更糟。
 *   而且 agent-component.ts 在 fallback 抛 ContextError 时是**原样上抛**
 *   （见 :3025 `if (fallbackError instanceof ContextError) throw fallbackError;`），
 *   **不会**继续尝试链上下一个 1M 窗口的模型 → 兜底链在这一点上等于断链。
 *
 * ★ 本测试读**真实的用户配置文件**（`~/.roy-bot/config.jsonc`），不是硬编码 fixture
 *   —— 只有读真配置才真的锁住用户配置；fixture 只能锁住「测试自己」。
 *   环境上没有该文件时 **skip**（不是 fail），避免 CI 因环境差异挂掉。
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parse as parseJSONC, type ParseError } from "jsonc-parser";

// ============================================================================
// 常量
// ============================================================================

/** 用户配置的 fallback 链（真实文件路径） */
const USER_CONFIG_PATH = join(homedir(), ".roy-bot", "config.jsonc");

/**
 * fallback 模型的上下文阈值下限。
 *
 * 200000 是一个「保守但有意义」的门槛：
 * - 明确排除 120000 / 128000 这类「小窗口」配置（原始 bug 的 120000 就在这下面）
 * - 又不至于把 200000 的正常模型（tong/GLM-5.2-W4A8 就是 200000）误伤
 */
const MIN_FALLBACK_CONTEXT_THRESHOLD = 200_000;

/** 与 llm.ts `getContextThresholdConfig()` 的默认值保持一致 */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_THRESHOLD_RATIO = 0.9;

/**
 * 已实测的**上游网关强制上限**（tokens）。
 *
 * ★ 数据来源：2026-11-05 对 tong 网关（http://183.230.173.202:36789/v1）发真实请求，
 *   用阶梯 payload 夹逼出来的**悬崖点**，不是猜的、也不是抄文档：
 *   - deepseek-v4-flash-s1：prompt_tokens=306804 → HTTP 200 ✅
 *                            prompt_tokens=310704 → HTTP 400
 *                              「litellm.ContextWindowExceededError: The input (310704
 *                                tokens) is longer than the model's context length
 *                                (307200 tokens)」
 *   - deepseek-v4-flash-s2：prompt_tokens=304204 → HTTP 200 ✅（同后端、同上限）
 *   - GLM-5.3-Flash：prompt_tokens=494012 → HTTP 200 ✅（无 307200 悬崖）
 *
 * ⚠️ `/v1/models` 自报的 `max_input_tokens: 204800` **不可信** —— 实测能跑到 494012，
 *   所以那个值只是参考值，不能当权威。这里记的是实测的强制拒绝点。
 *
 * 只列**已实测**的模型；未列出的不做上限检查（不猜、不臆断）。
 *
 * ⚠️ no-op 语义（review MINOR-3 明确要求标注）：
 *   未登记在此表的模型，其「虚报检查」是 **no-op**（直接跳过，不报错也不通过断言）。
 *   也就是说：若将来把一个**未实测过上游上限**的模型加进 fallback 链，
 *   本测试只会检查它的阈值下限（≥200000），**不会**检查它是否虚报。
 *   这是一个有意的「不猜」取舍 —— 但要清楚它的边界，别误以为虚报检查是全覆盖的。
 *   要补登记某个模型的上限，需要先对它发真实请求夹逼出强制拒绝点（方法见
 *   /tmp/ctx-probe-findings.md）。
 */
const UPSTREAM_CONTEXT_CEILINGS: Record<string, number> = {
  "tong/deepseek-v4-flash-s1": 307_200,
  "tong/deepseek-v4-flash-s2": 307_200,
};

interface ModelLimits {
  contextWindow?: number;
  compactionThreshold?: number;
}

interface ParsedConfig {
  llm?: {
    fallbackModels?: string[];
    providers?: Record<string, { limits?: Record<string, ModelLimits> }>;
  };
}

// ============================================================================
// Helpers
// ============================================================================

function readUserConfig(): ParsedConfig | null {
  if (!existsSync(USER_CONFIG_PATH)) return null;
  const raw = readFileSync(USER_CONFIG_PATH, "utf8");
  const errors: ParseError[] = [];
  const parsed = parseJSONC(raw, errors, { allowTrailingComma: true }) as ParsedConfig;
  if (errors.length > 0) {
    throw new Error(
      `用户配置 ${USER_CONFIG_PATH} 解析失败（JSONC 语法错误）：${JSON.stringify(errors)}`,
    );
  }
  return parsed;
}

function providerOf(rawModel: string): string {
  const slash = rawModel.indexOf("/");
  return slash >= 0 ? rawModel.slice(0, slash) : "minimax";
}

function modelOf(rawModel: string): string {
  const slash = rawModel.indexOf("/");
  return slash >= 0 ? rawModel.slice(slash + 1) : rawModel;
}

/**
 * 复刻 `llm.ts` 的模型解析 + 阈值计算语义。
 *
 * ★ 关键：`getModelLimits()` 用的是**精确字符串匹配**
 *   （`provider.limits[targetModel]`，无大小写归一），
 *   所以模型名拼错会**静默**落到 128000 / 0.9 的默认值 —— 那个默认值恰好
 *   也低于本测试的门槛，所以本测试能同时抓到「拼错」和「窗口太小」两类问题。
 */
function computeThreshold(
  rawModel: string,
  providers: Record<string, { limits?: Record<string, ModelLimits> }>,
): { contextWindow: number; thresholdRatio: number; threshold: number; explicit: boolean } {
  const slash = rawModel.indexOf("/");
  const providerId = slash >= 0 ? rawModel.slice(0, slash) : "minimax";
  const modelId = slash >= 0 ? rawModel.slice(slash + 1) : rawModel;

  const limits = providers?.[providerId]?.limits?.[modelId];
  if (!limits) {
    // 没查到 → llm.ts 返回默认值（128000 × 0.9 = 115200）
    return {
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      thresholdRatio: DEFAULT_THRESHOLD_RATIO,
      threshold: Math.floor(DEFAULT_CONTEXT_WINDOW * DEFAULT_THRESHOLD_RATIO),
      explicit: false,
    };
  }
  const contextWindow = limits.contextWindow || DEFAULT_CONTEXT_WINDOW;
  const thresholdRatio = limits.compactionThreshold ?? DEFAULT_THRESHOLD_RATIO;
  return {
    contextWindow,
    thresholdRatio,
    threshold: Math.floor(contextWindow * thresholdRatio),
    explicit: true,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("Task #5017：fallback 链里的模型必须有足够大的上下文窗口", () => {
  const config = readUserConfig();

  // 环境上没有用户配置 → 优雅 skip（CI 环境差异不应导致红）
  test.skipIf(!config)(
    "每个 fallback 模型的 contextWindow 都能在 providers[provider].limits[model] 精确查到",
    () => {
      const fallbackModels = config!.llm?.fallbackModels ?? [];
      expect(fallbackModels.length).toBeGreaterThan(0);

      const missing: string[] = [];
      for (const raw of fallbackModels) {
        const slash = raw.indexOf("/");
        const providerId = slash >= 0 ? raw.slice(0, slash) : "minimax";
        const modelId = slash >= 0 ? raw.slice(slash + 1) : raw;
        const limits = config!.llm?.providers?.[providerId]?.limits;
        if (!limits || !(modelId in limits)) {
          missing.push(
            `${raw} → providers["${providerId}"].limits["${modelId}"] 不存在（` +
              `会静默落到 ${DEFAULT_CONTEXT_WINDOW} 默认窗口）`,
          );
        }
      }
      expect(missing).toEqual([]);
    },
  );

  test.skipIf(!config)(
    "每个 fallback 模型的上下文阈值 ≥ 200000（小窗口模型只能当主模型，不能当兜底）",
    () => {
      const fallbackModels = config!.llm?.fallbackModels ?? [];
      const providers = config!.llm?.providers ?? {};

      const violations: string[] = [];
      for (const raw of fallbackModels) {
        const t = computeThreshold(raw, providers);
        if (t.threshold < MIN_FALLBACK_CONTEXT_THRESHOLD) {
          violations.push(
            `${raw}: contextWindow=${t.contextWindow} × thresholdRatio=${t.thresholdRatio} ` +
              `= ${t.threshold} < ${MIN_FALLBACK_CONTEXT_THRESHOLD}` +
              (t.explicit ? "" : "（未在 limits 里查到 → 落到默认值）"),
          );
        }
      }
      expect(violations).toEqual([]);
    },
  );

  test.skipIf(!config)(
    "★ 原始 bug 的具体形态已被消除：不存在 120000 窗口的 fallback 模型",
    () => {
      const fallbackModels = config!.llm?.fallbackModels ?? [];
      const providers = config!.llm?.providers ?? {};

      // 原始报错：Context threshold exceeded: 96307/120000 (80.3%)
      // → 触发它的模型必然是 contextWindow=120000 的那一个
      const offenders = fallbackModels.filter((raw) => {
        const t = computeThreshold(raw, providers);
        return t.contextWindow === 120_000;
      });
      expect(offenders).toEqual([]);
    },
  );

  test.skipIf(!config)(
    "★ 不能虚报 contextWindow：阈值必须严格小于上游网关的强制上限",
    () => {
      // 为什么要这条：2026-11-05 16:38 有人把 tong/deepseek-v4-flash-s1 的
      // contextWindow 从 120000 直接改成 1000000（「跟其他模型对齐」）。
      // 但实测 tong 网关对该模型的**强制上限只有 307200 tokens**
      // （306804 → 200；310704 → 400「longer than the model's context length
      // (307200 tokens)」）。配 1000000 的后果比原 bug 更糟：
      //   - 框架阈值 = 800000 > 上游硬上限 → 框架不再提前触发压缩
      //   - 真到 307200+ 时上游直接 400 ContextWindowExceededError
      //   - 该错误命中 model-fallback.ts 的 INTRINSIC_BLOCKERS
      //     （/context window (?:exceeded|overflow)/i）→ 兜底链**不会**切下一个模型
      //   → 变成「既无压缩也无降级」的死链。
      //
      // 所以「窗口越大越好」是错的：**阈值必须落在 [门槛, 上游硬上限) 区间内**，
      // 既不能太小（提前误伤），也不能大于上游上限（虚报 → 硬失败）。
      const fallbackModels = config!.llm?.fallbackModels ?? [];
      const providers = config!.llm?.providers ?? {};

      const violations: string[] = [];
      for (const raw of fallbackModels) {
        const t = computeThreshold(raw, providers);
        const ceiling = UPSTREAM_CONTEXT_CEILINGS[`${providerOf(raw)}/${modelOf(raw)}`];
        // 只有已知上游真实上限的模型才做这项检查（未知则跳过，不猜）
        if (ceiling === undefined) continue;
        if (t.threshold >= ceiling) {
          violations.push(
            `${raw}: 阈值 ${t.threshold} (contextWindow=${t.contextWindow} × ` +
              `ratio=${t.thresholdRatio}) ≥ 上游实测硬上限 ${ceiling} → 虚报，` +
              `框架不会提前压缩，真请求会被上游直接 400 截断`,
          );
        }
      }
      expect(violations).toEqual([]);
    },
  );

  test.skipIf(!config)(
    "兜底链不能是「只剩一个小窗口模型」的死链（同一 provider 至多一个小窗口兜底）",
    () => {
      // ★ review MINOR-1 修正：原来的 `distinctWindows.size >= 1` 是**恒真断言**
      //   （fallback 非空时 size 必然 ≥1，注释宣称的东西根本没被校验）。
      //   改成一条**真有约束力**的断言：
      //   同一个 provider 上**至多一个**「小窗口」兜底模型。
      //   理由：同一 provider 的兜底是同一个上游，若链上有两个来自同一 provider 的
      //   小窗口模型，一个 provider 挂掉/额度耗尽时，链上剩下的小窗口兜底毫无意义，
      //   会让「兜底」退化成「再撞一次同样的墙」。
      const fallbackModels = config!.llm?.fallbackModels ?? [];
      const providers = config!.llm?.providers ?? {};

      // 「小窗口」的判定：阈值 < 300000（覆盖 120000 / 128000 / 160000 这类）
      const smallWindowPerProvider = new Map<string, string[]>();
      for (const raw of fallbackModels) {
        const t = computeThreshold(raw, providers);
        if (t.threshold >= 300_000) continue;
        const p = providerOf(raw);
        const list = smallWindowPerProvider.get(p) ?? [];
        list.push(raw);
        smallWindowPerProvider.set(p, list);
      }

      const violations: string[] = [];
      for (const [provider, models] of smallWindowPerProvider) {
        if (models.length > 1) {
          violations.push(
            `provider "${provider}" 上有 ${models.length} 个小窗口兜底：${models.join(", ")} ` +
              `（同一上游，兜底退化；建议只留一个，其余换其他 provider）`,
          );
        }
      }
      expect(violations).toEqual([]);

      // 至少要有 2 个不同 provider 的兜底（provider 全挂时不至于无路可走）
      const distinctProviders = new Set(fallbackModels.map(providerOf));
      expect(distinctProviders.size).toBeGreaterThanOrEqual(2);
    },
  );
});
