// Drawer body for the "databases" mode: the list, or one open database.
import { useEffect, useRef, useState } from "react";

import type { DraftDatabase } from "@/lib/api";
import { DatabaseList } from "./DatabaseList.web";
import { DatabaseView } from "./DatabaseView.web";

export function DatabasesPane({
  databases,
  loading,
  error,
  defaultProject,
  compact,
  onRefresh,
  openRequest,
  onOpenChange,
}: {
  databases: DraftDatabase[];
  loading: boolean;
  error: string | null;
  defaultProject: string;
  compact: boolean;
  onRefresh: () => void;
  /** Asks the pane to open a database (and view), e.g. from an embed in a draft. */
  openRequest?: { id: string; viewId?: string; nonce: number } | null;
  /** Lets the drawer widen itself while a database is open. */
  onOpenChange: (open: boolean) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(openRequest?.id ?? null);
  const [openViewId, setOpenViewId] = useState<string | undefined>(openRequest?.viewId);
  const handled = useRef(openRequest?.nonce);

  useEffect(() => {
    if (!openRequest || handled.current === openRequest.nonce) return;
    handled.current = openRequest.nonce;
    setOpenId(openRequest.id);
    setOpenViewId(openRequest.viewId);
  }, [openRequest]);

  useEffect(() => {
    onOpenChange(openId !== null);
    return () => onOpenChange(false);
  }, [openId, onOpenChange]);

  if (openId) {
    return (
      <DatabaseView
        key={`${openId}|${openViewId ?? ""}`}
        dbId={openId}
        initialViewId={openViewId}
        compact={compact}
        onBack={() => {
          setOpenId(null);
          setOpenViewId(undefined);
          onRefresh();
        }}
        onChanged={onRefresh}
      />
    );
  }
  return (
    <DatabaseList
      databases={databases}
      loading={loading}
      error={error}
      defaultProject={defaultProject}
      compact={compact}
      onOpen={(id) => {
        setOpenViewId(undefined);
        setOpenId(id);
      }}
      onCreated={(db) => {
        onRefresh();
        setOpenId(db.id);
      }}
    />
  );
}
