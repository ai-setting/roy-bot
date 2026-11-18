import { buildWelcomeCard, stripAnsi } from "../packages/cli/src/commands/ui/welcome-card.ts";
import { writeFileSync } from "node:fs";
const card = buildWelcomeCard({ model: "MiniMax-M3", cwd: "~/work/roy", version: "1.6.18", sessionTitle: "demo" });
writeFileSync("/tmp/welcome-card.plain.txt", stripAnsi(card));
writeFileSync("/tmp/welcome-card.ansi.txt", card);
console.log(stripAnsi(card));
