/**
 * Task #4996: 二进制原子替换 helper（copyFile → 临时文件 + rename）
 *
 * Linux 对「正在被执行的 ELF」持有 deny-write：直接 copyFile 覆盖运行中的二进制
 * 会报 ETXTBSY (errno -26)。rename 不受此限制——运行中进程继续用旧 inode，
 * 新 spawn 的进程拿到新文件，正是热切换想要的语义。
 *
 * 临时文件与目标同目录，保证同文件系统（rename 的硬前提）。
 *
 * 另一个约束：`packages/roy-bot-standalone/package.json` 的 files 字段是
 * （bin 目录通配），npm pack 会把 bin/ 目录下**所有**文件（含点文件）打进 tarball。
 * 所以 tmp 文件必须用「点开头 + 失败即清理 + 启动时清理历史残留」三重保险，
 * 否则一次中断的构建就会把 128MB 的半成品发布出去。
 */

import { copyFile, rename, unlink, chmod, readdir, stat, lstat, open, constants } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** tmp 文件名前缀（点开头 → 隐藏文件，但仍会被 npm files 通配收走，故需清理） */
const TMP_PREFIX = ".roy-bot-tmp-";

/**
 * tmp 名里 pid 与 uuid 之间的分隔符。
 *
 * 必须用 UUID 里不可能出现的字符：randomUUID() 的输出形如
 * `4ccdc07d-5578-49d0-91e7-e8e78cbc1189`，**本身含 '-'**。
 * 若按 '-' 切分，「倒数第二段」取到的是 uuid 的最后一段（91）而不是 pid。
 * 故用 '_' 分隔：uuid 只含 hex 与 '-'，不含 '_'。
 */
const TMP_PID_SEP = "_";

/** tmp 名冲突时的重试次数（配合 randomUUID，实际碰撞概率约等于 0） */
const TMP_NAME_ATTEMPTS = 5;

/**
 * 原子替换 dest 为 src 的内容。
 * - dest 不存在 → 创建
 * - dest 存在（含被执行中）→ rename 原子替换，旧 inode 留给运行中的进程
 * - 失败时清理 tmp 文件，不留垃圾
 *
 * @param options.forceTmpName 指定临时文件名（测试用：可强制 tmp 路径已被占用，
 *   以验证「不跟随已存在 symlink 写入」的防线）。生产路径不传。
 */
export async function replaceBinaryAtomically(
  src: string,
  dest: string,
  options?: {
    forceTmpName?: string;
    tmpNameFactory?: (dest: string) => string;
    /** 测试钩子：fsync 被调用时回调（用于断言落盘保护确实生效） */
    onFsync?: (target: "file" | "dir", path: string) => void;
  },
): Promise<void> {
  const dir = dirname(dest);
  // tmp 名用 crypto.randomUUID：避免 Math.random() 可预测导致的命名碰撞 / 抢占
  // （tmp 名字里带本进程 pid，便于 cleanup 识别「在途」文件，见 cleanupStaleTempFiles）
  let tmp: string | undefined;
  let created = false;
  try {
    const forced = options?.forceTmpName;
    if (forced) {
      // 强制模式：不重试，直接用指定名字（撞名时如实抛错）
      // 安全：只接受纯文件名（不含分隔符），杜绝路径穿越（join(dir, "../../etc/x")）
      if (forced !== basename(forced) || forced === "." || forced === "..") {
        throw new Error(`forceTmpName 必须是纯文件名（不含路径分隔符），收到: ${forced}`);
      }
      const candidate = join(dir, forced);
      await copyFile(src, candidate, constants.COPYFILE_EXCL);
      tmp = candidate;
      created = true;
    } else {
      // 生产路径：名字可注入（测试用），以便覆盖「生产分支」的 EEXIST / symlink 防线
      const nameFactory = options?.tmpNameFactory ?? tmpName;
      for (let attempt = 0; attempt < TMP_NAME_ATTEMPTS; attempt++) {
        const candidate = join(dir, nameFactory(dest));
        try {
          // COPYFILE_EXCL：目标已存在则报 EEXIST，**不会**跟随已存在的 symlink 写入。
          // 这是防「同目录预置同名 symlink 指向任意文件 → 覆写」的必要防线。
          await copyFile(src, candidate, constants.COPYFILE_EXCL);
          tmp = candidate;
          created = true;
          break;
        } catch (err) {
          // 名字撞车 → 换名重试；其它错误（如源文件不存在 ENOENT）直接抛
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
      }
      if (!tmp) {
        throw new Error(`无法为 ${dest} 分配临时文件名（${TMP_NAME_ATTEMPTS} 次尝试均撞名）`);
      }
    }

    await chmod(tmp, await targetMode(dest));
    // 先 fsync 落盘再 rename：否则断电/掉电场景下 rename 后的新文件可能是空或截断的
    await fsyncFile(tmp, options?.onFsync);
    await rename(tmp, dest);
    // rename 后 fsync 目录，让目录项变更也落盘（best-effort：部分平台不支持）
    await fsyncDir(dir, options?.onFsync);
  } catch (err) {
    // 只清理「我们自己创建的」tmp：若 copyFile 因 EEXIST 失败，tmp 是别人的文件，
    // 删掉反而会造成破坏
    if (created && tmp) {
      await unlink(tmp).catch(() => {});
    }
    throw err;
  }
}

/**
 * 清理目标目录里残留的历史 tmp 文件。
 *
 * 为什么要清：standalone 的 package.json 用 "files": （bin 目录通配），
 * npm pack 会把 bin/ 下所有文件（含点文件）打进 tarball。构建进程被 kill
 * 时 tmp 会残留，下次发布就会把半成品二进制发出去。
 *
 * 只删本 helper 自己产生的命名模式（`.roy-bot-tmp-*`），不碰其它文件。
 *
 * 并发安全：tmp 名里带创建者的 pid。若该 pid 仍存活（另一个构建正在写这个 tmp），
 * 则跳过不删——否则并发构建会互相删掉对方在途的 tmp，导致对方 rename 时 ENOENT 误报失败。
 *
 * @returns 被清理的文件名列表
 */
export async function cleanupStaleTempFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const full = join(dir, name);
    try {
      const st = await stat(full);
      if (!st.isFile()) continue;
      // 属于仍在运行的进程 → 在途文件，跳过
      const ownerPid = ownerPidOf(name);
      if (ownerPid !== null && pidAlive(ownerPid)) continue;
      await unlink(full);
      removed.push(name);
    } catch {
      // 并发下可能已被别的进程清掉，忽略
    }
  }
  return removed;
}

/** tmp 文件名：`<prefix><basename>-<pid>_<uuid>` */
function tmpName(dest: string): string {
  return `${TMP_PREFIX}${basename(dest)}-${process.pid}${TMP_PID_SEP}${randomUUID()}`;
}

/**
 * 从 tmp 文件名解析出创建者的 pid。
 *
 * 命名形如 `.roy-bot-tmp-<basename>-<pid>_<uuid>`。
 * pid 与 uuid 之间用 '_' 分隔（uuid 只含 hex 与 '-'，不含 '_'），
 * 因此取最后一个 '_' 之前的部分即 pid——不受 basename 含 '-' 的影响。
 *
 * @returns pid；命名不匹配时返回 null
 */
function ownerPidOf(name: string): number | null {
  const sep = name.lastIndexOf(TMP_PID_SEP);
  if (sep < 0) return null;
  const pidPart = name.slice(0, sep);
  const pidStr = pidPart.slice(pidPart.lastIndexOf("-") + 1);
  const pid = Number.parseInt(pidStr, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** 进程是否存活（EPERM = 存在但无权限探测，同样算存活） */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 目标已存在 → 沿用其权限位；不存在 → 默认 0o755（二进制需可执行）。
 *
 * 用 lstat 而非 stat：stat 会跟随 symlink 取引用目标的 mode，而 rename 是
 * **替换链接本身**（结果是一个普通文件），语义上更贴近 lstat。
 */
async function targetMode(dest: string): Promise<number> {
  try {
    const st = await lstat(dest);
    const mode = st.mode & 0o777;
    // 目标存在但没有执行位（如 umask 影响下拷成 0644）→ 仍给 0o755
    return mode & 0o111 ? mode : 0o755;
  } catch {
    return 0o755;
  }
}

/**
 * 把文件内容 fsync 落盘（best-effort：失败不阻断替换）。
 *
 * 用只读 fd ("r") 而不是 "r+"：chmod 之后目标可能没有写位（如继承 0o555），
 * 此时 open(path, "r+") 抛 EACCES → fsync 被吞掉 → 落盘保护静默失效。
 * 只读 fd 同样可以 fsync，且不受权限位影响。
 */
async function fsyncFile(path: string, onFsync?: (target: "file" | "dir", path: string) => void): Promise<void> {
  try {
    const fh = await open(path, "r");
    try {
      await fh.sync();
      onFsync?.("file", path);
    } finally {
      await fh.close();
    }
  } catch {
    // 某些文件系统不支持 fsync → 忽略
  }
}

/** 把目录项 fsync 落盘（best-effort：部分平台不支持目录 fsync） */
async function fsyncDir(dir: string, onFsync?: (target: "file" | "dir", path: string) => void): Promise<void> {
  try {
    const fh = await open(dir, "r");
    try {
      await fh.sync();
      onFsync?.("dir", dir);
    } finally {
      await fh.close();
    }
  } catch {
    // 忽略
  }
}
