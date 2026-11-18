# 发布 & 本地安装 roy-bot（standalone 二进制）

三种「把 roy-bot 装到机器上」的通道，各自适用场景不同，互不阻塞：

| 通道 | 命令 | 是否需要先发布到 npm | 适用场景 |
|---|---|---|---|
| ① 本地安装（推荐自用） | `bun run install:local` | ❌ 不需要 | 自己这台机器用最新构建；发布前自测 |
| ② npm 本地包安装 | `bun run verify:npm-install` / `npm install -g ./packages/roy-bot-standalone` | ❌ 不需要 | 验证「npm 安装链路」真的能跑（bin 链接、run.js、平台判定） |
| ③ npm 公网安装 | `npm install -g @ai-setting/roy-bot-standalone` | ✅ 需要 | 给用户/其他机器用 |

## ① 本地安装（不走 npm）

```bash
bun run install:local                 # 装到 ~/.local/bin/roy-bot（当前平台二进制）
bun run install:local -- --build      # 先构建再安装
bun run install:local -- --link       # 软链而不是拷贝（改完代码重建即生效，适合开发）
bun run install:local -- --system     # 装到 /usr/local/bin（可能需要 sudo）
bun run install:local -- --uninstall  # 卸载
bun run install:local -- --dry-run    # 只看会做什么
```

要点：

- 纯文件操作，**完全不碰 npm / registry**，几十毫秒完成（copy 走 reflink）。
- 默认来源 `packages/roy-bot-standalone/bin/roy-bot-<platform>-<arch>`，
  没有或过期时用 `--build` 重新构建。
- 安装后会执行 `<prefix>/roy-bot --version` 自检；不在 PATH 时会打印 `export PATH=...`。
- 覆盖正在运行的 `roy-bot` 前会先删旧文件，避免 `Text file busy`。

## ② npm 安装链路的本地验收（发布前必跑）

```bash
bun run verify:npm-install              # npm pack → npm install -g 到临时 prefix → 冒烟测试
bun run verify:npm-install -- --keep    # 保留临时目录现场
bun run verify:npm-install -- --pack-only
```

它会：

1. `npm pack`（与真正 publish 上传的是同一份内容）；
2. 打印 tarball 体积、包含哪些平台二进制，**体积偏大 / 混入其他平台旧二进制时告警**；
3. `npm install -g --prefix <临时目录> <tarball>`，检查 `bin` 字段与全局命令链接是否生成；
4. 跑 `<prefix>/bin/roy-bot --version` 冒烟测试。

这样「发布前验证 npm 安装方式」就不需要先真的发到 npmjs 上了。

## ③ 公网发布：`bun run publish:full`

### standalone 体积规则（本次修复的核心）

`packages/roy-bot-standalone/bin/` 是**跨版本累积**的目录：

- 本地发布走 `bun run build:cli:prod --single`，只重建**当前平台**；
- 但 `package.json` 的 `files` 通配会把 `bin/` 下**所有**二进制打进 tarball；
- 结果：单平台发布也产出 **169 MB** tarball（未压缩 494 MB），并且把几个月前的旧二进制发给了 mac/win 用户。

现在 `publish-full.ts` 会：

1. 用「本次构建开始时间戳」区分 **fresh / stale**（`scripts/publish-full-helpers.ts`）；
2. 只发布 fresh 的平台，并把 stale 二进制临时移出 `bin/`（发布后还原）；
3. 动态裁剪 manifest：`files` / `os` / `cpu` / `bin` 只保留要发布的平台
   （`bin` 路径统一加 `./` 前缀，消除 npm 的 `bin[...] was invalid and removed` 告警）；
4. 如果 `bin/` 里没有任何本次构建的二进制 → **直接报错**，不允许发布过期产物。

效果：本地单平台发布 **169 MB → 37.5 MB**（实测，4.5×）。

需要注意的取舍：单平台版本的 `os`/`cpu` 会被收窄到该平台，
mac/win 用户安装这个版本会拿到 `EBADPLATFORM`（比装上一个过期二进制更诚实）。

**要发布覆盖全平台的版本**，用 `--platforms` 显式列出：

```bash
bun run publish:full -- --platforms linux-x64,darwin-arm64,darwin-x64,windows-x64,linux-arm64
```

> ⚠️ 不能只靠「先跑一次 `build:cli:prod` 再跑 `publish:full`」来达到全平台：
> `publish:full` 会记录自己的构建开始时间戳，并在内部执行构建。
> 如果它只构建当前平台（`--single`），其它平台即使一分钟前刚构建过，
> mtime 也早于这个时间戳 → 会被判定为 stale 排除，最终仍只发单平台。
> 因此**目标平台列表和构建命令必须一致**：`--platforms` 决定构建方式
> （只要求当前平台 → `--single`；其它情况 → 全平台交叉编译）。

相关开关：

```bash
bun run publish:full -- --platforms linux-x64,darwin-arm64   # 要构建并发布的平台（默认当前平台）
bun run publish:full -- --allow-stale-binaries        # 明确允许发布 bin/ 里的旧二进制（默认禁止）
bun run publish:full -- --registry-timeout=1800       # standalone 发布后等待 registry 出现的上限（秒，默认 1500）
bun run publish:full -- --tag=beta                    # 发布到指定 dist-tag
bun run publish:full:dry-run                          # 会打印 standalone 裁剪后的 manifest + npm pack 预览
```

> `--registry-timeout` 必须是大于 0 的有限数字；传 `abc` / 空值 / `0` / `Infinity` 会**直接报错**。
> （旧实现会得到 `NaN`，而 `已等待 >= NaN` 恒为 false → 轮询永不超时。）

### 其它已修复的问题

- **`npm publish` 不再 `.quiet()`**：以前 npm 的输出（含上传进度、错误）全被吞掉，
  终端会停在上一行日志上，看起来像卡死。
- **`prepublishOnly` 从「重复构建」改成「只校验」**：`packages/roy-bot-standalone` 的
  `prepublishOnly` 原来会在校验之后、打包之前再跑一次 `build:cli:prod --single`，
  既浪费时间（~40s 静默），又把刚刚校验过的二进制替换掉。
  但它**不能改成 no-op**：那样裸 `npm publish` 会带着 `bin/` 里跨版本累积的旧二进制一起发出去，
  正是本次要修的问题。现在它跑 `sh scripts/prepublish-check.sh`：
  - 缺少当前平台二进制 → **失败**
  - 二进制内嵌版本 ≠ `package.json` 版本（说明没重新构建）→ **失败**
  - `bin/` 还有其它平台旧二进制 → 警告 + 建议改用 `publish:full`
  - 绕过：`STANDALONE_SKIP_PREPUBLISH_CHECK=1 npm publish`

  实现刻意用 POSIX `sh`（只用 `sed`/`strings`，不依赖 bun / node / 仓库其它目录），
  因为 CI 的 `publish-standalone` job 只下载 artifacts、没有 checkout 也没装 bun。

- **异常/中断时一定还原**：发布窗口长达 20+ 分钟，期间 Ctrl-C 以前会留下
  「manifest 已被裁剪 + 旧二进制被移出 `bin/`」的破损工作区
  （Bun/Node 收到 SIGINT 不会展开调用栈，`finally` 会被跳过）。
  现在用 `createRestoreGuard` 注册 SIGINT/SIGTERM/SIGHUP，先还原再退出；
  还原动作幂等，且**只**还原本次移动过的文件——
  `.publish-test/` 和 `packages/roy-bot-standalone/.stale-binaries/` 里属于上一次中断运行的滞留文件会被保留并提示，
  不再被 `rm -rf` 掉（那会永久删除 100MB 级的二进制）。
  这两个临时目录已加入 `.gitignore`，避免被 `git clean -fd` 一起清掉。
- **standalone 发布后带进度等待 registry 传播**：npm 对大 tarball 会先返回 `202`
  再后台处理，实测 169 MB 的包要 **~20 分钟**才在 registry 上可见；
  原来只有 6 分钟的静默重试窗口，会误报失败。

## 排查「publish:full 卡住」

按出现顺序检查：

1. `npm publish` 阶段：standalone 的 tarball 很大，上传 + npm 后台处理要十几分钟，
   期间只有 `Running: npm publish ...` 一行日志；
2. `等待 standalone staged → latest promote`：固定 30s；
3. `registry 传播` 轮询：每 20s 打印一次进度，直到版本在 registry 上出现（默认上限 25 分钟）；
4. `Phase 3.1 预检` 的指数退避重试（15/30/60s，最多 8 次）。

任意时刻都可以用下面命令独立确认发布结果，不必依赖脚本输出：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/@ai-setting%2froy-bot-standalone/<version>
npm view @ai-setting/roy-bot-standalone@<version> version
```
