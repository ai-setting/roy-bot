import { afterEach, describe, expect, it, vi } from "vitest";
import { clearGlobalLSPManager } from "../lsp/manager";
import { BaseLanguageLSPPlugin } from "../lsp/plugins/base-plugin";
import { MDLSPPlugin } from "../lsp/plugins/mdlsp-plugin";
import { PyLSPPlugin } from "../lsp/plugins/pylsp-plugin";
import { TSLSPPlugin } from "../lsp/plugins/tslsp-plugin";
import { LSPPlugin } from "./lsp-plugin";

const pluginEnv = {
  registerHook: vi.fn(),
} as any;

class TestLanguagePlugin extends BaseLanguageLSPPlugin {
  readonly name = "test";
  readonly description = "test";
  readonly extensions = [".test"];
  readonly languageIds = ["test"];

  async getDiagnostics(): Promise<[]> {
    return [];
  }

  preloadMode() {
    return this.config.preloadMode;
  }
}

afterEach(() => {
  clearGlobalLSPManager();
  vi.restoreAllMocks();
  pluginEnv.registerHook.mockClear();
});

describe("LSP plugin preloadMode defaults", () => {
  it("defaults the unified LSPPlugin to startup", () => {
    const plugin = new LSPPlugin();

    expect(plugin.getStatus().preloadMode).toBe("startup");
  });

  it("prewarms the unified LSPPlugin during init by default", () => {
    const plugin = new LSPPlugin();
    const prewarm = vi.spyOn(plugin, "prewarm").mockResolvedValue(undefined);

    plugin.init(pluginEnv);

    expect(prewarm).toHaveBeenCalledWith([]);
  });

  it("keeps explicit lazy mode lazy", () => {
    const plugin = new LSPPlugin({ preloadMode: "lazy" });
    const prewarm = vi.spyOn(plugin, "prewarm").mockResolvedValue(undefined);

    plugin.init(pluginEnv);

    expect(plugin.getStatus().preloadMode).toBe("lazy");
    expect(prewarm).not.toHaveBeenCalled();
  });

  it("defaults BaseLanguageLSPPlugin to startup", () => {
    const plugin = new TestLanguagePlugin();

    expect(plugin.preloadMode()).toBe("startup");
  });

  it("prewarms markdown during init by default", () => {
    const plugin = new MDLSPPlugin();
    const prewarm = vi.spyOn(plugin, "prewarm").mockResolvedValue(undefined);

    plugin.init(pluginEnv);

    expect(plugin.getStatus().preloadMode).toBe("startup");
    expect(prewarm).toHaveBeenCalledWith(["markdown"]);
  });

  it.each([
    ["typescript", () => new TSLSPPlugin({ preloadMode: "lazy" })],
    ["python", () => new PyLSPPlugin({ preloadMode: "lazy" })],
    ["markdown", () => new MDLSPPlugin({ preloadMode: "lazy" })],
  ])("does not prewarm %s when lazy mode is explicit", (_name, createPlugin) => {
    const plugin = createPlugin();
    const prewarm = vi.spyOn(plugin, "prewarm").mockResolvedValue(undefined);

    plugin.init(pluginEnv);

    expect(prewarm).not.toHaveBeenCalled();
  });
});
