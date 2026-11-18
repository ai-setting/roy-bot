import os from "os";
import path from "path";

/**
 * APP 名称
 */
const APP_NAME = "roy-bot";

/**
 * XDG 基础目录类型
 */
export type XDGDirType = "config" | "state" | "data" | "cache";

/**
 * XDG 路径接口
 */
export interface XDGPaths {
  home: string;
  config: string;
  state: string;
  data: string;
  cache: string;
}

/**
 * 获取 XDG 基础路径
 */
function getXdgBase(): { config: string; state: string; data: string; cache: string } {
  const home = os.homedir();

  // 尝试使用 xdg-basedir，失败则使用默认路径
  try {
    const xdg = require("xdg-basedir");
    return {
      config: xdg.xdgConfig || path.join(home, ".config"),
      state: xdg.xdgState || path.join(home, ".local", "state"),
      data: xdg.xdgData || path.join(home, ".local", "share"),
      cache: xdg.xdgCache || path.join(home, ".cache"),
    };
  } catch {
    return {
      config: path.join(home, ".config"),
      state: path.join(home, ".local", "state"),
      data: path.join(home, ".local", "share"),
      cache: path.join(home, ".cache"),
    };
  }
}

/**
 * 计算 XDG 路径
 */
function computeXDGPaths(): XDGPaths {
  const home = os.homedir();
  const xdg = getXdgBase();

  return {
    home,
    config: path.join(xdg.config, APP_NAME),
    state: path.join(xdg.state, APP_NAME),
    data: path.join(xdg.data, APP_NAME),
    cache: path.join(xdg.cache, APP_NAME),
  };
}

/**
 * XDG 路径计算器（惰性计算）
 */
class XDGPathsCalculator {
  private _paths?: XDGPaths;

  get paths(): XDGPaths {
    if (!this._paths) {
      this._paths = computeXDGPaths();
    }
    return this._paths;
  }

  /**
   * 获取特定类型的路径
   */
  getPath(type: XDGDirType): string {
    return this.paths[type];
  }

  /**
   * 计算 Component 的绝对路径
   */
  getComponentPath(base: XDGDirType, subPath: string): string {
    return path.join(this.paths[base], subPath);
  }

  /**
   * 强制重新计算路径（用于测试或配置变更）
   */
  reset(): void {
    this._paths = undefined;
  }
}

/**
 * 全局 XDG 路径实例
 */
export const XDG_PATHS = new XDGPathsCalculator();

/**
 * 获取 XDG 路径
 */
export function getXDGPaths(): XDGPaths {
  return XDG_PATHS.paths;
}

/**
 * 获取特定类型的 XDG 路径
 */
export function getXDGPath(type: XDGDirType): string {
  return XDG_PATHS.getPath(type);
}
