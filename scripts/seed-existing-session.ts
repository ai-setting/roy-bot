/**
 * @fileoverview Seed script to add AI SDK v6 messages to an existing session
 */

import { SQLiteSessionStore } from "../packages/core/src/env/session/storage/sqlite";
import { randomUUID } from "crypto";
import { join } from "path";
import { homedir } from "os";

async function seedExistingSession() {
  // Use the official database path
  const dbPath = join(homedir(), ".local/share/roy-bot/sessions.db");
  
  // Target session ID
  const targetSessionId = process.argv[2] || "session_31ea74e1-9ba8-47a1-8e6d-d2d2c0f72207";
  
  console.log(`🔧 Seeding session: ${targetSessionId}`);
  console.log(`   Database: ${dbPath}\n`);

  const store = new SQLiteSessionStore(dbPath);

  try {
    // Check if session exists
    const session = await store.get(targetSessionId);
    if (!session) {
      console.error(`❌ Session not found: ${targetSessionId}`);
      return;
    }
    console.log(`✅ Found session: ${session.title}`);
    console.log(`   Current messages: ${session.messageCount}\n`);

    // 1. User message
    const userMsgId = await store.addMessage(targetSessionId, {
      role: "user",
      content: "帮我搜索一下代码中的 TODO 注释，并统计数量",
      parts: [
        { type: "text", content: "帮我搜索一下代码中的 TODO 注释，并统计数量" }
      ]
    });
    console.log(`✅ Added user message: ${userMsgId}`);

    // 2. Assistant with reasoning + tool call
    const assistant1Id = await store.addMessage(targetSessionId, {
      role: "assistant",
      content: "我来帮你搜索 TODO 注释",
      parts: [
        { 
          type: "reasoning", 
          content: "用户想要搜索代码中的 TODO 注释并统计数量。我应该使用 grep 工具来搜索 'TODO' 关键字。",
          reasoningType: "core",
          state: "completed",
          metadata: { tokenCount: 85 }
        },
        { type: "text", content: "我来帮你搜索 TODO 注释" },
        { 
          type: "tool-call",
          toolCallId: "call_" + randomUUID().slice(0, 8),
          toolName: "grep",
          arguments: { pattern: "TODO", path: "/src", recursive: true },
          state: "pending"
        }
      ]
    });
    console.log(`✅ Added assistant message: ${assistant1Id}`);

    // 3. Tool result
    const toolMsgId = await store.addMessage(targetSessionId, {
      role: "tool",
      content: "找到 5 处 TODO:\n1. src/index.ts:15\n2. src/auth.ts:42\n3. src/utils.ts:8\n4. src/api.ts:100\n5. src/db.ts:55",
      parts: [
        { 
          type: "tool-result",
          toolCallId: "call_test",
          toolName: "grep",
          output: "找到 5 处 TODO:\n1. src/index.ts:15\n2. src/auth.ts:42\n3. src/utils.ts:8\n4. src/api.ts:100\n5. src/db.ts:55",
          state: "completed"
        }
      ]
    });
    console.log(`✅ Added tool result: ${toolMsgId}`);

    // 4. Assistant final response
    const assistant2Id = await store.addMessage(targetSessionId, {
      role: "assistant",
      content: "代码中共找到 **5 处 TODO 注释**。",
      parts: [
        { type: "reasoning", content: "根据结果整理成列表。", reasoningType: "core", state: "completed" },
        { type: "text", content: "代码中共找到 **5 处 TODO 注释**：" },
        { type: "text", content: "1. src/index.ts:15" },
        { type: "text", content: "2. src/auth.ts:42" },
        { type: "text", content: "3. src/utils.ts:8" },
        { type: "text", content: "4. src/api.ts:100" },
        { type: "text", content: "5. src/db.ts:55" }
      ]
    });
    console.log(`✅ Added assistant response: ${assistant2Id}`);

    // 5. Second user query
    const userMsg2Id = await store.addMessage(targetSessionId, {
      role: "user",
      content: "好的，那帮我看看 src/auth.ts 中的 TODO 具体内容",
      parts: [
        { type: "text", content: "好的，那帮我看看 src/auth.ts 中的 TODO 具体内容" }
      ]
    });
    console.log(`✅ Added second user message: ${userMsg2Id}`);

    // 6. Assistant with file read
    const assistant3Id = await store.addMessage(targetSessionId, {
      role: "assistant",
      content: "让我查看 auth.ts 文件",
      parts: [
        { type: "reasoning", content: "需要读取文件来查看具体内容。", reasoningType: "core", state: "completed" },
        { type: "text", content: "让我查看 auth.ts 文件" },
        {
          type: "tool-call",
          toolCallId: "call_" + randomUUID().slice(0, 8),
          toolName: "readFile",
          arguments: { path: "src/auth.ts", startLine: 35, endLine: 50 },
          state: "pending"
        }
      ]
    });
    console.log(`✅ Added assistant with tool call: ${assistant3Id}`);

    // 7. Tool result with file content
    const toolMsg2Id = await store.addMessage(targetSessionId, {
      role: "tool",
      content: "// TODO: 添加 token 刷新逻辑\n// 当前问题：access_token 过期后需要重新登录",
      parts: [
        {
          type: "tool-result",
          toolCallId: "call_test2",
          toolName: "readFile",
          output: "// TODO: 添加 token 刷新逻辑\n// 当前问题：access_token 过期后需要重新登录",
          state: "completed"
        }
      ]
    });
    console.log(`✅ Added file content: ${toolMsg2Id}`);

    // 8. Final assistant response
    const assistant4Id = await store.addMessage(targetSessionId, {
      role: "assistant",
      content: "找到 auth.ts 的 TODO 内容。",
      parts: [
        { type: "text", content: "在 src/auth.ts 找到 TODO：" },
        { type: "text", content: "// TODO: 添加 token 刷新逻辑" },
        { type: "text", content: "// 当前问题：access_token 过期后需要重新登录" },
        { type: "text", content: "\n需要我帮你实现这个功能吗？" }
      ]
    });
    console.log(`✅ Added final response: ${assistant4Id}`);

    // Verify
    const updatedSession = await store.get(targetSessionId);
    const messages = await store.getMessages(targetSessionId);
    
    console.log("\n" + "=".repeat(60));
    console.log(`📊 Session: ${updatedSession?.title}`);
    console.log(`📊 Total messages: ${messages.length}`);
    console.log("=".repeat(60));

  } finally {
    await store.close();
  }
}

seedExistingSession().catch(console.error);
