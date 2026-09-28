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
export function historyGroups(rows: ConversationRow[], preferences: HistoryPreferences, search: string) {
  const query = search.trim().toLocaleLowerCase();
  const filtered = rows.filter(row => (preferences.agent === 'all' || row.agent === preferences.agent) &&
    (!query || `${row.title} ${row.cwd} ${row.machineName}`.toLocaleLowerCase().includes(query)));
  filtered.sort((a,b) => (preferences.order === 'newest' ? -1 : 1) * (a.updated_at_ms - b.updated_at_ms) || conversationKey(a).localeCompare(conversationKey(b)));
  const groups = new Map<string, { key: string; label: string; detail: string; rows: ConversationRow[] }>();
  for (const row of filtered) {
    const date = new Date(row.updated_at_ms);
    const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const key = preferences.grouping === 'folder' ? JSON.stringify([row.machineId,row.cwd]) : dateKey;
    if (!groups.has(key)) groups.set(key, { key,
      label: preferences.grouping === 'folder' ? row.cwd.replace(/[\\/]$/, '').split(/[\\/]/).pop() || row.cwd : date.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' }),
      detail: preferences.grouping === 'folder' ? `${row.machineName} · ${row.cwd}` : '', rows: [] });
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
