import { memo, useEffect, useState } from "react";

import { colors } from "@/lib/colors";
import { TerminalTailBuffer } from "@/lib/terminalTailBuffer";
import { useTerminalPreviewOutputSource } from "@/lib/terminalPreviewMuxReact";
import { rem } from "@/lib/rem";

interface TerminalPreviewTextProps {
  machineId: string;
  terminalId: string;
  cols: number;
  rows: number;
  reachable: boolean;
  enabled?: boolean;
  maxLines?: number;
  maxLineWidth?: number;
  fontSize?: number;
  lineHeightPx?: number;
  padding?: number;
  pausedLabel?: string;
}

function TerminalPreviewTextComponent({
  machineId,
  terminalId,
  cols,
  rows,
  reachable,
  enabled = true,
  maxLines = 8,
  maxLineWidth = 160,
  fontSize = 11,
  lineHeightPx = 15,
  padding = 10,
  pausedLabel = "Live preview paused",
}: TerminalPreviewTextProps) {
  const [tailLines, setTailLines] = useState<string[]>([]);
  const previewSource = useTerminalPreviewOutputSource({
    enabled: reachable && enabled,
    machineId,
    terminalId,
    cols,
    rows,
  });

  useEffect(() => {
    if (!previewSource) {
      setTailLines([]);
      return;
    }

    const tail = new TerminalTailBuffer({
      maxLines,
      maxLineWidth,
    });
    let raf = 0;
    let pending: string[] | null = null;

    const flush = () => {
      raf = 0;
      if (!pending) return;
      setTailLines(pending);
      pending = null;
    };

    const unsubscribe = previewSource.subscribe((chunk) => {
      pending = tail.append(chunk);
      if (raf === 0) raf = requestAnimationFrame(flush);
    });

    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      unsubscribe();
    };
  }, [maxLineWidth, maxLines, previewSource]);

  if (!reachable) return null;

  if (!previewSource) {
    return (
      <div
        data-testid={`terminal-preview-paused-${terminalId}`}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
          padding: "0 20px",
          textAlign: "center",
          color: colors.fg3,
        }}
      >
        <span style={{ fontSize: rem(12), fontWeight: 600 }}>{pausedLabel}</span>
      </div>
    );
  }

  return (
    <pre
      data-testid={`terminal-preview-text-${terminalId}`}
      aria-hidden="true"
      style={{
        width: "100%",
        height: maxLines * lineHeightPx + padding * 2,
        margin: 0,
        padding,
        boxSizing: "border-box",
        overflow: "hidden",
        color: colors.termFg,
        fontFamily: "var(--font-mono)",
        fontSize,
        lineHeight: `${lineHeightPx}px`,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        opacity: tailLines.length > 0 ? 1 : 0.4,
      }}
    >
      {tailLines.join("\n")}
    </pre>
  );
}

export const TerminalPreviewText = memo(TerminalPreviewTextComponent);
