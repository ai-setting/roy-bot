/**
 * Fake OpenAI-compatible LLM server for ESC cascade E2E tests.
 *
 * Behavior:
 *   - /v1/chat/completions requests:
 *     - First request (tool call phase): responds with a workflow_run tool call
 *     - Subsequent requests (agent nodes inside workflow): streams chunks
 *       every `chunkIntervalMs`, never completing — simulates blocking agent.
 *   - On `req.signal.aborted`, closes the stream and records abort count.
 *
 * Used by task-2275-esc-cascade-pty-e2e.test.ts to verify that ESC
 * propagates through real CLI → workflow runtime → agent LLM stream.
 */

export interface FakeLLMServerOptions {
  port?: number;
  chunkIntervalMs?: number;
}

interface ChatRecord {
  path: string;
  body: any;
  aborted: boolean;
  completedAt?: number;
  isStream: boolean;
}

export class FakeLLMServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  public port: number = 0;
  public requests: ChatRecord[] = [];
  private _toolCallSent = false;
  private opts: Required<FakeLLMServerOptions>;

  constructor(opts: FakeLLMServerOptions = {}) {
    this.opts = {
      port: opts.port ?? 0,
      chunkIntervalMs: opts.chunkIntervalMs ?? 200,
    };
  }

  async start(): Promise<string> {
    const self = this;
    const server = Bun.serve({
      port: this.opts.port,
      hostname: "127.0.0.1",
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        if (url.pathname === "/health") {
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname.endsWith("/chat/completions")) {
          return self.handleChat(req);
        }
        return new Response("not found", { status: 404 });
      },
    });
    this.server = server;
    this.port = server.port ?? 0;
    return `http://127.0.0.1:${this.port}/v1`;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  get streamAbortCount(): number {
    return this.requests.filter((r) => r.aborted && r.isStream).length;
  }

  get toolCallSent(): boolean {
    return this._toolCallSent;
  }

  private async handleChat(req: Request): Promise<Response> {
    const self = this;
    const isStream = true;
    const reqRecord: ChatRecord = {
      path: new URL(req.url).pathname,
      body: null,
      aborted: false,
      isStream,
    };
    try {
      reqRecord.body = await req.clone().json();
    } catch {
      reqRecord.body = null;
    }
    this.requests.push(reqRecord);
    console.error(`[FakeLLM] ${reqRecord.path} request #${this.requests.length}, stream=${isStream}, body keys=${Object.keys(reqRecord.body ?? {}).join(",")}`);

    const encoder = new TextEncoder();
    let aborted = false;
    let chunkId = 0;

    const readable = new ReadableStream({
      async start(controller) {
        if (!self._toolCallSent) {
          self._toolCallSent = true;
          const toolChunk = {
            id: "chatcmpl-fake-tool",
            object: "chat.completion.chunk",
            model: "fake-model",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  content: "starting workflow_run",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_workflow_1",
                      type: "function",
                      function: {
                        name: "workflow_run",
                        arguments: JSON.stringify({ workflow_name: "blocking-test" }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          };
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(toolChunk)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch {}
          return;
        }

        const sendChunk = () => {
          if (aborted) return;
          const chunk = {
            id: `chatcmpl-fake-${chunkId}`,
            object: "chat.completion.chunk",
            model: "fake-model",
            choices: [
              {
                index: 0,
                delta: { content: `chunk-${chunkId} ` },
                finish_reason: null,
              },
            ],
          };
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          } catch {
            aborted = true;
          }
          chunkId++;
        };

        sendChunk();
        const interval = setInterval(() => {
          if (aborted) {
            clearInterval(interval);
            return;
          }
          sendChunk();
        }, self.opts.chunkIntervalMs);

        req.signal.addEventListener("abort", () => {
          if (aborted) return;
          aborted = true;
          reqRecord.aborted = true;
          reqRecord.completedAt = Date.now();
          clearInterval(interval);
          try { controller.close(); } catch {}
        }, { once: true });
      },
      cancel() {
        if (aborted) return;
        aborted = true;
        reqRecord.aborted = true;
      },
    });

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      },
    });
  }
}
