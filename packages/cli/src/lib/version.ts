/**
 * @fileoverview Version helper
 *
 * Task #2252: 用于欢迎卡显示 roy-bot 版本号
 * Task #2687: 优先使用构建时注入的 ROY_AGENT_VERSION define 常量，
 *             确保二进制中内嵌的版本号与 package.json 一致。
 *             fallback 到 package.json 读取（开发模式 / 非 compile 构建）。
 */

import pkg from "../../package.json" with { type: "json" };

/**
 * 构建时通过 Bun.build define 注入的版本号。
 * 在 compile 模式下，这个值被硬编码进二进制。
 * 在开发模式（非 compile）下，这个值由 tsconfig/tsc 注入或为 undefined。
 */
declare const ROY_AGENT_VERSION: string | undefined;

/**
 * 获取 roy-bot 版本号。
 *
 * 优先使用构建时注入的 ROY_AGENT_VERSION define 常量（compile 模式下保证一致），
 * fallback 到 package.json 的 version 字段（开发模式）。
 *
 * @returns 版本号字符串
 */
export function getPackageVersion(): string {
  // compile 模式下 ROY_AGENT_VERSION 被定义为字符串字面量
  if (typeof ROY_AGENT_VERSION !== "undefined") {
    return ROY_AGENT_VERSION;
  }
  return pkg.version;
}
