/**
 * @fileoverview Spinner — animated Ink indicator for "thinking" states.
 *
 * Task #2610 stage 2: implements the prototype Spinner from
 * refs/imported/ink-tui-overhaul tui/Spinner.tsx. Self-contained: no
 * ink-spinner dependency. Cycles through a frame list every 80ms via
 * React's useState + useEffect.
 *
 * pi-inspired: pi-mono packages/tui components spinner.
 */

import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { getTheme } from "./theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface SpinnerProps {
  /** Label displayed next to the spinner glyph. */
  label: string;
  /** Frame interval in milliseconds. Defaults to 80. */
  intervalMs?: number;
}

export const Spinner: React.FC<SpinnerProps> = ({
  label,
  intervalMs = 80,
}) => {
  const [frame, setFrame] = useState(0);
  // Task #2657 R2: route color through theme (NO_COLOR friendly)
  const theme = getTheme();

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return (
    <Text>
      <Text color={theme.primary}>{FRAMES[frame]}</Text>{" "}
      <Text dimColor>{label}</Text>
    </Text>
  );
};

export default Spinner;