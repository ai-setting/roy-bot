import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { parseFrontmatter, parseMetaFile, scanMetaFiles } from "./parser";

describe("parser", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "roy-commands-parser-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("parseFrontmatter", () => {
    it("should parse simple key-value pairs", () => {
      const text = `name: git
description: Git version control`;
      
      const result = parseFrontmatter(text);
      
      expect(result.name).toBe("git");
      expect(result.description).toBe("Git version control");
    });

    it("should handle quoted values", () => {
      const text = `name: "quoted name"
description: "with spaces"`;
      
      const result = parseFrontmatter(text);
      
      expect(result.name).toBe("quoted name");
      expect(result.description).toBe("with spaces");
    });

    it("should handle empty text", () => {
      const result = parseFrontmatter("");
      
      expect(Object.keys(result)).toHaveLength(0);
    });

    it("should handle values with colons", () => {
      const text = `name: git
description: Git version control: manage repositories`;
      
      const result = parseFrontmatter(text);
      
      expect(result.description).toBe("Git version control: manage repositories");
    });

    it("should handle single quoted values (kept as-is)", () => {
      const text = `name: 'single quoted'
description: 'with content'`;
      
      const result = parseFrontmatter(text);
      
      // 当前实现只支持双引号，单引号会被保留
      expect(result.name).toBe("'single quoted'");
      expect(result.description).toBe("'with content'");
    });

    it("should skip lines without colon", () => {
      const text = `name: git
this line has no colon
description: Git`;
      
      const result = parseFrontmatter(text);
      
      expect(result.name).toBe("git");
      expect(result.description).toBe("Git");
      expect((result as any)["this line has no colon"]).toBeUndefined();
    });
  });

  describe("parseMetaFile", () => {
    it("should parse valid meta.md file", async () => {
      const metaPath = path.join(tempDir, "meta.md");
      await fs.writeFile(metaPath, `---
name: git
description: Git version control
tips: Use --help to explore
source: user
---

# Git Command`);
      
      const result = await parseMetaFile(metaPath, "user");
      
      expect(result).not.toBeNull();
      expect(result!.name).toBe("git");
      expect(result!.description).toBe("Git version control");
      expect(result!.tips).toBe("Use --help to explore");
      expect(result!.source).toBe("user");
    });

    it("should return null for missing frontmatter", async () => {
      const metaPath = path.join(tempDir, "meta.md");
      await fs.writeFile(metaPath, `# No frontmatter`);
      
      const result = await parseMetaFile(metaPath, "user");
      
      expect(result).toBeNull();
    });

    it("should return null for missing name", async () => {
      const metaPath = path.join(tempDir, "meta.md");
      await fs.writeFile(metaPath, `---
description: Only description
---`);
      
      const result = await parseMetaFile(metaPath, "user");
      
      expect(result).toBeNull();
    });

    it("should return null for missing description", async () => {
      const metaPath = path.join(tempDir, "meta.md");
      await fs.writeFile(metaPath, `---
name: git
---`);
      
      const result = await parseMetaFile(metaPath, "user");
      
      expect(result).toBeNull();
    });

    it("should handle meta with empty tips", async () => {
      const metaPath = path.join(tempDir, "meta.md");
      await fs.writeFile(metaPath, `---
name: git
description: Git version control
tips: 
---`);
      
      const result = await parseMetaFile(metaPath, "user");
      
      expect(result).not.toBeNull();
      expect(result!.name).toBe("git");
      // 空 tips 会被解析为空格（trim 后的结果）
      expect(result!.tips?.trim()).toBe("");
    });

    it("should handle description with special characters", async () => {
      const metaPath = path.join(tempDir, "meta.md");
      await fs.writeFile(metaPath, `---
name: docker
description: Container management - build | run | push images
---`);
      
      const result = await parseMetaFile(metaPath, "user");
      
      expect(result).not.toBeNull();
      expect(result!.description).toBe("Container management - build | run | push images");
    });
  });

  describe("scanMetaFiles", () => {
    it("should scan meta.md in directory", async () => {
      const metaPath = path.join(tempDir, "meta.md");
      await fs.writeFile(metaPath, `---
name: git
description: Git version control
---`);
      
      const result = await scanMetaFiles(tempDir, "user");
      
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("git");
      expect(result[0].description).toBe("Git version control");
      expect(result[0].source).toBe("user");
    });

    it("should return empty array for non-existent directory", async () => {
      const result = await scanMetaFiles("/non/existent/path", "user");
      
      expect(result).toEqual([]);
    });

    it("should skip hidden files", async () => {
      const hiddenPath = path.join(tempDir, ".hidden.md");
      await fs.writeFile(hiddenPath, `---
name: should-not-appear
description: test
---`);
      
      const result = await scanMetaFiles(tempDir, "user");
      
      expect(result).toHaveLength(0);
    });

    it("should skip non-meta files", async () => {
      const readmePath = path.join(tempDir, "README.md");
      await fs.writeFile(readmePath, `# Readme`);
      
      const result = await scanMetaFiles(tempDir, "user");
      
      expect(result).toHaveLength(0);
    });
  });
});
