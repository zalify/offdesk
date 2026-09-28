import { useEffect, useMemo, useRef, useState } from 'react';
import type { MachineInfo } from '@offdesk/shared';
import { CalendarDays, Folder, MessageSquare, PanelLeftClose, PanelLeftOpen, RefreshCw, X } from 'lucide-react';
import { listConversationHistory } from '@/lib/api';
import { conversationKey, historyGroups, readHistoryPreferences, type ConversationRow, type HistoryPreferences } from '@/lib/conversationHistory';

const PREFERENCES_KEY = 'offdesk:conversation-history-preferences';
interface Props {
  machines: MachineInfo[];
  isCompact: boolean;
  mobileOpen: boolean;
  onClose: () => void;
  canResume: (machineId: string) => boolean;
  onResume: (row: ConversationRow) => Promise<void>;
}
export function AgentSessionSidebar({ machines, isCompact, mobileOpen, onClose, canResume, onResume }: Props) {
  const [preferences, setPreferences] = useState<HistoryPreferences>(() => {
    try { return readHistoryPreferences(localStorage.getItem(PREFERENCES_KEY)); } catch { return readHistoryPreferences(null); }
  });
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(200);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [rowsByMachine, setRowsByMachine] = useState<Record<string, ConversationRow[]>>({});
  const [notices, setNotices] = useState<string[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const machineKey = JSON.stringify(machines.map(m => [m.id, m.name]));
  const visible = isCompact ? mobileOpen : !collapsed;
  useEffect(() => { try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* storage is optional */ } setLimit(200); }, [preferences]);
  useEffect(() => { setLimit(200); }, [search]);
  useEffect(() => {
    if (!visible) return;
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') setRefresh(n => n + 1); }, 60_000);
    return () => window.clearInterval(interval);
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const targets = JSON.parse(machineKey) as [string, string][];
    setLoading(true);
    void Promise.allSettled(targets.map(async ([id, name]) => {
      const history = await listConversationHistory(id, controller.signal);
      return { id, rows: history.sessions.map(row => ({ ...row, machineId: id, machineName: name })), warnings: history.warnings.map(w => `${name}: ${w}`) };
    })).then(results => {
      if (controller.signal.aborted) return;
      const nextNotices: string[] = [];
      setRowsByMachine(previous => {
        const next: Record<string, ConversationRow[]> = {};
        results.forEach((result, index) => {
          const [id] = targets[index];
          if (result.status === 'fulfilled') { next[id] = result.value.rows; }
          else if (previous[id]) next[id] = previous[id];
        });
        return next;
      });
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') nextNotices.push(...result.value.warnings);
        else nextNotices.push(`${targets[index][1]}: History unavailable; reconnect or update Hub and Node, then refresh. Previously loaded sessions may be out of date.`);
      });
      setNotices(nextNotices); setLoading(false);
    });
    return () => controller.abort();
  }, [machineKey, refresh, visible]);
  useEffect(() => {
    if (isCompact && mobileOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [isCompact, mobileOpen]);
  const rows = useMemo(() => Object.values(rowsByMachine).flat(), [rowsByMachine]);
  const groups = useMemo(() => historyGroups(rows, preferences, search), [rows, preferences, search]);
  const count = groups.reduce((sum,g) => sum + g.rows.length, 0);
  const update = (value: Partial<HistoryPreferences>) => setPreferences(p => ({ ...p, ...value }));
  const resume = async (row: ConversationRow) => {
    if (pending) return;
    if (!canResume(row.machineId)) { setError(`Take control of ${row.machineName} in the host menu to resume this conversation.`); return; }
    setPending(conversationKey(row)); setError('');
    try { await onResume(row); if (isCompact) onClose(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not resume conversation'); }
    finally { setPending(null); }
  };
  let rendered = 0;
  const content = <aside className="agent-history" aria-label="Agent conversations" data-testid="agent-session-sidebar">
    <header><MessageSquare size={17} /><strong>Conversations</strong>
      <button aria-label="Refresh conversations" disabled={loading} onClick={() => setRefresh(n=>n+1)}><RefreshCw size={15} className={loading ? 'history-loading' : undefined}/></button>
      <button aria-label={isCompact ? 'Close conversations' : 'Collapse conversations'} onClick={() => isCompact ? onClose() : setCollapsed(true)}>{isCompact ? <X size={17}/> : <PanelLeftClose size={17}/>}</button>
    </header>
    <div className="history-filters">
      <div className="history-agents" role="group" aria-label="Filter by agent">{(['all','claude','codex'] as const).map(agent => <button key={agent} aria-pressed={preferences.agent===agent} onClick={()=>update({agent})}>{agent==='all'?'All':agent==='claude'?'Claude':'Codex'}</button>)}</div>
      <input aria-label="Search conversations" placeholder="Search title or folder…" value={search} onChange={e=>setSearch(e.target.value)}/>
      <div className="history-options">
        <select aria-label="Group conversations" value={preferences.grouping} onChange={e=>update({grouping:e.target.value as HistoryPreferences['grouping']})}><option value="folder">By folder</option><option value="date">By date</option></select>
        <select aria-label="Sort conversations" value={preferences.order} onChange={e=>update({order:e.target.value as HistoryPreferences['order']})}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select>
      </div>
    </div>
    <div className="history-summary" role="status">{loading ? 'Loading conversations…' : `${count} conversation${count === 1 ? "" : "s"}`}</div>
    <div className="history-list">
      {notices.map(notice=><p className="history-notice" key={notice}>{notice}</p>)}
      {error && <p className="history-notice" role="alert">{error}</p>}
      {!loading && !count && <p className="history-empty">{search || preferences.agent!=='all' ? 'No matching conversations.' : notices.length ? 'History could not be fully loaded. Use Refresh to retry.' : 'No Claude or Codex conversations yet. Conversations saved on your connected machines will appear here.'}</p>}
      {groups.map(group => {
        const closed = closedGroups.has(group.key);
        const shown = group.rows.slice(0,Math.max(0,limit-rendered)); rendered += shown.length;
        if (!shown.length) return null;
        return <section key={group.key} className="history-group">
          <button className="history-folder" aria-expanded={!closed} title={group.detail || group.label} onClick={()=>setClosedGroups(prev=>{const next=new Set(prev);next.has(group.key)?next.delete(group.key):next.add(group.key);return next;})}>
            <>{preferences.grouping === "folder" ? <Folder size={14}/> : <CalendarDays size={14}/>}</><span>{group.label}</span><small>{group.rows.length}</small>
          </button>
          {group.detail && <div className="history-path" title={group.detail}>{group.detail}</div>}
          {!closed && shown.map(row=><button key={conversationKey(row)} className="history-session" data-testid="history-session" disabled={pending!==null} title={`Resume ${row.agent==='claude'?'Claude':'Codex'} · ${row.cwd}`} onClick={()=>void resume(row)}>
            <span className="history-title">{pending===conversationKey(row)?'Opening…':row.title}</span>
            <span className="history-meta"><span>{row.agent==='claude'?'Claude':'Codex'}</span><time dateTime={new Date(row.updated_at_ms).toISOString()} title={new Date(row.updated_at_ms).toLocaleString()}>{new Date(row.updated_at_ms).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</time></span>
          </button>)}
        </section>;
      })}
      {count>limit && <button className="history-more" onClick={()=>setLimit(n=>n+200)}>Show more ({count-limit} remaining)</button>}
    </div>
    <footer>Saved Claude &amp; Codex sessions · select to resume</footer>
  </aside>;
  if (isCompact) return <dialog className="history-dialog" ref={dialog} onCancel={onClose} onClose={onClose} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>{content}</dialog>;
  if (collapsed) return <div className="history-collapsed"><button aria-label="Open conversations" onClick={()=>setCollapsed(false)}><PanelLeftOpen size={18}/></button></div>;
  return content;
}
