/**
 * @fileoverview LanguageMap 测试
 */

import { describe, it, expect } from "vitest";
import { 
  getServerId, 
  getLanguageId, 
  isSupported,
  LANGUAGE_EXTENSIONS,
  SERVER_BY_EXTENSION 
} from "./language-map";

describe("LanguageMap", () => {
  describe("getServerId", () => {
    it("should return typescript server for .ts files", () => {
      expect(getServerId("/path/to/file.ts")).toBe("typescript");
    });

    it("should return typescript server for .tsx files", () => {
      expect(getServerId("/path/to/file.tsx")).toBe("typescript");
    });

    it("should return typescript server for .js files", () => {
      expect(getServerId("/path/to/file.js")).toBe("typescript");
    });

    it("should return python server for .py files", () => {
      expect(getServerId("/path/to/file.py")).toBe("python");
    });

    it("should return vue server for .vue files", () => {
      expect(getServerId("/path/to/file.vue")).toBe("vue");
    });

    it("should return css server for .css files", () => {
      expect(getServerId("/path/to/file.css")).toBe("css");
    });

    it("should return html server for .html files", () => {
      expect(getServerId("/path/to/file.html")).toBe("html");
    });

    it("should return json server for .json files", () => {
      expect(getServerId("/path/to/file.json")).toBe("json");
    });

    it("should return markdown server for .md and .markdown files", () => {
      expect(getServerId("/path/to/file.md")).toBe("markdown");
      expect(getServerId("/path/to/file.markdown")).toBe("markdown");
    });

    it("should return null for unsupported extensions", () => {
      expect(getServerId("/path/to/file.txt")).toBeNull();
      expect(getServerId("/path/to/file.unknown")).toBeNull();
    });
  });

  describe("getLanguageId", () => {
    it("should return typescript for .ts files", () => {
      expect(getLanguageId("/path/to/file.ts")).toBe("typescript");
    });

    it("should return typescriptreact for .tsx files", () => {
      expect(getLanguageId("/path/to/file.tsx")).toBe("typescriptreact");
    });

    it("should return javascript for .js files", () => {
      expect(getLanguageId("/path/to/file.js")).toBe("javascript");
    });

    it("should return python for .py files", () => {
      expect(getLanguageId("/path/to/file.py")).toBe("python");
    });

    it("should return vue for .vue files", () => {
      expect(getLanguageId("/path/to/file.vue")).toBe("vue");
    });

    it("should return css for .css files", () => {
      expect(getLanguageId("/path/to/file.css")).toBe("css");
    });

    it("should return html for .html files", () => {
      expect(getLanguageId("/path/to/file.html")).toBe("html");
    });

    it("should return json for .json files", () => {
      expect(getLanguageId("/path/to/file.json")).toBe("json");
    });

    it("should return plaintext for unsupported extensions", () => {
      expect(getLanguageId("/path/to/file.txt")).toBe("plaintext");
      expect(getLanguageId("/path/to/file.unknown")).toBe("plaintext");
    });
  });

  describe("isSupported", () => {
    it("should return true for supported extensions", () => {
      expect(isSupported("/path/to/file.ts")).toBe(true);
      expect(isSupported("/path/to/file.py")).toBe(true);
      expect(isSupported("/path/to/file.vue")).toBe(true);
    });

    it("should return true for .md and .markdown files", () => {
      expect(isSupported("/path/to/file.md")).toBe(true);
      expect(isSupported("/path/to/file.markdown")).toBe(true);
    });

    it("should return false for unsupported extensions", () => {
      expect(isSupported("/path/to/file.txt")).toBe(false);
    });
  });

  describe("LANGUAGE_EXTENSIONS", () => {
    it("should have entries for common languages", () => {
      expect(LANGUAGE_EXTENSIONS[".ts"]).toBe("typescript");
      expect(LANGUAGE_EXTENSIONS[".py"]).toBe("python");
      expect(LANGUAGE_EXTENSIONS[".vue"]).toBe("vue");
      expect(LANGUAGE_EXTENSIONS[".css"]).toBe("css");
    });
  });

  describe("SERVER_BY_EXTENSION", () => {
    it("should map extensions to server IDs", () => {
      expect(SERVER_BY_EXTENSION[".ts"]).toBe("typescript");
      expect(SERVER_BY_EXTENSION[".py"]).toBe("python");
      expect(SERVER_BY_EXTENSION[".vue"]).toBe("vue");
    });
  });
});
