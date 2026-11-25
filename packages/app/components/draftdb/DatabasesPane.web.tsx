// Drawer body for the "databases" mode: the list, or one open database.
import { useEffect, useState } from "react";

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
  onOpenChange,
}: {
  databases: DraftDatabase[];
  loading: boolean;
  error: string | null;
  defaultProject: string;
  compact: boolean;
  onRefresh: () => void;
  /** Lets the drawer widen itself while a database is open. */
  onOpenChange: (open: boolean) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    onOpenChange(openId !== null);
    return () => onOpenChange(false);
  }, [openId, onOpenChange]);

  if (openId) {
    return (
      <DatabaseView
        dbId={openId}
        compact={compact}
        onBack={() => {
          setOpenId(null);
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
      onOpen={setOpenId}
      onCreated={(db) => {
        onRefresh();
        setOpenId(db.id);
      }}
    />
  );
}
