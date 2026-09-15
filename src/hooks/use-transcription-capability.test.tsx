import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { BASE_URL, fakeServer, newQueryClient, wrapperFor } from '../test/fake-server.js';
import { useTranscriptionCapability } from './use-transcription-capability.js';

describe('useTranscriptionCapability', () => {
  it('answers what the deployment says', async () => {
    const server = fakeServer({
      'GET /projects/transcribe/capability': () => ({ data: { available: false } }),
    });
    const ctx = { networkClient: server.networkClient, baseUrl: BASE_URL, getToken: async () => 'tok' };
    const { result } = renderHook(() => useTranscriptionCapability(ctx), {
      wrapper: wrapperFor(newQueryClient()),
    });
    expect(result.current.available).toBeNull();
    await waitFor(() => expect(result.current.available).toBe(false));
  });

  it('stays unknown (null) when the probe fails — a failed probe says nothing', async () => {
    const server = fakeServer({ 'GET /projects/transcribe/capability': () => ({ status: 500 }) });
    const qc = newQueryClient();
    const ctx = { networkClient: server.networkClient, baseUrl: BASE_URL, getToken: async () => 'tok' };
    const { result } = renderHook(() => useTranscriptionCapability(ctx), { wrapper: wrapperFor(qc) });
    await waitFor(() => expect(qc.getQueryCache().getAll()[0]?.state.status).toBe('error'));
    expect(result.current.available).toBeNull();
  });

  it('re-probes on demand, since a deployment can gain or lose credentials', async () => {
    let available = false;
    const server = fakeServer({
      'GET /projects/transcribe/capability': () => ({ data: { available } }),
    });
    const ctx = { networkClient: server.networkClient, baseUrl: BASE_URL, getToken: async () => 'tok' };
    const { result } = renderHook(() => useTranscriptionCapability(ctx), {
      wrapper: wrapperFor(newQueryClient()),
    });
    await waitFor(() => expect(result.current.available).toBe(false));
    available = true;
    await act(() => result.current.recheck());
    await waitFor(() => expect(result.current.available).toBe(true));
  });

  it('asks nothing with no server', () => {
    const { result } = renderHook(() => useTranscriptionCapability(null), {
      wrapper: wrapperFor(newQueryClient()),
    });
    expect(result.current.available).toBeNull();
  });
});
