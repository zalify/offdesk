import { afterEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({ native: false, create: vi.fn(), close: vi.fn() }));
vi.mock('./platform', () => ({ isTauri: () => deps.native }));
vi.mock('./api', () => ({ getBaseUrl: () => 'https://hub.test', createWebPreview: deps.create, closeWebPreview: deps.close }));
import { openWebPreview } from './webPreview';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); deps.native = false; });
describe('preview browser opening', () => {
  const local = { port: 3127, address_family: 'ipv4' as const, target: '/' };
  it('opens the trusted Web launcher synchronously, before any async API request', async () => {
    const open = vi.fn(); vi.stubGlobal('window', { open });
    const pending = openWebPreview('machine', 'terminal', local);
    expect(open).toHaveBeenCalledOnce();
    expect(deps.create).not.toHaveBeenCalled();
    await pending;
  });
  it.each(['null', 'throw'])('retains a credential-free clickable launcher when popup opening returns %s', async mode => {
    vi.stubGlobal('window', { open: () => { if (mode === 'throw') throw new Error('blocked'); return null; } });
    const fallback = await openWebPreview('machine', 'terminal', local);
    expect(fallback).toMatch(/^https:\/\/hub.test\/__offdesk_preview__\/launch\?/);
    expect(fallback).not.toContain('code=');
    expect(deps.create).not.toHaveBeenCalled();
  });
  it('hands only the limited launch URL to the native opener', async () => {
    deps.native = true;
    deps.create.mockResolvedValue({ preview: { id: 'lease' }, launch_url: 'https://p.preview.test/bootstrap#code=limited' });
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    await openWebPreview('machine', 'terminal', local);
    expect(deps.create).toHaveBeenCalledWith('machine', { ...local, terminal_id: 'terminal' });
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', { url: 'https://p.preview.test/bootstrap#code=limited' });
  });
  it('revokes an unopened lease and does not expose native errors containing credentials', async () => {
    deps.native = true;
    deps.create.mockResolvedValue({ preview: { id: 'lease' }, launch_url: 'https://p.preview.test/bootstrap#code=limited' });
    deps.close.mockResolvedValue(undefined);
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: vi.fn().mockRejectedValue(new Error('secret URL #code=limited')) } });
    await expect(openWebPreview('machine', 'terminal', local)).rejects.toThrow('Could not open your browser. Please update');
    expect(deps.close).toHaveBeenCalledWith('lease');
  });
});
