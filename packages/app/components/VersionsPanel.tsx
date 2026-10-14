// Settings › versions (wireframe U02): every part this window knows about,
// what it runs and what is out. The desktop app's numbers come from its
// updater (lib/desktopUpdate.ts); the hub's, the interface's and each node's
// from the hub (lib/versions.ts). The two lines are never compared.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { colors } from "@/lib/colors";
import { checkDesktopUpdate, restartToUpdate, useDesktopUpdate } from "@/lib/desktopUpdate";
import { desktopRole, isDesktopShell } from "@/lib/desktopHub";
import { detectOS } from "@/lib/platform";
import {
  checkedAgo,
  hubBehind,
  latestRelease,
  OLDER_THAN_REPORTING,
  refreshVersions,
  useVersions,
  type HubAnswer,
} from "@/lib/hubVersions";
import { Button, fontProse, StepMark } from "./Primitives.web";

export function VersionsPanel({ hubAddress }: { hubAddress: string }) {
  const versions = useVersions();
  const update = useDesktopUpdate();
  const desktop = isDesktopShell();
  const [isHub, setIsHub] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    desktopRole().then((role) => setIsHub(role === "hub")).catch(() => {});
  }, [desktop]);

  const checkNow = () => {
    void refreshVersions();
    if (desktop) void checkDesktopUpdate();
  };
  const checking = versions.checking || update.phase === "checking" || update.phase === "downloading";
  const latest = latestRelease(versions.hub);
  const hub = hubRunning(versions.hub);
  const thisMachine = detectOS() === "macos" ? "this mac" : "this computer";
  const current = (
    <span style={{ display: "inline-flex", gap: 6, color: colors.accent }}>
      <StepMark state="done" label="Current" />
      current
    </span>
  );

  return (
    <div data-testid="settings-versions" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 240px", fontFamily: fontProse, fontSize: 13, lineHeight: "20px", color: colors.fg2 }}>
          Everything this hub knows about.
          {versions.checkedAt ? ` Checked ${checkedAgo(versions.checkedAt, Date.now())}.` : ""}
          {desktop && isHub ? " On this Mac the hub and node are bundled with the app and update with it." : ""}
        </div>
        <Button size="sm" kind="secondary" disabled={checking} onClick={checkNow}>
          {checking ? "checking…" : "check now"}
        </Button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 560, borderCollapse: "collapse", fontFamily: "var(--font-display)", fontSize: 13, color: colors.fg0 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              {["part", "where", "running", "latest", "action"].map((heading) => (
                <th key={heading} scope="col" style={{ ...cell, padding: "8px 0", fontSize: 12, fontWeight: 500, color: colors.fg3, textAlign: heading === "action" ? "right" : "left" }}>
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {desktop ? (
              <Row
                part="desktop app"
                where={thisMachine}
                running={update.current ?? "…"}
                behind={!!update.available}
                latest={update.available ?? (update.checkedAt && update.current ? update.current : "—")}
                action={update.available ? (
                  <Button size="sm" testId="versions-restart-to-update" disabled={update.phase === "installing"} onClick={() => void restartToUpdate()}>
                    {update.phase === "installing" ? "installing…" : "restart to update"}
                  </Button>
                ) : update.checkedAt && update.current ? current : null}
              />
            ) : null}
            <Row
              part="hub"
              where={desktop && isHub ? `${thisMachine} · bundled` : hubAddress}
              running={hub}
              behind={hubBehind(versions.hub)}
              latest={latest ?? "—"}
              action={desktop && isHub ? <Quiet>with the app</Quiet> : hubBehind(versions.hub) ? <Quiet>update on that mac</Quiet> : latest ? current : null}
            />
            {(versions.nodes ?? []).map((node) => (
              <Row
                key={node.id}
                part="node"
                where={node.name}
                running={node.version ?? OLDER_THAN_REPORTING}
                behind={node.update_available}
                latest={latest ?? "—"}
                action={node.update_available ? <Quiet>update on that mac</Quiet> : latest ? current : null}
              />
            ))}
            <Row
              part="interface"
              where="served by the hub"
              running={versions.hub?.kind === "known" ? `built into hub ${versions.hub.version.hub}` : hub}
              behind={false}
              latest={latest ? `with hub ${latest}` : "—"}
              action={<Quiet muted>follows the hub</Quiet>}
            />
          </tbody>
        </table>
      </div>
      {update.error ? <div role="alert" style={{ fontFamily: fontProse, fontSize: 12, color: colors.err, overflowWrap: "anywhere" }}>{update.error}</div> : null}
    </div>
  );
}

/** What the hub runs, in the table's words. */
function hubRunning(hub: HubAnswer | null): string {
  if (hub?.kind === "known") return hub.version.hub;
  if (hub?.kind === "older") return OLDER_THAN_REPORTING;
  return hub ? "unknown" : "…";
}

const cell: CSSProperties = { padding: "12px 0", paddingRight: 16, borderBottom: `1px solid ${colors.lineSoft}`, verticalAlign: "middle" };

function Row({ part, where, running, behind, latest, action }: {
  part: string;
  where: string;
  running: string;
  behind: boolean;
  latest: string;
  action: ReactNode;
}) {
  return (
    <tr>
      <td style={cell}>{part}</td>
      <td style={{ ...cell, color: colors.fg2 }}>{where}</td>
      <td style={{ ...cell, color: behind ? colors.err : colors.fg0 }}>{running}</td>
      <td style={cell}>{latest}</td>
      <td style={{ ...cell, paddingRight: 0, textAlign: "right", fontSize: 12 }}>{action}</td>
    </tr>
  );
}

function Quiet({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <span style={{ color: muted ? colors.fg3 : colors.fg2 }}>{children}</span>;
}
