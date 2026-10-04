export type ConversationAgent = 'claude' | 'codex';
export interface ConversationSession {
  id: string;
  agent: ConversationAgent;
  cwd: string;
  title: string;
  updated_at_ms: number;
}
export interface ConversationHistory { sessions: ConversationSession[]; warnings: string[] }
export interface ConversationRow extends ConversationSession { machineId: string; machineName: string }
export interface HistoryPreferences { agent: 'all' | ConversationAgent; grouping: 'folder' | 'date'; order: 'newest' | 'oldest' }
export const DEFAULT_HISTORY_PREFERENCES: HistoryPreferences = { agent: 'all', grouping: 'folder', order: 'newest' };
export function readHistoryPreferences(raw: string | null): HistoryPreferences {
  try {
    const v = JSON.parse(raw ?? '{}');
    return { agent: v.agent === 'claude' || v.agent === 'codex' ? v.agent : 'all', grouping: v.grouping === 'date' ? 'date' : 'folder', order: v.order === 'oldest' ? 'oldest' : 'newest' };
  } catch { return DEFAULT_HISTORY_PREFERENCES; }
}
export const conversationKey = (row: ConversationRow) => JSON.stringify([row.machineId, row.agent, row.id]);
export interface HistoryGroup { key: string; label: string; machineName: string; cwd: string; rows: ConversationRow[] }
const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const DAY = 86_400_000;
export const folderName = (cwd: string) => cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;
// Home directories are noise in a narrow sidebar; the full path stays in the tooltip.
export const displayPath = (cwd: string) => cwd.replace(/^(?:\/Users|\/home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');
export function dayLabel(ms: number, now = Date.now()) {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const date = new Date(ms);
  if (days > 1 && days < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, date.getFullYear() === new Date(now).getFullYear()
    ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}
// Date groups already name the day, so rows show the time; folder groups show recency.
export function rowTimeLabel(ms: number, grouping: HistoryPreferences['grouping'], now = Date.now()) {
  if (grouping === 'date') return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (startOfDay(ms) === startOfDay(now)) return `${Math.floor(minutes / 60)}h ago`;
  return dayLabel(ms, now);
}
export function historyGroups(rows: ConversationRow[], preferences: HistoryPreferences, search: string, now = Date.now()): HistoryGroup[] {
  const query = search.trim().toLocaleLowerCase();
  const filtered = rows.filter(row => (preferences.agent === 'all' || row.agent === preferences.agent) &&
    (!query || `${row.title} ${row.cwd} ${row.machineName}`.toLocaleLowerCase().includes(query)));
  filtered.sort((a,b) => (preferences.order === 'newest' ? -1 : 1) * (a.updated_at_ms - b.updated_at_ms) || conversationKey(a).localeCompare(conversationKey(b)));
  const groups = new Map<string, HistoryGroup>();
  for (const row of filtered) {
    const byFolder = preferences.grouping === 'folder';
    const key = byFolder ? JSON.stringify([row.machineId,row.cwd]) : String(startOfDay(row.updated_at_ms));
    if (!groups.has(key)) groups.set(key, { key, label: byFolder ? folderName(row.cwd) : dayLabel(row.updated_at_ms, now),
      machineName: byFolder ? row.machineName : '', cwd: byFolder ? row.cwd : '', rows: [] });
    groups.get(key)!.rows.push(row);
  }
  return [...groups.values()];
}
export function resumeConversationCommand(row: ConversationSession) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id)) throw new Error('This session has an invalid identifier');
  if (row.agent === 'claude') return `claude --resume ${row.id}`;
  if (row.agent === 'codex') return `codex resume ${row.id}`;
  throw new Error('Unsupported agent');
}
