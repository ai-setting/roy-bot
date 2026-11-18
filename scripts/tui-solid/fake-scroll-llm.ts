/**
 * fake-scroll-llm.ts — minimal OpenAI-compatible SSE server that streams a
 * **long** answer (many lines) so the TUI message area becomes scrollable.
 *
 * Task #5077 P3 Phase 2 E2E: the scrollbar and the keyboard scroll
 * bindings can only be observed when the transcript is taller than the
 * viewport.
 *
 * Usage: bun run scripts/tui-solid/fake-scroll-llm.ts [--port N] [--lines N]
 */
const args = process.argv.slice(2);
const getArg = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};

const port = Number(getArg("--port", "0"));
const lineCount = Number(getArg("--lines", "60"));

// Each line is its own paragraph (blank line between) ⇒ the streaming
// accumulator commits them as stable history rows (see splitStable).
const lines = Array.from({ length: lineCount }, (_, i) => `scroll-row-${String(i + 1).padStart(3, "0")} content line`);
const answer = lines.join("\n\n");

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/chat/completions")) {
      const body = JSON.stringify({
        id: "chatcmpl-scroll",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "fake-scroll",
        choices: [{ index: 0, delta: { content: answer }, finish_reason: null }],
      });
      const done = JSON.stringify({
        id: "chatcmpl-scroll",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "fake-scroll",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(`data: ${body}\n\n`));
          controller.enqueue(enc.encode(`data: ${done}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    }
    if (url.pathname.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "fake-scroll", object: "model" }] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

// `port: 0` ⇒ the OS picks a free port ⇒ read it back from the server.
console.log(`fake-scroll-llm listening on http://127.0.0.1:${server.port} (${lineCount} lines)`);
