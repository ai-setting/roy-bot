/** @jsxImportSource @opentui/solid */
/**
 * R1 PoC — 实证两个问题：
 *   1) opentui 默认是否使用 alternate screen（\e[?1049h）？各 screenMode 下行为差异？
 *   2) split-footer + writeToScrollback 能否复现 Ink <Static> 的
 *      "历史写入 scrollback、不随动态区重渲染" 语义（即不闪烁根基）？
 *
 * 用法：
 *   bun run poc-r1-screencapture.tsx --mode=alternate|main|split
 * 把 raw stdout 字节流写到 stdout，由外层 harness（pty）捕获并用正则判定控制序列。
 */
import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { createSignal, onMount, onCleanup } from "solid-js";

const arg = (n: string, d: string) => {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  return m ? m.slice(n.length + 3) : d;
};
const mode = arg("mode", "alternate") as "alternate-screen" | "main-screen" | "split-footer";

const [tick, setTick] = createSignal(0);

function App() {
  onMount(() => {
    const t = setInterval(() => setTick((v) => v + 1), 120);
    onCleanup(() => clearInterval(t));
  });
  return (
    <box style={{ flexDirection: "column" }}>
      <text content={`R1-PoC mode=${mode}`} />
      <text content={`dynamic tick=${tick()}`} />
    </box>
  );
}

const renderer = await createCliRenderer({
  screenMode: mode,
  ...(mode === "split-footer" ? { footerHeight: 4, externalOutputMode: "capture-stdout" as const } : {}),
  exitOnCtrlC: false,
  useMouse: true,
  autoFocus: false,
  openConsoleOnError: false,
  clearOnShutdown: false,
});

// split-footer 场景：把 3 条"历史"写进 scrollback（等价 Ink <Static>）
if (mode === "split-footer") {
  for (let i = 1; i <= 3; i++) {
    renderer.writeToScrollback((ctx) => {
      const { TextRenderable } = require("@opentui/core");
      const t = new TextRenderable(ctx.renderContext, { content: `HISTORY-${i} immutable scrollback row` });
      return { root: t, width: ctx.width };
    });
  }
}

await render(() => <App />, renderer);
await renderer.idle().catch(() => {});
console.error(`[R1-PoC] screenMode=${renderer.screenMode} isDestroyed=${renderer.isDestroyed}`);
setTimeout(() => {
  renderer.destroy();
  process.exit(0);
}, 1200);
