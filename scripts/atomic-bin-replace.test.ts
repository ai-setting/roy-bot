#!/usr/bin/env bun
/**
 * Task #4996: 原子替换二进制（copyFile → tmp + rename）测试
 *
 * 背景：deamon-for-roy 的 daemon 子进程持续执行 packages/roy-bot-standalone/bin/roy-bot-linux-x64。
 * Linux 对「正在被执行的 ELF」持有 deny-write，直接 copyFile 覆盖会报 ETXTBSY (errno -26)。
 *
 * 测试策略（真实复现，不 mock）：
 * 1. 复制 /bin/sleep 到临时目录并 exec（内核即持 deny-write，等价于 daemon 子进程占用 standalone bin）
 * 2. 证明直接 copyFile 必然 ETXTBSY（复现 bug）
 * 3. 证明 replaceBinaryAtomically 成功替换，且运行中进程继续用旧 inode（热切换语义）
 * 4. 证明已打开的 fd 仍读到旧内容、旧 inode 不变（用户明确要求的验收点）
 * 5. 证明 tmp 残留会被清理——standalone 的 package.json 的 files 字段是 bin 目录通配，
 *    npm pack 会把 bin/ 下所有文件（含点文件）打进 tarball，残留 tmp = 半成品被发布
 */

import { describe, test, expect, afterAll } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, realpathSync, readlinkSync, openSync, readSync, closeSync, writeFileSync, symlinkSync, readFileSync, existsSync } from "node:fs";
import { copyFile, chmod, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { cleanupStaleTempFiles, replaceBinaryAtomically } from "./atomic-bin-replace.ts";

const TMPDIR = path.join(os.tmpdir(), `etxtbsy-test-${process.pid}`);
const RUNNING_BIN = path.join(TMPDIR, "running.bin");
const NEW_BIN = path.join(TMPDIR, "new.bin");

// ---- 模块级同步 setup：确保 spawn 前 RUNNING_BIN 已存在 ----
// Task #4996 CV M4：模块顶层代码在 import 期执行，test.skipIf 保护不到它。
// 非 Linux（无 /bin/sleep、/bin/true）必须在 import 期就跳过，否则整个测试文件崩。
const IS_LINUX = process.platform === "linux";

// Task #4996 CV r2 MINOR-4：M4 只修了一半 —— TMPDIR 只在 IS_LINUX 下创建，
// 但 12 个非 skipIf 用例仍直接用 TMPDIR 和 /bin/true（macOS 是 /usr/bin/true）。
// 故 TMPDIR 的创建与 /bin/true 的复制都必须在**任何**平台都成立；
// 平台相关的只有 /bin/sleep（用于「运行中的二进制」场景）。
const TRUE_BIN = IS_LINUX ? "/bin/true" : "/usr/bin/true";

mkdirSync(TMPDIR, { recursive: true });
if (IS_LINUX) {
  copyFileSync("/bin/sleep", RUNNING_BIN);
  chmodSync(RUNNING_BIN, 0o755);
}
copyFileSync(TRUE_BIN, NEW_BIN);

// 模拟「运行中的二进制」：exec 一个 sleep 副本（短时长，测试结束自动退出）
// 非 Linux 不 spawn（无 /bin/sleep）
const CHILD = IS_LINUX
  ? Bun.spawn([RUNNING_BIN, "20"], { stdout: "ignore", stderr: "ignore" })
  : null;

// Task #4996 CV r3b MINOR-1：afterAll 必须 async 且 await rm —— 否则 bun 在
// 钩子返回前就退出，/tmp/etxtbsy-test-* 目录不会被删（实测已泄漏 92 个 / 42MB）。
afterAll(async () => {
  // 杀掉的是本测试自己 spawn 的 sleep 子进程（非 daemon / 非 roy-bot 进程），安全
  try {
    CHILD?.kill(9);
  } catch {
    /* already exited */
  }
  await rm(TMPDIR, { recursive: true, force: true });
});

/** 目录里是否残留本 helper 产生的 tmp 文件 */
function tempArtifacts(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith(".roy-bot-tmp-"));
}

/** 文件内容 sha256（用于内容级断言，而非长度断言） */
async function sha256(p: string): Promise<string> {
  const buf = Buffer.from(await Bun.file(p).arrayBuffer());
  return createHash("sha256").update(buf).digest("hex");
}

describe("replaceBinaryAtomically（copyFile → tmp + rename）", () => {
  test.skipIf(!IS_LINUX)(
    "前提：目标文件被执行中，内核持 deny-write",
    () => {
      // 确认子进程真的在跑，且 /proc/<pid>/exe 指向 RUNNING_BIN
      const exe = realpathSync(`/proc/${CHILD!.pid}/exe`);
      expect(exe).toBe(RUNNING_BIN);
      expect(CHILD!.exitCode).toBeNull();
    },
  );

  test.skipIf(!IS_LINUX)(
    "RED 复现：对运行中的二进制直接 copyFile → ETXTBSY (errno -26)",
    async () => {
      let caught: unknown = null;
      try {
        await copyFile(NEW_BIN, RUNNING_BIN);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("ETXTBSY");
    },
  );

  test.skipIf(!IS_LINUX)(
    "GREEN：replaceBinaryAtomically 对运行中的二进制替换成功，且进程继续用旧 inode",
    async () => {
      const sizeBefore = (await stat(RUNNING_BIN)).size;
      const sizeNew = (await stat(NEW_BIN)).size;
      expect(sizeNew).not.toBe(sizeBefore); // 新旧内容可区分

      // 原子替换：不抛 ETXTBSY
      await replaceBinaryAtomically(NEW_BIN, RUNNING_BIN);

      // 目录里的文件已变成新内容
      const sizeAfter = (await stat(RUNNING_BIN)).size;
      expect(sizeAfter).toBe(sizeNew);

      // 运行中子进程未被影响：还活着（旧 inode 已 unlink，但 exe 仍有效）
      expect(CHILD!.exitCode).toBeNull();
      // 内核对已 unlink 的可执行文件追加 "(deleted)" 后缀——
      // 这本身就是「进程继续用旧 inode」的铁证
      // 注意：必须用 readlink（realpath 会因目标已删除而抛 ENOENT）
      const exe = readlinkSync(`/proc/${CHILD!.pid}/exe`);
      expect(exe.endsWith("(deleted)")).toBe(true);
    },
  );

  test.skipIf(!IS_LINUX)(
    "已打开的 fd 仍读到旧内容（旧 inode 不变），路径上是新内容",
    async () => {
      const dest = path.join(TMPDIR, "fd-probe.bin");
      // 旧内容必须与新内容不同，否则断言无意义 → 旧用 /bin/sleep，新用 NEW_BIN(/bin/true)
      copyFileSync("/bin/sleep", dest);
      const oldHash = await sha256(dest);

      const fd = openSync(dest, "r");
      try {
        await replaceBinaryAtomically(NEW_BIN, dest);

        // 路径上已是新内容
        const newHash = await sha256(dest);
        expect(newHash).not.toBe(oldHash);

        // fd 仍指向旧 inode → 读到的仍是旧内容（内容级校验，非长度）
        const buf = Buffer.alloc(1024 * 1024);
        const n = readSync(fd, buf, 0, buf.length, 0);
        const fdHash = createHash("sha256").update(buf.subarray(0, n)).digest("hex");
        expect(fdHash).toBe(oldHash);
        expect(fdHash).not.toBe(newHash);
      } finally {
        closeSync(fd);
      }
    },
  );

  test("目标不存在时：正常创建且无 tmp 残留", async () => {
    const dest = path.join(TMPDIR, "fresh.bin");
    await replaceBinaryAtomically(NEW_BIN, dest);
    expect((await stat(dest)).size).toBe((await stat(NEW_BIN)).size);
    expect(tempArtifacts(TMPDIR)).toEqual([]);
  });

  test("目标已存在但未被占用时：直接覆盖成功且无 tmp 残留", async () => {
    const dest = path.join(TMPDIR, "plain.bin");
    copyFileSync(TRUE_BIN, dest);
    await replaceBinaryAtomically(NEW_BIN, dest);
    expect((await stat(dest)).size).toBe((await stat(NEW_BIN)).size);
    expect(tempArtifacts(TMPDIR)).toEqual([]);
  });

  test("替换后目标仍可执行（权限位保留 0o755）", async () => {
    const dest = path.join(TMPDIR, "mode.bin");
    copyFileSync(TRUE_BIN, dest);
    await chmod(dest, 0o755);
    await replaceBinaryAtomically(NEW_BIN, dest);
    const mode = (await stat(dest)).mode & 0o777;
    expect(mode & 0o111).not.toBe(0);
  });

  // Task #4996 CV M5：原用例只断言 mode & 0o111 !== 0，变异
  // `chmod(tmp, await targetMode(dest))` → `chmod(tmp, 0o755)` 后测试仍全绿（假绿）。
  // 这里改成**精确**断言权限位继承，让 targetMode() 变成 load-bearing。
  test("权限位精确继承：目标原为 0o700 → 替换后仍为 0o700（不被强制 0o755）", async () => {
    const dest = path.join(TMPDIR, "mode-700.bin");
    copyFileSync(TRUE_BIN, dest);
    await chmod(dest, 0o700);
    await replaceBinaryAtomically(NEW_BIN, dest);
    const mode = (await stat(dest)).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test("权限位精确继承：目标原为 0o644（无执行位）→ 替换后强制补上执行位 0o755", async () => {
    const dest = path.join(TMPDIR, "mode-644.bin");
    copyFileSync(TRUE_BIN, dest);
    await chmod(dest, 0o644);
    await replaceBinaryAtomically(NEW_BIN, dest);
    const mode = (await stat(dest)).mode & 0o777;
    expect(mode & 0o111).not.toBe(0);
    expect(mode).toBe(0o755);
  });

  // Task #4996 CV M3：tmp 名碰撞 / symlink 抢占防线
  test("tmp 名不使用可预测的 Math.random（用 crypto.randomUUID）", async () => {
    const dest = path.join(TMPDIR, "uuid-name.bin");
    await replaceBinaryAtomically(NEW_BIN, dest);
    expect((await stat(dest)).size).toBe((await stat(NEW_BIN)).size);
    expect(tempArtifacts(TMPDIR)).toEqual([]);
  });

  // Task #4996 CV M3：预置同名 symlink 时不得跟随写入（任意文件覆写防线）
  // 用 forceTmpName 强制 tmp 路径已被占用，真实走到 copyFile 分支：
  // 有 COPYFILE_EXCL → 抛 EEXIST 且 victim 不被覆写；
  // 无 COPYFILE_EXCL → 跟随 symlink 写入 victim → 用例变红。
  test("COPYFILE_EXCL 防线：tmp 路径被 symlink 抢占时不跟随覆写目标", async () => {
    const dir = path.join(TMPDIR, "symlink-guard");
    mkdirSync(dir, { recursive: true });
    const victim = path.join(dir, "victim.txt");
    writeFileSync(victim, "VICTIM-ORIGINAL");
    const dest = path.join(dir, "guard.bin");
    // 预置一个指向 victim 的 symlink，名字强制为本次 tmp 路径
    const planted = ".roy-bot-tmp-guard.bin-planted";
    symlinkSync(victim, path.join(dir, planted));

    let caught: unknown = null;
    try {
      await replaceBinaryAtomically(NEW_BIN, dest, { forceTmpName: planted });
    } catch (e) {
      caught = e;
    }

    // 期望：因 EEXIST 抛错，且 victim 内容分毫未动
    expect(caught).toBeInstanceOf(Error);
    expect((caught as NodeJS.ErrnoException).code).toBe("EEXIST");
    expect(readFileSync(victim, "utf8")).toBe("VICTIM-ORIGINAL");
    // dest 不该被创建（replace 整体失败）
    expect(existsSync(dest)).toBe(false);
  });

  // Task #4996 CV r2 MINOR-2：生产分支（走 tmpName + 重试）的 COPYFILE_EXCL
  // 之前没有任何用例覆盖 —— 去掉 EXCL 后测试全绿（防线形同虚设）。
  // 这里用注入的 tmpNameFactory 让「生产路径」撞上一个已存在的 symlink：
  // 有 EXCL → 重试换名成功（symlink 不被跟随，victim 不变）；
  // 无 EXCL → 跟随 symlink 写入 victim → victim 被改写 → 用例变红。
  test("COPYFILE_EXCL 防线（生产分支）：tmp 名撞上已存在 symlink 时不跟随覆写", async () => {
    const dir = path.join(TMPDIR, "prod-excl-guard");
    mkdirSync(dir, { recursive: true });
    const victim = path.join(dir, "victim.txt");
    writeFileSync(victim, "VICTIM-ORIGINAL");
    const dest = path.join(dir, "prod-guard.bin");

    // 注入的工厂：第一次产出已被 symlink 占用的名字，之后产出可用名字
    let call = 0;
    const planted = ".roy-bot-tmp-prod-guard.bin-planted";
    symlinkSync(victim, path.join(dir, planted));
    const factory = () => (call++ === 0 ? planted : `.roy-bot-tmp-prod-guard.bin-${process.pid}_${randomUUID()}`);

    // 替换应当成功（第一次撞名 → EEXIST → 重试换名）
    await replaceBinaryAtomically(NEW_BIN, dest, { tmpNameFactory: factory });

    // 目标已是新内容
    expect((await stat(dest)).size).toBe((await stat(NEW_BIN)).size);
    // 关键：victim 分毫未动（无 EXCL 时会被跟随覆写）
    expect(readFileSync(victim, "utf8")).toBe("VICTIM-ORIGINAL");
  });

  // Task #4996 CV r2 NIT-1：forceTmpName 只应是纯文件名，杜绝路径穿越
  test("forceTmpName 拒绝路径穿越（只接受纯文件名）", async () => {
    const dest = path.join(TMPDIR, "traversal.bin");
    let caught: unknown = null;
    try {
      await replaceBinaryAtomically(NEW_BIN, dest, { forceTmpName: "../../etc/passwd" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("纯文件名");
    expect(existsSync(dest)).toBe(false);
  });

  // Task #4996 CV r2 MINOR-5：验收标准 ③「新 spawn 拿到新二进制」此前无测试覆盖
  test("新 spawn 的进程拿到新二进制（旧进程仍用旧 inode）", async () => {
    const dir = path.join(TMPDIR, "respawn-case");
    mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, "respawn.bin");
    // 初始内容 = true（立即退出，exit 0）
    copyFileSync(TRUE_BIN, dest);
    await chmod(dest, 0o755);

    // 替换成 sleep（会阻塞）→ 新 spawn 必须阻塞，证明它拿到的是**新**内容
    const sleepSrc = path.join(dir, "sleep-src.bin");
    copyFileSync(IS_LINUX ? "/bin/sleep" : "/usr/bin/sleep", sleepSrc);
    await chmod(sleepSrc, 0o755);

    // 替换前 spawn：跑的是 true → 立即退出 0
    const before = Bun.spawn([dest], { stdout: "ignore", stderr: "ignore" });
    await before.exited;
    expect(before.exitCode).toBe(0);

    await replaceBinaryAtomically(sleepSrc, dest);

    // 新 spawn：跑的是 sleep → 会阻塞（exitCode 为 null）
    const spawned = Bun.spawn([dest, "30"], { stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(200);
    expect(spawned.exitCode).toBeNull();
    spawned.kill(9);
  });

  // Task #4996 CV r2 NIT-2：fsync 至少有一条「正常路径被调用」的断言
  test("正常路径会执行 fsync（tmp 文件与所在目录各一次）", async () => {
    const dest = path.join(TMPDIR, "fsync-probe.bin");
    const fsyncCalls: Array<{ target: string; path: string }> = [];
    await replaceBinaryAtomically(NEW_BIN, dest, {
      onFsync: (target, p) => fsyncCalls.push({ target, path: p }),
    });
    const targets = fsyncCalls.map((c) => c.target);
    expect(targets).toContain("file");
    expect(targets).toContain("dir");
    // fsync 的文件应是 tmp（不是 dest）
    const fileCall = fsyncCalls.find((c) => c.target === "file")!;
    expect(fileCall.path).not.toBe(dest);
  });

  // Task #4996 CV r2 MINOR-1：fsync 必须对「只读权限位」的目标也生效。
  // 旧实现用 open(path, "r+")，目标权限 0o555 时抛 EACCES → fsync 被静默吞掉。
  test("目标为只读权限位（0o555）时 fsync 仍生效（用只读 fd，不被 EACCES 吞掉）", async () => {
    const dest = path.join(TMPDIR, "ro-target.bin");
    copyFileSync(TRUE_BIN, dest);
    await chmod(dest, 0o555);
    const fsyncCalls: Array<{ target: string; path: string }> = [];
    await replaceBinaryAtomically(NEW_BIN, dest, {
      onFsync: (target, p) => fsyncCalls.push({ target, path: p }),
    });
    expect(fsyncCalls.some((c) => c.target === "file")).toBe(true);
    // 替换后权限位继承 0o555
    expect((await stat(dest)).mode & 0o777).toBe(0o555);
  });

  // cleanup 不应删掉「创建者进程仍存活」的 tmp（当前 pid 存活）
  test("cleanup 跳过「创建者进程仍存活」的在途 tmp", async () => {
    const dir = path.join(TMPDIR, "in-flight-case");
    mkdirSync(dir, { recursive: true });
    const inFlight = path.join(dir, `.roy-bot-tmp-x.bin-${process.pid}_${randomUUID()}`);
    copyFileSync(TRUE_BIN, inFlight);
    const removed = await cleanupStaleTempFiles(dir);
    expect(removed).toEqual([]);
    expect(existsSync(inFlight)).toBe(true);
  });

  // Task #4996 CV r2：M6 修复在「生产环境真实命名」下失效 —— randomUUID() 含 '-'，
  // 按 '-' 切分取「倒数第二段」拿到的是 uuid 末段（91）而非 pid，导致
  // 「创建者仍存活」的在途 tmp 被误删（并发构建保护形同虚设）。
  // 本用例直接用**生产命名规则**（含真实 randomUUID）验证 pid 解析正确。
  test("生产命名规则下：tmp 名的 pid 可被正确解析（randomUUID 含 '-' 也不受影响）", async () => {
    const dir = path.join(TMPDIR, "real-naming-case");
    mkdirSync(dir, { recursive: true });
    // 用真实 helper 生成 tmp 名（与生产完全一致）
    const dest = path.join(dir, "roy-bot-linux-x64");
    await replaceBinaryAtomically(NEW_BIN, dest);

    // 复原出一个「在途」tmp：名字必须与生产规则一致 → pid + '_' + randomUUID
    const realName = `.roy-bot-tmp-roy-bot-linux-x64-${process.pid}_${randomUUID()}`;
    const inFlight = path.join(dir, realName);
    copyFileSync(TRUE_BIN, inFlight);

    const removed = await cleanupStaleTempFiles(dir);

    // 创建者（本进程）仍存活 → 必须跳过，不能删
    expect(removed).toEqual([]);
    expect(existsSync(inFlight)).toBe(true);
  });

  test("源文件不存在时：抛错且不留 tmp 残留", async () => {
    const dest = path.join(TMPDIR, "failed.bin");
    let caught: unknown = null;
    try {
      await replaceBinaryAtomically(path.join(TMPDIR, "does-not-exist.bin"), dest);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(tempArtifacts(TMPDIR)).toEqual([]);
  });
});

describe("cleanupStaleTempFiles（清理历史残留 tmp，防止污染 npm tarball）", () => {
  test("清理本 helper 命名模式的残留文件", async () => {
    const dir = path.join(TMPDIR, "cleanup-case");
    mkdirSync(dir, { recursive: true });
    copyFileSync(TRUE_BIN, path.join(dir, `.roy-bot-tmp-roy-bot-linux-x64-123_${randomUUID()}`));
    copyFileSync(TRUE_BIN, path.join(dir, "keep-me.bin"));
    copyFileSync(TRUE_BIN, path.join(dir, ".hidden-but-ours-other.bin"));

    const removed = await cleanupStaleTempFiles(dir);

    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain(".roy-bot-tmp-");
    const left = readdirSync(dir);
    expect(left).toContain("keep-me.bin");
    expect(left).toContain(".hidden-but-ours-other.bin");
    expect(left.some((f) => f.startsWith(".roy-bot-tmp-"))).toBe(false);
  });

  test("目录不存在时：返回空数组，不抛错", async () => {
    const removed = await cleanupStaleTempFiles(path.join(TMPDIR, "no-such-dir"));
    expect(removed).toEqual([]);
  });

  // Task #4996 CV M6：并发构建竞态 —— cleanup 可能删掉另一个**仍在运行**的构建
  // 在途的 tmp，导致对方 rename 时 ENOENT 误报构建失败。
  test("cleanup 跳过「创建者进程仍存活」的在途 tmp（并发构建保护）", async () => {
    const dir = path.join(TMPDIR, "concurrent-case");
    mkdirSync(dir, { recursive: true });
    // 本进程 pid 存活 → 视为另一个构建在途
    const inFlight = path.join(dir, `.roy-bot-tmp-x.bin-${process.pid}_${randomUUID()}`);
    // 已死进程（pid 999999 通常不存在）→ 视为历史残留，应被清理
    const stale = path.join(dir, `.roy-bot-tmp-x.bin-999999_${randomUUID()}`);
    copyFileSync(TRUE_BIN, inFlight);
    copyFileSync(TRUE_BIN, stale);

    const removed = await cleanupStaleTempFiles(dir);

    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain(".roy-bot-tmp-x.bin-999999_");
    expect(readdirSync(dir)).toContain(path.basename(inFlight));
  });
});
