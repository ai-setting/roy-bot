#!/usr/bin/env bun
/**
 * @fileoverview Migration script: ~/.roy-bot/event-sources.json → v0.14
 *
 * 用途：把用户的 event-sources.json 中 bounty-es 的 systemPrompt 从 v0.13 措辞
 *       升级到 v0.14 strict email-only 措辞。
 *
 * 用法：
 *   bun scripts/migrate-event-sources-to-v0.14.ts [path/to/event-sources.json]
 *   # 默认路径：~/.roy-bot/event-sources.json
 *
 * 行为：
 * - 读取 JSON
 * - 对每个 type === "bounty-im" 的 source 更新 systemPrompt 到 v0.14 措辞
 * - 如果 source 仍有 legacy 'address' 字段，删除并加 warning（不会修改 email）
 * - 写回 JSON（pretty-print 2 空格）
 * - 备份原文件到 .bak
 *
 * 安全：
 * - 干跑模式：`bun scripts/migrate-event-sources-to-v0.14.ts --dry-run`
 * - 自动备份：原文件保存为 .event-sources.json.v0.13.bak
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_CONFIG_PATH = join(homedir(), ".roy-bot", "event-sources.json");

interface BountyIMSource {
  id: string;
  name: string;
  type: string;
  systemPrompt?: string;
  email?: string;
  address?: string;
  profile?: string;
  [key: string]: unknown;
}

interface Config {
  version: string;
  sources: BountyIMSource[];
}

/**
 * v0.14 措辞的 systemPrompt 模板
 *
 * 与 ~/.roy-bot/event-sources.json 中原 v0.13 prompt 对齐（结构相同 + email 替换），
 * 但 v0.14 措辞去掉：
 * - "v0.13 email-first identity" → "v0.14 strict email-only"
 * - alias "-e, --email Alias of --server-url"（v0.14 alias 改为 -u）
 * - "--tls-verify" 字段（v0.14 改名为 --tls-skip-verify）
 */
function buildV014SystemPrompt(profileName: string, email: string, agentId: string): string {
  return `[Bounty IM Service Context]
You are processing events from a Bounty IM event source. v0.14 strict email-only.

- Your IM identity is managed by bounty profile '${profileName}':
    • email:    ${email}
    • agent_id: ${agentId}
- IM Server WebSocket URL: wss://bounty.example.example.com/ws
- IM Server HTTP endpoint (for bounty com send): https://bounty.example.example.com

To reply to a received message, use the \`bounty com send\` CLI (v0.14 strict email-only):

  bounty com send \\
    --server-url https://bounty.example.example.com \\
    --from-email ${email} \\
    --to-email   <recipient-email> \\
    --body "<reply body>"

Flags (verified via \`bounty com send --help\`):
  -F, --from-email         Sender email (v0.14 primary)              [required]
  -T, --to-email           Recipient email (v0.14 primary)            [required]
  -b, --body               Message body                                [required]
  -u, --server-url         IM server base URL with scheme              [optional]
  --tls-skip-verify        Opt-in to TLS verification (skip by default) [optional]

If the CLI is unavailable, equivalent raw HTTP POST:

  POST https://bounty.example.example.com/api/messages
  Authorization: Bearer <jwt from profile ${profileName}>
  Content-Type: application/json
  {
    "from_email": "${email}",
    "to_email":   "<recipient-email>",
    "content":    { "type": "text", "body": "<reply body>" }
  }

How to read the reply target from the event payload:
  - \`payload.replyChannel.chatId\`            -> recipient (to-email)
  - \`payload.metadata.senderId\`              -> original sender (= recipient)
  - \`payload.metadata.chatId\`                -> your identity hint
  - RecommendedAction.replyTo may contain pre-filled \`from_email\`/\`to_email\`

Important rules (v0.14 strict email-only):
1. Each event response handles ONE incoming message — produce one reply per event.
2. ALWAYS use --from-email ${email}; only --to-email changes per event.
3. The --to-email is the senderEmail of the incoming event, NOT your own email.
4. If you don't know the recipient email, default to no reply (do not guess).
5. The profile \`${profileName}\` carries the JWT — never paste the token into the reply body.
6. If TLS handshake fails (wss:// self-signed), prefer the production URL https://bounty.example.example.com (TLS verified by ingress) over insecure flags.
7. v0.14 BREAKING CHANGE: do NOT use --address flag (REMOVED). Use --from-email / --to-email ONLY.
`;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const configPath = args.find((a) => !a.startsWith("--")) ?? DEFAULT_CONFIG_PATH;

  console.log(`[migrate-event-sources-to-v0.14] Reading ${configPath}...`);

  if (!existsSync(configPath)) {
    console.error(`❌ Config file not found: ${configPath}`);
    process.exit(1);
  }

  const raw = readFileSync(configPath, "utf-8");
  const config: Config = JSON.parse(raw);

  let migratedCount = 0;
  let legacyAddressCount = 0;
  const warnings: string[] = [];

  for (const source of config.sources) {
    if (source.type !== "bounty-im") continue;

    // 1. 检查 legacy address 字段
    if (source.address !== undefined) {
      legacyAddressCount++;
      warnings.push(
        `⚠️  Source '${source.id}': legacy 'address' field detected (value: "${source.address}"). ` +
          `Removing in favor of 'email' field. v0.14 will HARD ERROR if this field is present.`,
      );
      delete source.address;
    }

    // 2. 更新 systemPrompt
    const profileName = source.profile ?? "default";
    const email = source.email ?? `<${profileName}-email>`;
    // agent_id 从 v0.13 prompt 中提取（如果有）
    const agentIdMatch = source.systemPrompt?.match(/agent_id:\s*([\w-]+)/);
    const agentId = agentIdMatch?.[1] ?? "<unknown>";

    const newPrompt = buildV014SystemPrompt(profileName, email, agentId);
    if (source.systemPrompt !== newPrompt) {
      source.systemPrompt = newPrompt;
      migratedCount++;
    }
  }

  console.log(`[migrate-event-sources-to-v0.14] Migration summary:`);
  console.log(`  - bounty-im sources: ${config.sources.filter((s) => s.type === "bounty-im").length}`);
  console.log(`  - systemPrompts updated: ${migratedCount}`);
  console.log(`  - legacy 'address' fields removed: ${legacyAddressCount}`);

  if (warnings.length > 0) {
    console.log(`\nWarnings:`);
    for (const w of warnings) console.log(`  ${w}`);
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] No files written. Run without --dry-run to apply.`);
    return;
  }

  // 3. 备份原文件
  const backupPath = `${configPath}.v0.13.bak`;
  copyFileSync(configPath, backupPath);
  console.log(`\n✓ Backup saved: ${backupPath}`);

  // 4. 写回
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  console.log(`✓ Migration complete: ${configPath}`);
  console.log(`\n建议：重启 roy-bot 验证事件源可正常加载。`);
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});