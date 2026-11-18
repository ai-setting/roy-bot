/**
 * fake-md-llm.ts — minimal OpenAI-compatible SSE server that streams
 * a **markdown-rich** answer (heading / bold / table / code fence).
 * Task #4994 P4 E2E: verifies the TUI renders the reply without
 * bare `##`/`|`/``` glyphs.
 *
 * Usage: bun run scripts/tui-solid/fake-md-llm.ts [--port N] [--hold-ms N]
 */
const args = process.argv.slice(2);
const getArg = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};
const port = Number(getArg("--port", "0"));
const chunkMs = Number(getArg("--chunkMs", "400"));
const holdMs = Number(getArg("--hold-ms", "1200"));

// A markdown-rich answer exercising every P4 feature:
// heading (no ##), bold, CJK table, code fence.
const ANSWER = [
  "## 核心能力",
  "",
  "这是 **加粗文本** 与 `inline code`。",
  "",
  "| 函数名 | 用途 |",
  "|---|---|",
  "| renderMarkdown | 渲染 |",
  "| visibleLength | 测宽 |",
  "",
  "```js",
  "const x = 42;",
  "```",
  "",
  "完成。",
].join("\n");

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    try { const fs = await import("node:fs"); fs.appendFileSync("/tmp/fake-md-reqs.log", new Date().toISOString()+" "+url.pathname+"\n"); } catch {}
    try {
      const fs = await import("node:fs");
      const body = await req.text();
      fs.appendFileSync("/tmp/fake-md-reqs.log", "  BODY " + body.replace(/\s+/g, " ").slice(0, 600) + "\n");
    } catch {}
    if (!url.pathname.endsWith("/chat/completions")) {
      return new Response("not found", { status: 404 });
    }
    try { await req.text(); } catch {}

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const mk = (delta: Record<string, unknown>, finish: string | null = null) => ({
          id: "chatcmpl-fake-md",
          object: "chat.completion.chunk",
          model: "fake-md",
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        const send = (o: unknown) => controller.enqueue(encoder.encode(sse(o)));
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        send(mk({ role: "assistant" }));
        await sleep(holdMs);
        // stream line by line so the TUI sees a growing markdown doc
        let completionTokens = 0;
        for (const line of ANSWER.split("\n")) {
          send(mk({ content: line + "\n" }));
          completionTokens += line.length;
          await sleep(chunkMs);
        }
        // Task #4994 (P4): the meta line needs a real `usage` block so the
        // renderer can compute `tok/s`. OpenAI-compatible SSE carries it on
        // the final chunk (when `stream_options.include_usage` is set).
        send({
          ...mk({}, "stop"),
          usage: {
            prompt_tokens: 12,
            completion_tokens: completionTokens,
            total_tokens: 12 + completionTokens,
          },
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  },
});
console.log(`[fake-md-llm] listening on http://127.0.0.1:${server.port}/v1`);
