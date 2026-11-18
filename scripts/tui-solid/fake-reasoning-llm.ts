/**
 * fake-reasoning-llm.ts — minimal OpenAI-compatible SSE server that streams
 * **reasoning_content** deltas followed by normal content. Task #4278 片6 E2E.
 *
 * Usage: bun run scripts/tui-solid/fake-reasoning-llm.ts [--port N] [--hold-ms N]
 */
const args = process.argv.slice(2);
const getArg = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};
const port = Number(getArg("--port", "0"));
const chunkMs = Number(getArg("--chunkMs", "700"));
// How long the reasoning takes before content starts (keeps us in "thinking").
const holdMs = Number(getArg("--hold-ms", "4000"));

const REASONING = [
  "Let me parse the request: the user wants a short greeting.",
  "I should reply with one friendly sentence only.",
  "No tools are needed for this — plain text is enough.",
];
const ANSWER = "Hello! Great to see you — how can I help today?";

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    try { const fs = await import("node:fs"); fs.appendFileSync("/tmp/fake-llm-reqs.log", new Date().toISOString()+" "+url.pathname+"\n"); } catch {}  /* REQLOG */
    if (!url.pathname.endsWith("/chat/completions")) {
      return new Response("not found", { status: 404 });
    }
    // Drain the request body (we don't need it).
    try { await req.text(); } catch {}

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const mk = (delta: Record<string, unknown>, finish: string | null = null) => ({
          id: "chatcmpl-fake",
          object: "chat.completion.chunk",
          model: "fake-reasoning",
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        const send = (o: unknown) => controller.enqueue(encoder.encode(sse(o)));
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        send(mk({ role: "assistant" }));
        // Phase 1: **reasoning only** (`reasoning_content`), exactly how real
        // providers (MiniMax-M3, DeepSeek) stream it — the answer has not
        // started yet, so the TUI stays in "thinking". pi-ai maps this to
        // `thinking_delta` → llm.reasoning (see adapter-pi-ai.ts +
        // llm.ts#consumeStreamAndGetResult).
        for (const line of REASONING) {
          send(mk({ reasoning_content: line + "\n" }));
          await sleep(chunkMs);
        }
        await sleep(Math.max(0, holdMs - REASONING.length * chunkMs));
        // Phase 2: the visible answer (`content` only).
        for (const piece of ANSWER.split(" ")) {
          send(mk({ content: piece + " " }));
          await sleep(120);
        }
        send(mk({}, "stop"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  },
});
console.log(`[fake-reasoning-llm] listening on http://127.0.0.1:${server.port}/v1`);
