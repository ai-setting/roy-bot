/**
 * @fileoverview Task #5129 P7.3 F2 —— dialog-state 模型 id 解析测试。
 *
 * 背景（#5125 DS review M3）：`item.id.split("/")` 对含 `/`
 * 的模型名（如 `provider/model/v2`，OpenRouter 常见）会截断错
 * ⇒ 解析出错误的 model。解析函数收口到 dialog-state.ts
 * （纯函数层，与 reducer 同址穷举）。
 */

import { describe, expect, it } from "bun:test";
import {
  parseModelDialogId,
  type DialogListItem,
} from "./dialog-state.js";

describe("dialog-state — parseModelDialogId (P7.3 F2)", () => {
  it("splits plain provider/model ids", () => {
    expect(parseModelDialogId("prov-a/old-model")).toEqual({
      provider: "prov-a",
      model: "old-model",
    });
  });

  it("keeps the FULL model name when the id has extra slashes", () => {
    // OpenRouter 风格：org/model-tag 全在模型名里
    const id = "openrouter/meta-llama/llama-3.1-70b-instruct";
    expect(parseModelDialogId(id)).toEqual({
      provider: "openrouter",
      model: "meta-llama/llama-3.1-70b-instruct",
    });
  });

  it("returns null for ids without a slash", () => {
    expect(parseModelDialogId("bare-model")).toBeNull();
  });

  it("returns null for empty segments", () => {
    expect(parseModelDialogId("/model-only")).toBeNull();
    expect(parseModelDialogId("provider-only/")).toBeNull();
    expect(parseModelDialogId("")).toBeNull();
  });

  it("works on a DialogListItem-shaped id", () => {
    const item: DialogListItem = {
      id: "kimi/kimi-for-coding/k2",
      label: "k2",
      detail: "kimi",
    };
    expect(parseModelDialogId(item.id)?.model).toBe("kimi-for-coding/k2");
  });
});
