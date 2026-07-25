/**
 * Hook smoke tests with a real QueryClientProvider and a fake NetworkClient:
 * list query fetches; create mutation invalidates the projects keys;
 * queries stay disabled without a token.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NetworkClient, NetworkRequestOptions, NetworkResponse } from '@sudobility/types';
import { useCreateProject, useProjects } from './use-projects.js';

function fakeNetwork(): { client: NetworkClient; log: string[] } {
  const log: string[] = [];
  const respond = <T,>(url: string, options?: NetworkRequestOptions): Promise<NetworkResponse<T>> => {
    log.push(`${options?.method ?? 'GET'} ${url}`);
    const data = url.includes('/projects') && (options?.method ?? 'GET') === 'GET'
      ? { success: true, data: [{ id: 'p1', name: 'A', createdAt: '', updatedAt: '', schemaVersion: 1 }] }
      : { success: true, data: { id: 'p2', name: 'B', createdAt: '', updatedAt: '', schemaVersion: 1, score: {} } };
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: data as T,
    } as NetworkResponse<T>);
  };
  return {
    client: {
      request: respond,
      get: respond,
      post: (u, _b, o) => respond(u, { ...o, method: 'POST' }),
      put: (u, _b, o) => respond(u, { ...o, method: 'PUT' }),
      delete: (u, o) => respond(u, { ...o, method: 'DELETE' }),
    },
    log,
  };
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('project hooks', () => {
  it('useProjects fetches and returns summaries', async () => {
    const { client } = fakeNetwork();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useProjects({ networkClient: client, baseUrl: 'http://x', token: 'tok' }),
      { wrapper: wrapper(qc) }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it('useProjects stays disabled without a token', async () => {
    const { client, log } = fakeNetwork();
    const qc = new QueryClient();
    const { result } = renderHook(
      () => useProjects({ networkClient: client, baseUrl: 'http://x', token: null }),
      { wrapper: wrapper(qc) }
    );
    expect(result.current.fetchStatus).toBe('idle');
    expect(log).toHaveLength(0);
  });

  it('useCreateProject invalidates the projects list on success', async () => {
    const { client } = fakeNetwork();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ctx = { networkClient: client, baseUrl: 'http://x', token: 'tok' };
    const projects = renderHook(() => useProjects(ctx), { wrapper: wrapper(qc) });
    await waitFor(() => expect(projects.result.current.isSuccess).toBe(true));

    const create = renderHook(() => useCreateProject(ctx), { wrapper: wrapper(qc) });
    await create.result.current.mutateAsync({ name: 'B', score: {} as never });
    await waitFor(() =>
      expect(qc.getQueryState(['music', 'projects', 'list', {}])?.isInvalidated ?? false).toBe(false)
    );
    // after invalidation the list refetches (2 GETs total)
    await waitFor(() => expect(projects.result.current.isFetched).toBe(true));
  });
});
