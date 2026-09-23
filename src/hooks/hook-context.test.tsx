/**
 * The hook context resolves its token per request.
 *
 * A token captured into the context goes stale an hour into a session, and one
 * read at start-up is null for a signed-in user until Firebase has restored the
 * session. Both apps hit one of those, so every hook here asks `getToken` at the
 * moment it sends, and keeps the old captured `token` working only for callers
 * that have not moved yet.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { BASE_URL, fakeServer, newQueryClient, wrapperFor } from '../test/fake-server';
import { hookAuthEnabled, resolveHookToken } from './hook-context';
import {
  useCancelProjectGeneration,
  useDeleteProject,
  useDuplicateProject,
  useProjects,
} from './use-projects';
import { GENERATION_POLL_MS } from './use-project-generation';

const summary = (id: string, status: 'ready' | 'generating' | 'transcribing' = 'ready') => ({
  id,
  name: id,
  createdAt: '',
  updatedAt: '',
  schemaVersion: 1,
  status,
  lastGenerationError: null,
});

describe('hook context', () => {
  it('prefers getToken over a captured token, and reads it each time', async () => {
    let n = 0;
    const getToken = vi.fn(async () => `fresh-${++n}`);
    const ctx = { networkClient: {} as never, baseUrl: BASE_URL, token: 'stale', getToken };
    expect(await resolveHookToken(ctx)).toBe('fresh-1');
    expect(await resolveHookToken(ctx)).toBe('fresh-2');
  });

  it('falls back to the deprecated token when there is no getToken', async () => {
    expect(await resolveHookToken({ networkClient: {} as never, baseUrl: BASE_URL, token: 'tok' })).toBe('tok');
    expect(await resolveHookToken({ networkClient: {} as never, baseUrl: BASE_URL, token: null })).toBeNull();
  });

  it('is enabled with getToken unless the caller says nobody is signed in', () => {
    const base = { networkClient: {} as never, baseUrl: BASE_URL };
    const getToken = async () => 'tok';
    expect(hookAuthEnabled({ ...base, getToken })).toBe(true);
    expect(hookAuthEnabled({ ...base, getToken, userId: 'u1' })).toBe(true);
    expect(hookAuthEnabled({ ...base, getToken, userId: null })).toBe(false);
    expect(hookAuthEnabled({ ...base, token: 'tok' })).toBe(true);
    expect(hookAuthEnabled({ ...base, token: null })).toBe(false);
    expect(hookAuthEnabled(null)).toBe(false);
  });
});

describe('useProjects', () => {
  it('sends the token getToken answers at request time', async () => {
    const server = fakeServer({ 'GET /projects': () => ({ data: [summary('p1')] }) });
    const getToken = vi.fn(async () => 'fresh');
    const { result } = renderHook(
      () => useProjects({ networkClient: server.networkClient, baseUrl: BASE_URL, getToken }),
      { wrapper: wrapperFor(newQueryClient()) }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(server.calls[0]!.authorization).toBe('Bearer fresh');
  });

  it('does not poll by default, even with a generating row', async () => {
    const server = fakeServer({ 'GET /projects': () => ({ data: [summary('p1', 'generating')] }) });
    const qc = newQueryClient();
    const { result } = renderHook(
      () => useProjects({ networkClient: server.networkClient, baseUrl: BASE_URL, token: 'tok' }),
      { wrapper: wrapperFor(qc) }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(intervalOf(qc)).toBe(false);
  });

  it('polls while a row is still being worked on server-side, and stops when none is', async () => {
    let rows = [summary('p1', 'generating'), summary('p2')];
    const server = fakeServer({ 'GET /projects': () => ({ data: rows }) });
    const qc = newQueryClient();
    const { result } = renderHook(
      () =>
        useProjects(
          { networkClient: server.networkClient, baseUrl: BASE_URL, token: 'tok' },
          { sort: 'updatedAt' },
          { pollWhileGenerating: true }
        ),
      { wrapper: wrapperFor(qc) }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(intervalOf(qc)).toBe(GENERATION_POLL_MS);
    expect(server.calls[0]!.path).toBe('/projects?sort=updatedAt');

    rows = [summary('p1', 'transcribing')];
    await act(() => result.current.refetch());
    expect(intervalOf(qc)).toBe(GENERATION_POLL_MS);

    rows = [summary('p1')];
    await act(() => result.current.refetch());
    expect(intervalOf(qc)).toBe(false);
  });
});

function intervalOf(qc: ReturnType<typeof newQueryClient>): unknown {
  const query = qc.getQueryCache().findAll({ queryKey: ['music', 'projects', 'list'] })[0]!;
  const interval = query.observers[0]?.options.refetchInterval;
  return typeof interval === 'function' ? interval(query as never) : interval;
}

describe('project mutations', () => {
  const setup = () => {
    const server = fakeServer({
      'GET /projects': () => ({ data: [summary('p1')] }),
      'POST /projects/p1/duplicate': () => ({ data: summary('p2') }),
      'POST /projects/p1/generation/cancel': () => ({ data: { ok: true } }),
      'DELETE /projects/p1': () => ({ data: { deleted: true } }),
    });
    const qc = newQueryClient();
    const ctx = { networkClient: server.networkClient, baseUrl: BASE_URL, getToken: async () => 'tok' };
    return { server, qc, ctx };
  };

  it('useDuplicateProject copies server-side and refreshes the list', async () => {
    const { server, qc, ctx } = setup();
    const list = renderHook(() => useProjects(ctx), { wrapper: wrapperFor(qc) });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));

    const dup = renderHook(() => useDuplicateProject(ctx), { wrapper: wrapperFor(qc) });
    const saved = await dup.result.current.mutateAsync({ id: 'p1' });
    expect(saved.id).toBe('p2');
    await waitFor(() => expect(server.log().filter((l) => l === 'GET /projects')).toHaveLength(2));
    expect(server.calls.find((c) => c.method === 'POST')!.body).toEqual({});
    expect(server.calls.find((c) => c.method === 'POST')!.authorization).toBe('Bearer tok');
  });

  it('useCancelProjectGeneration cancels by project and refreshes the list', async () => {
    const { server, qc, ctx } = setup();
    const list = renderHook(() => useProjects(ctx), { wrapper: wrapperFor(qc) });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));

    const cancel = renderHook(() => useCancelProjectGeneration(ctx), { wrapper: wrapperFor(qc) });
    await cancel.result.current.mutateAsync('p1');
    expect(server.log()).toContain('POST /projects/p1/generation/cancel');
    await waitFor(() => expect(server.log().filter((l) => l === 'GET /projects')).toHaveLength(2));
  });

  it('useDeleteProject reads the token from getToken', async () => {
    const { server, qc, ctx } = setup();
    const del = renderHook(() => useDeleteProject(ctx), { wrapper: wrapperFor(qc) });
    await del.result.current.mutateAsync('p1');
    expect(server.calls.find((c) => c.method === 'DELETE')!.authorization).toBe('Bearer tok');
  });

  it('a mutation with no token refuses before any request', async () => {
    const { server, qc } = setup();
    const ctx = { networkClient: server.networkClient, baseUrl: BASE_URL, getToken: async () => null };
    const del = renderHook(() => useDeleteProject(ctx), { wrapper: wrapperFor(qc) });
    await expect(del.result.current.mutateAsync('p1')).rejects.toThrow();
    expect(server.calls).toHaveLength(0);
  });
});
