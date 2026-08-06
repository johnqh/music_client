/**
 * Snapshot hook tests — same fake-network harness as use-projects.test.ts.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useCreateSnapshot, useOpenSnapshot, useSnapshots } from './use-snapshots.js';
import { musicQueryKeys } from './query-keys.js';

function fakeNetwork(payload: unknown) {
  return {
    request: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { success: true, data: payload } }),
  } as never;
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const ctx = (payload: unknown) => ({
  networkClient: fakeNetwork(payload),
  baseUrl: 'http://api.test',
  token: 'tok',
});

describe('useSnapshots', () => {
  it('lists a project s snapshots', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSnapshots(ctx([{ id: 's1' }]), 'p1'), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ id: 's1' }]);
  });

  it('does not fetch without a project', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSnapshots(ctx([]), null), {
      wrapper: wrapper(queryClient),
    });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useCreateSnapshot', () => {
  it('invalidates the snapshot list and the project after creating one', async () => {
    // Otherwise the picker shows a stale tree the moment you snapshot, and the
    // project's parentSnapshotId is wrong for the next one.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useCreateSnapshot(ctx({ id: 's1' })), {
      wrapper: wrapper(queryClient),
    });

    result.current.mutate({ projectId: 'p1', name: 'Version 1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(musicQueryKeys.snapshots.list('p1')));
    expect(keys).toContain(JSON.stringify(musicQueryKeys.projects.detail('p1')));
  });
});

describe('useOpenSnapshot', () => {
  it('invalidates the project after opening a snapshot', async () => {
    // The live score was replaced underneath; a stale cache would still show
    // the work that was just discarded.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useOpenSnapshot(ctx({ id: 'p1' })), {
      wrapper: wrapper(queryClient),
    });

    result.current.mutate({ snapshotId: 's1', projectId: 'p1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(musicQueryKeys.projects.detail('p1')));
  });
});
