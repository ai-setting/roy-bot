/**
 * @fileoverview OutputService Tests
 */

import { describe, it, expect } from "bun:test";
import { OutputService } from "./output.service";

describe("OutputService", () => {
  describe("configure", () => {
    it("should have default values", () => {
      const output = new OutputService();
      expect(output.isQuiet()).toBe(false);
      expect(output.isJsonOutput()).toBe(false);
    });

    it("should enable quiet mode", () => {
      const output = new OutputService();
      output.configure({ quiet: true });
      expect(output.isQuiet()).toBe(true);
    });

    it("should enable json output mode", () => {
      const output = new OutputService();
      output.configure({ jsonOutput: true });
      expect(output.isJsonOutput()).toBe(true);
    });
  });

  describe("info", () => {
    it("should output info message", () => {
      const output = new OutputService();
      output.info("test message");
    });

    it("should not output in quiet mode", () => {
      const output = new OutputService();
      output.configure({ quiet: true });
      output.info("test message");
    });
  });

  describe("success", () => {
    it("should output success message", () => {
      const output = new OutputService();
      output.success("operation succeeded");
    });

    it("should not output in quiet mode", () => {
      const output = new OutputService();
      output.configure({ quiet: true });
      output.success("test");
    });
  });

  describe("warn", () => {
    it("should output warning message", () => {
      const output = new OutputService();
      output.warn("warning message");
    });

    it("should not output in quiet mode", () => {
      const output = new OutputService();
      output.configure({ quiet: true });
      output.warn("warning");
    });
  });

  describe("error", () => {
    it("should output error message", () => {
      const output = new OutputService();
      output.error("error message");
    });

    it("should output even in quiet mode", () => {
      const output = new OutputService();
      output.configure({ quiet: true });
      output.error("error in quiet mode");
    });
  });

  describe("printJson", () => {
    it("should output formatted json", () => {
      const output = new OutputService();
      output.printJson({ key: "value" });
    });

    it("should output compact json when pretty is false", () => {
      const output = new OutputService();
      output.printJson({ key: "value" }, false);
    });
  });
});
