import { useEffect, useMemo, useRef, useState } from 'react';
import type { MachineInfo } from '@offdesk/shared';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, CalendarDays, ChevronRight, Folder, Loader2, MessageSquare, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, X } from 'lucide-react';
import { listConversationHistory } from '@/lib/api';
import { conversationKey, displayPath, folderName, historyGroups, readHistoryPreferences, rowTimeLabel, type ConversationRow, type HistoryPreferences } from '@/lib/conversationHistory';

const PREFERENCES_KEY = 'offdesk:conversation-history-preferences';
const COLLAPSED_KEY = 'offdesk:conversation-history-collapsed';
// The desktop header shares its row with tabs and machine stats; below this
// width an open sidebar squeezes the tab strip, so it starts as a rail.
const AUTO_OPEN_MIN_WIDTH = 1440;
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
  const [collapsed, setCollapsedState] = useState(() => {
    try { const saved = localStorage.getItem(COLLAPSED_KEY); if (saved !== null) return saved === 'true'; } catch { /* storage is optional */ }
    return window.innerWidth < AUTO_OPEN_MIN_WIDTH;
  });
  const setCollapsed = (value: boolean) => { setCollapsedState(value); try { localStorage.setItem(COLLAPSED_KEY, String(value)); } catch { /* storage is optional */ } };
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
  const multiMachine = machines.length > 1;
  const byFolder = preferences.grouping === 'folder';
  const update = (value: Partial<HistoryPreferences>) => setPreferences(p => ({ ...p, ...value }));
  const toggleGroup = (key: string) => setClosedGroups(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const resume = async (row: ConversationRow) => {
    if (pending) return;
    if (!canResume(row.machineId)) { setError(`Take control of ${row.machineName} in the host menu to resume this conversation.`); return; }
    setPending(conversationKey(row)); setError('');
    try { await onResume(row); if (isCompact) onClose(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not resume conversation'); }
    finally { setPending(null); }
  };
  const agentName = (agent: ConversationRow['agent']) => agent === 'claude' ? 'Claude' : 'Codex';
  const newest = preferences.order === 'newest';
  let rendered = 0;
  const content = <aside className="agent-history" aria-label="Agent conversations" data-testid="agent-session-sidebar">
    <header><MessageSquare size={16} aria-hidden /><strong>Conversations</strong>
      <button aria-label="Refresh conversations" title="Refresh" disabled={loading} onClick={() => setRefresh(n=>n+1)}><RefreshCw size={14} className={loading ? 'history-loading' : undefined}/></button>
      <button aria-label={isCompact ? 'Close conversations' : 'Collapse conversations'} title={isCompact ? 'Close' : 'Collapse'} onClick={() => isCompact ? onClose() : setCollapsed(true)}>{isCompact ? <X size={17}/> : <PanelLeftClose size={16}/>}</button>
    </header>
    <div className="history-filters">
      <label className="history-search"><Search size={14} aria-hidden/>
        <input aria-label="Search conversations" placeholder="Search titles, folders…" value={search} onChange={e=>setSearch(e.target.value)}
          onKeyDown={e=>{ if (e.key === 'Escape' && search) { e.preventDefault(); e.stopPropagation(); setSearch(''); } }}/>
        {search && <button type="button" aria-label="Clear search" onClick={()=>setSearch('')}><X size={13}/></button>}
      </label>
      <div className="history-toolbar">
        <div className="history-agents" role="group" aria-label="Filter by agent">{(['all','claude','codex'] as const).map(agent =>
          <button key={agent} aria-pressed={preferences.agent===agent} onClick={()=>update({agent})}>
            {agent !== 'all' && <i className={`history-agent-dot ${agent}`} aria-hidden/>}{agent==='all'?'All':agentName(agent)}
          </button>)}</div>
        <div className="history-view" role="group" aria-label="Group conversations">
          <button aria-pressed={byFolder} aria-label="Group by folder" title="Group by folder" onClick={()=>update({grouping:'folder'})}><Folder size={14}/></button>
          <button aria-pressed={!byFolder} aria-label="Group by date" title="Group by date" onClick={()=>update({grouping:'date'})}><CalendarDays size={14}/></button>
        </div>
        <button className="history-sort" aria-label="Sort conversations" data-order={preferences.order} title={newest ? 'Newest first' : 'Oldest first'}
          onClick={()=>update({order: newest ? 'oldest' : 'newest'})}>{newest ? <ArrowDownWideNarrow size={14}/> : <ArrowUpNarrowWide size={14}/>}</button>
      </div>
    </div>
    <div className="history-summary" role="status">{loading && !rows.length ? 'Loading conversations…' : `${count} conversation${count === 1 ? '' : 's'} · ${newest ? 'newest' : 'oldest'} first`}</div>
    <div className="history-list">
      {notices.map(notice=><p className="history-notice" key={notice}>{notice}</p>)}
      {error && <p className="history-notice error" role="alert">{error}</p>}
      {loading && !rows.length && <div className="history-skeleton" aria-hidden>{[0,1,2,3].map(i=><span key={i}/>)}</div>}
      {!loading && !count && <div className="history-empty">
        {search || preferences.agent!=='all' ? <>No matching conversations.<button onClick={()=>{setSearch('');update({agent:'all'});}}>Clear filters</button></>
          : notices.length ? 'History could not be fully loaded. Use Refresh to retry.'
          : <>No Claude or Codex conversations yet.<small>Sessions saved on your connected machines appear here. Select one to resume it in a new terminal.</small></>}
      </div>}
      {groups.map(group => {
        const closed = closedGroups.has(group.key);
        const shown = group.rows.slice(0,Math.max(0,limit-rendered)); rendered += shown.length;
        if (!shown.length) return null;
        const path = group.cwd && `${multiMachine ? `${group.machineName} · ` : ''}${displayPath(group.cwd)}`;
        return <section key={group.key} className="history-group">
          <button className="history-folder" aria-expanded={!closed} title={group.cwd ? `${group.machineName} · ${group.cwd}` : group.label} onClick={()=>toggleGroup(group.key)}>
            <ChevronRight size={13} className="history-chevron" aria-hidden/>
            {byFolder ? <Folder size={14} aria-hidden/> : <CalendarDays size={14} aria-hidden/>}
            <span className="history-folder-text"><span>{group.label}</span>{path && <small className="history-path">{path}</small>}</span>
            <small className="history-count">{group.rows.length}</small>
          </button>
          {!closed && shown.map(row=>{
            const key = conversationKey(row); const opening = pending === key;
            return <button key={key} className="history-session" data-testid="history-session" aria-busy={opening} disabled={pending!==null}
              title={`Resume in ${agentName(row.agent)} · ${row.machineName} · ${row.cwd}`} onClick={()=>void resume(row)}>
              <i className={`history-agent-dot ${row.agent}`} aria-hidden/>
              <span className="history-body">
                <span className="history-title">{row.title}</span>
                <span className="history-meta">
                  <span>{agentName(row.agent)}{!byFolder && <> · {folderName(row.cwd)}</>}{!byFolder && multiMachine && <> · {row.machineName}</>}</span>
                  {opening ? <span className="history-opening"><Loader2 size={11} className="history-loading"/>Opening…</span>
                    : <time dateTime={new Date(row.updated_at_ms).toISOString()} title={new Date(row.updated_at_ms).toLocaleString()}>{rowTimeLabel(row.updated_at_ms, preferences.grouping)}</time>}
                </span>
              </span>
            </button>;
          })}
        </section>;
      })}
      {count>limit && <button className="history-more" onClick={()=>setLimit(n=>n+200)}>Show more ({count-limit} remaining)</button>}
    </div>
  </aside>;
  if (isCompact) return <dialog className="history-dialog" ref={dialog} onCancel={onClose} onClose={onClose} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>{content}</dialog>;
  if (collapsed) return <div className="history-collapsed"><button aria-label="Open conversations" onClick={()=>setCollapsed(false)}><PanelLeftOpen size={18}/></button></div>;
  return content;
}
