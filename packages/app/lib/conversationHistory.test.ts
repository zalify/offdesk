import { describe, expect, it } from 'vitest';
import { dayLabel, displayPath, folderName, historyGroups, rowTimeLabel, readHistoryPreferences, resumeConversationCommand, DEFAULT_HISTORY_PREFERENCES as defaults, type ConversationRow } from './conversationHistory';
const row = (id: string, time: number, extra: Partial<ConversationRow> = {}): ConversationRow => ({ id, agent: 'claude', cwd: '/a/project', title: id, updated_at_ms: time, machineId: 'one', machineName: 'Mac', ...extra });
describe('conversation history', () => {
  it('sorts folder groups and their sessions by date, not input order', () => {
    const rows = [row('old', 1), row('other', 2, { cwd:'/b/project' }), row('new', 3)];
    expect(historyGroups(rows, defaults, '').map(g => g.rows.map(s=>s.id))).toEqual([['new','old'],['other']]);
    expect(historyGroups(rows, {...defaults,order:'oldest'}, '').map(g=>g.rows.map(s=>s.id))).toEqual([['old','new'],['other']]);
  });
  it('keeps identical directories on different machines separate and filters before grouping', () => {
    const rows = [row('a', 1),row('b',2,{machineId:'two',agent:'codex'}),row('c',3,{cwd:'/b/project'})];
    expect(historyGroups(rows,defaults,'')).toHaveLength(3);
    expect(historyGroups(rows,{...defaults,agent:'codex'},'project').flatMap(g=>g.rows).map(s=>s.id)).toEqual(['b']);
    expect(historyGroups(rows,defaults,'missing')).toEqual([]);
  });
  it('groups by calendar day and retains both agents', () => {
    const rows = [row('a', new Date(2026,8,27,10).getTime()),row('b',new Date(2026,8,28,10).getTime(),{agent:'codex'}),row('c',new Date(2026,8,27,12).getTime())];
    expect(historyGroups(rows,{...defaults,grouping:'date'},'').map(g=>g.rows.map(s=>s.id))).toEqual([['b'],['c','a']]);
  });
  it('recovers invalid saved preferences',()=>{
    expect(readHistoryPreferences('null')).toEqual(defaults);
    expect(readHistoryPreferences('{')).toEqual(defaults);
    expect(readHistoryPreferences('{"agent":"codex","order":"oldest"}')).toEqual({...defaults,agent:'codex',order:'oldest'});
  });
  it('only builds explicit resume commands from valid UUIDs',()=>{
    const id='11111111-1111-4111-8111-111111111111';
    expect(resumeConversationCommand(row(id,1))).toBe(`claude --resume ${id}`);
    expect(resumeConversationCommand(row(id,1,{agent:'codex'}))).toBe(`codex resume ${id}`);
    expect(()=>resumeConversationCommand(row('$(touch /tmp/no)',1))).toThrow();
  });
  it('labels recent days relatively and keeps rows compact',()=>{
    const now=new Date(2026,8,28,15,0).getTime();
    expect(dayLabel(new Date(2026,8,28,1).getTime(),now)).toBe('Today');
    expect(dayLabel(new Date(2026,8,27,23).getTime(),now)).toBe('Yesterday');
    expect(dayLabel(new Date(2026,8,24,9).getTime(),now)).toBe(new Date(2026,8,24).toLocaleDateString(undefined,{weekday:'long'}));
    expect(dayLabel(new Date(2025,0,2).getTime(),now)).toContain('2025');
    expect(rowTimeLabel(now-30_000,'folder',now)).toBe('Just now');
    expect(rowTimeLabel(now-5*60_000,'folder',now)).toBe('5m ago');
    expect(rowTimeLabel(now-3*3_600_000,'folder',now)).toBe('3h ago');
    expect(rowTimeLabel(new Date(2026,8,27,10).getTime(),'folder',now)).toBe('Yesterday');
    expect(historyGroups([row('a',now)],{...defaults,grouping:'date'},'',now)[0].label).toBe('Today');
  });
  it('shortens home directories for display only',()=>{
    expect(displayPath('/Users/ryan/work/app')).toBe('~/work/app');
    expect(displayPath('/home/ryan')).toBe('~');
    expect(displayPath('C:\\Users\\ryan\\app')).toBe('~\\app');
    expect(displayPath('/tmp/alpha')).toBe('/tmp/alpha');
    expect(folderName('/tmp/alpha/')).toBe('alpha');
  });
});
