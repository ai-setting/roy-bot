/**
 * @fileoverview StatusBar — Ink footer status line, compact mode (Task #4160).
 */

import React from "react";
import { Box, Text } from "ink";
import { getTheme } from "./theme.js";

export interface StatusBarProps {
  model?: string;
  workdir?: string;
  tokenCount?: number;
  columns?: number;
}

function detectColumns(): number {
  const c = process.stdout?.columns;
  if (typeof c === "number" && c > 0) return c;
  return 80;
}

const WORKDIR_TAIL_MAX = 30;
const MODEL_NARROW_MAX = 24;

export function shortenWorkdir(input: string | undefined): string | undefined {
  if (!input) return input;
  if (input.length <= WORKDIR_TAIL_MAX) return input;
  const tail = input.slice(input.length - WORKDIR_TAIL_MAX);
  return `\u2026/${tail}`;
}

export function clipModel(input: string | undefined, max = MODEL_NARROW_MAX): string | undefined {
  if (!input) return input;
  if (input.length <= max) return input;
  return input.slice(0, max - 1) + "\u2026";
}

export interface RenderedSegment {
  text: string;
  color: "primary" | "accent" | "muted";
  dimPrefix?: string;
}

export function planSegments(
  props: Pick<StatusBarProps, "model" | "workdir" | "tokenCount">,
  columns: number,
): RenderedSegment[] {
  const segs: RenderedSegment[] = [];
  const tier = columns >= 80 ? 4 : columns >= 60 ? 3 : columns >= 40 ? 2 : 1;

  if (props.model) {
    const text = tier === 1 ? clipModel(props.model) ?? "" : props.model;
    segs.push({ text, color: "primary", dimPrefix: "\uD83E\uDD16 " });
  }
  if (tier >= 4 || tier === 3) {
    if (props.workdir) {
      segs.push({
        text: shortenWorkdir(props.workdir) ?? "",
        color: "muted",
        dimPrefix: "\uD83D\uDCC1 ",
      });
    }
  }
  if (tier >= 4 || tier === 3 || tier === 2) {
    if (typeof props.tokenCount === "number") {
      segs.push({ text: `n=${props.tokenCount}`, color: "accent", dimPrefix: "" });
    }
  }
  if (tier >= 4) {
    segs.push({ text: "Ctrl+C to exit", color: "muted" });
  }
  return segs;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  model,
  workdir,
  tokenCount,
  columns,
}) => {
  const theme = getTheme();
  const cols = typeof columns === "number" ? columns : detectColumns();
  const segs = planSegments({ model, workdir, tokenCount }, cols);

  if (segs.length === 0) {
    return <Box paddingX={1} />;
  }

  return (
    <Box paddingX={1} flexDirection="row">
      {segs.map((seg, i) => {
        const color = seg.color === "primary"
          ? theme.primary
          : seg.color === "accent"
            ? theme.accent
            : theme.muted;
        const isFirst = i === 0;
        return (
          <React.Fragment key={i}>
            {!isFirst ? <Text dimColor>{" \u00b7 "}</Text> : null}
            {seg.dimPrefix ? <Text dimColor>{seg.dimPrefix}</Text> : null}
            <Text color={color}>{seg.text}</Text>
          </React.Fragment>
        );
      })}
    </Box>
  );
};

export default StatusBar;
