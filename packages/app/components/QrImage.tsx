import { useEffect, useState } from "react";
import { colors } from "../lib/colors";

/** Give QR images an explicit square viewport, including in desktop WebViews. */
export function QrImage({ svg, size, label }: { svg: string; size: number; label: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [svg]);
  if (failed) return <span role="alert" style={{ color: colors.err, fontSize: 12 }}>Could not display the QR code. Copy the link instead.</span>;
  return <img
    src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
    alt={label}
    aria-label={label}
    width={size}
    height={size}
    draggable={false}
    onError={() => setFailed(true)}
    style={{ display: "block", width: size, height: size, maxWidth: "100%", objectFit: "contain", flexShrink: 0 }}
  />;
}
