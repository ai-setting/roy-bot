/**
 * @fileoverview Markdown — Ink wrapper around the ANSI markdown renderer.
 *
 * Task #2610 stage 2: implements the prototype Markdown.tsx from
 * refs/imported/ink-tui-overhaul.
 *
 * Strategy: we do NOT re-parse markdown inside Ink. The pre-existing
 * `renderMarkdown()` helper (../render/markdown.ts) already produces
 * ANSI-styled terminal output, so we just embed that string inside a
 * <Text> element. Ink then handles terminal width, line wrapping, and
 * TTY/no-TTY stripping on top of our existing renderer.
 *
 * This is intentionally lightweight: ink <Text> supports nested ANSI
 * escapes natively, so a single <Text>{ansi}</Text> is sufficient.
 *
 * Streaming safety: renderMarkdown() handles unclosed fences and inline
 * markers gracefully, so callers can pass partial / streaming input
 * directly without preprocessing.
 */

import React from "react";
import { Text } from "ink";
import { renderMarkdown } from "../render/markdown.js";

export interface MarkdownProps {
  /** Markdown source text (may be partial / streaming). */
  text: string;
  /** Terminal width (columns). Defaults to process.stdout.columns or 80. */
  width?: number;
}

/**
 * Render markdown text inside an Ink <Text> block. The output is a
 * single ANSI-styled string (one <Text> child), so Ink will wrap lines
 * according to its own width detection (which honors process.stdout.columns).
 *
 * For partial / streaming input this is safe: renderMarkdown() handles
 * unclosed code fences and unclosed inline markers without throwing.
 */
export const Markdown: React.FC<MarkdownProps> = ({ text, width }) => {
  const effectiveWidth = width ?? process.stdout.columns ?? 80;
  const rendered = renderMarkdown(text, { width: effectiveWidth });

  if (!rendered) {
    return null;
  }

  return <Text>{rendered}</Text>;
};

export default Markdown;