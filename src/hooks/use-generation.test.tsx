/**
 * Job-polling hook, against a real QueryClientProvider and a fake network.
 *
 * The rule under test is that polling *stops*: a job that keeps refetching
 * after it has finished leaves a request loop running for the rest of the
 * session, which nothing else in the app would surface.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NetworkClient, NetworkRequestOptions, NetworkResponse } from '@sudobility/types';
import type { GenerationJobStatus } from '@sudobility/music_types';
import { useGenerationJob, useProjectJobs } from './use-generation';

const POLL_MS = 3000;

function job(status: GenerationJobStatus) {
  return {
    id: 'j1',
    projectId: 'p1',
    kind: 'generate-track',
    status,
    createdAt: '2026-08-07T00:00:00.000Z',
    finishedAt: status === 'running' ? null : '2026-08-07T00:01:00.000Z',
    error: null,
  };
}

function fakeNetwork(status: GenerationJobStatus): { client: NetworkClient; calls: () => number } {
  let count = 0;
  const respond = <T,>(url: string, _options?: NetworkRequestOptions): Promise<NetworkResponse<T>> => {
    count += 1;
    // A project's history lists jobs with their requests; a job read is one job.
    const data = /\/projects\/[^/]+\/jobs$/.test(url)
      ? [{ ...job(status), request: { prompt: 'p' } }]
      : job(status);
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { success: true, data } as T,
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
    calls: () => count,
  };
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('useGenerationJob', () => {
  it('fetches the job when given an id and a token', async () => {
    const { client } = fakeNetwork('running');
    const qc = newClient();
    const ctx = { networkClient: client, baseUrl: 'http://api', token: 'tok' };

    const { result } = renderHook(() => useGenerationJob(ctx, 'j1'), { wrapper: wrapper(qc) });

    await waitFor(() => expect(result.current.data?.status).toBe('running'));
  });

  it('stays disabled without an id', async () => {
    const { client, calls } = fakeNetwork('running');
    const qc = newClient();
    const ctx = { networkClient: client, baseUrl: 'http://api', token: 'tok' };

    const { result } = renderHook(() => useGenerationJob(ctx, null), { wrapper: wrapper(qc) });

    expect(result.current.fetchStatus).toBe('idle');
    expect(calls()).toBe(0);
  });

  it('stays disabled without a token', async () => {
    const { client, calls } = fakeNetwork('running');
    const qc = newClient();
    const ctx = { networkClient: client, baseUrl: 'http://api', token: null };

    const { result } = renderHook(() => useGenerationJob(ctx, 'j1'), { wrapper: wrapper(qc) });

    expect(result.current.fetchStatus).toBe('idle');
    expect(calls()).toBe(0);
  });

  it('keeps polling while the job is running', async () => {
    const { client } = fakeNetwork('running');
    const qc = newClient();
    const ctx = { networkClient: client, baseUrl: 'http://api', token: 'tok' };

    const { result } = renderHook(() => useGenerationJob(ctx, 'j1'), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.data?.status).toBe('running'));

    const query = qc.getQueryCache().find({ queryKey: ['music', 'jobs', 'detail', 'j1'] });
    const interval = query?.observers[0]?.options.refetchInterval;
    const resolved = typeof interval === 'function' ? interval(query!) : interval;
    expect(resolved).toBe(POLL_MS);
  });

  it('stops polling once the job reaches a terminal status', async () => {
    // The whole point: without this, a finished job keeps a request loop alive
    // for the rest of the session.
    for (const status of ['done', 'failed', 'cancelled'] as const) {
      const { client } = fakeNetwork(status);
      const qc = newClient();
      const ctx = { networkClient: client, baseUrl: 'http://api', token: 'tok' };

      const { result } = renderHook(() => useGenerationJob(ctx, 'j1'), { wrapper: wrapper(qc) });
      await waitFor(() => expect(result.current.data?.status).toBe(status));

      const query = qc.getQueryCache().find({ queryKey: ['music', 'jobs', 'detail', 'j1'] });
      const interval = query?.observers[0]?.options.refetchInterval;
      const resolved = typeof interval === 'function' ? interval(query!) : interval;
      expect(resolved).toBe(false);
      qc.clear();
    }
  });
});

describe('useProjectJobs', () => {
  it("fetches the project's jobs, with their requests, under the project key", async () => {
    const { client } = fakeNetwork('done');
    const qc = newClient();
    const ctx = { networkClient: client, baseUrl: 'http://api', token: 'tok' };

    const { result } = renderHook(() => useProjectJobs(ctx, 'p1'), { wrapper: wrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0].request).toEqual({ prompt: 'p' });
    expect(qc.getQueryCache().find({ queryKey: ['music', 'jobs', 'project', 'p1'] })).toBeDefined();
  });

  it('stays disabled without a project, and without a token', () => {
    const { client, calls } = fakeNetwork('done');
    const qc = newClient();

    const noProject = renderHook(
      () => useProjectJobs({ networkClient: client, baseUrl: 'http://api', token: 'tok' }, null),
      { wrapper: wrapper(qc) }
    );
    const noToken = renderHook(
      () => useProjectJobs({ networkClient: client, baseUrl: 'http://api', token: null }, 'p1'),
      { wrapper: wrapper(qc) }
    );

    expect(noProject.result.current.fetchStatus).toBe('idle');
    expect(noToken.result.current.fetchStatus).toBe('idle');
    expect(calls()).toBe(0);
  });

  it('does not poll: a history is about finished work', async () => {
    const { client } = fakeNetwork('done');
    const qc = newClient();
    const ctx = { networkClient: client, baseUrl: 'http://api', token: 'tok' };

    const { result } = renderHook(() => useProjectJobs(ctx, 'p1'), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const query = qc.getQueryCache().find({ queryKey: ['music', 'jobs', 'project', 'p1'] });
    expect(query?.observers[0]?.options.refetchInterval).toBeUndefined();
  });
});
