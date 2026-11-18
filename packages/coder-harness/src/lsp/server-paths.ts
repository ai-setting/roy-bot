/**
 * @fileoverview server-paths：用 require.resolve 推导 npm 包入口路径
 *
 * 使用场景：某些 LSP server 包（例如 `@ai-setting/markdown-language-server`）
 * 自带的 `cli.js` 是个针对全局安装的 stub，不能在本地 install 时直接使用；
 * 我们需要直接定位包内真实的入口文件（如 `out/node/main.js`），
 * 然后用 `node <abs path> --stdio` 来 spawn。
 */

import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

// 这里用 import.meta.url 的方式获取 require，兼容 ESM 构建（coder-harness 是 "type": "module"）。
// __filename 在构建产物中可用，但在某些场景下不可靠，统一用 createRequire(import.meta.url)。
const requireFromHere = createRequire(import.meta.url);

/**
 * 通过 `require.resolve(pkg + "/package.json")` 推导出某个 npm 包的根目录，
 * 然后拼上 `relativeEntry` 作为入口绝对路径。
 *
 * @param packageName  npm 包名，如 `"@ai-setting/markdown-language-server"`
 * @param relativeEntry 相对于包根的入口文件，如 `"out/node/main.js"`
 * @returns 入口文件的绝对路径；包未安装或入口不存在则返回 null
 */
export function resolvePackageEntry(
  packageName: string,
  relativeEntry: string
): string | null {
  try {
    const pkgJsonPath = requireFromHere.resolve(`${packageName}/package.json`);
    const pkgRoot = path.dirname(pkgJsonPath);
    const entry = path.join(pkgRoot, relativeEntry);
    if (!fs.existsSync(entry)) {
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}
