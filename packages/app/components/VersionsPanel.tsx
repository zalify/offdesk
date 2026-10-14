// Settings › versions (wireframe U02): every part this window knows about,
// what it runs and what is out. The desktop app's numbers come from its
// updater (lib/desktopUpdate.ts); the hub's, the interface's and each node's
// from the hub (lib/versions.ts). The two lines are never compared.

import type { CSSProperties, ReactNode } from "react";

import { colors } from "@/lib/colors";
import { checkDesktopUpdate, restartToUpdate, useDesktopUpdate } from "@/lib/desktopUpdate";
import { isDesktopShell } from "@/lib/desktopHub";
import { useBundledServices } from "@/lib/bundledServices";
import { detectOS } from "@/lib/platform";
import {
  bundledPart,
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
  // On the hub machine, the hub and node services that run from this app.
  const services = useBundledServices();
  const bundled = desktop && !!services?.bundled;

  const checkNow = () => {
    void refreshVersions();
    if (desktop) void checkDesktopUpdate();
  };
  const checking = versions.checking || update.checking;
  const latest = latestRelease(versions.hub);
  const hub = hubRunning(versions.hub);
  const thisMachine = detectOS() === "macos" ? "this mac" : "this computer";
  const current = (
    <span style={{ display: "inline-flex", gap: 6, color: colors.accent }}>
      <StepMark state="done" label="Current" />
      current
    </span>
  );
  const newer = <span style={{ color: colors.accent }}>↑ {latest}</span>;
  // A part this app ships, on the hub machine (lib/versions.ts bundledPart).
  const bundledRow = (running: string | null, shipped: string | null, behind: boolean) => {
    const row = bundledPart(running, shipped, behind, !!update.available);
    return {
      behind: row.red,
      latest: row.newer ? newer : latest ?? "—",
      action: row.action === "current" ? (latest ? current : null) : <Quiet>{row.action}</Quiet>,
    };
  };
  const hubRow = bundled
    ? bundledRow(versions.hub?.kind === "known" ? versions.hub.version.hub : null, services?.hub_version ?? null, hubBehind(versions.hub))
    : {
        behind: hubBehind(versions.hub),
        latest: latest ?? "—",
        action: hubBehind(versions.hub) ? <Quiet>update on that mac</Quiet> : latest ? current : null,
      };

  return (
    <div data-testid="settings-versions" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 240px", fontFamily: fontProse, fontSize: 13, lineHeight: "20px", color: colors.fg2 }}>
          Everything this hub knows about.
          {versions.checkedAt ? ` Checked ${checkedAgo(versions.checkedAt, Date.now())}.` : ""}
          {bundled ? " On this Mac the hub and node are bundled with the app and update with it." : ""}
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
              where={bundled ? `${thisMachine} · bundled` : hubAddress}
              running={hub}
              {...hubRow}
            />
            {(versions.nodes ?? []).map((node) => {
              const local = bundled && node.id === services?.machine_id;
              const row = local
                ? bundledRow(node.version, services?.node_version ?? null, node.update_available)
                : {
                    behind: node.update_available,
                    latest: latest ?? "—",
                    action: node.update_available ? <Quiet>update on that mac</Quiet> : latest ? current : null,
                  };
              return (
                <Row
                  key={node.id}
                  part="node"
                  where={local ? `${node.name} · bundled` : node.name}
                  running={node.version ?? OLDER_THAN_REPORTING}
                  {...row}
                />
              );
            })}
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
      {services?.error ? <div role="alert" style={{ fontFamily: fontProse, fontSize: 12, color: colors.err, overflowWrap: "anywhere" }}>{services.error}</div> : null}
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
  latest: ReactNode;
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
