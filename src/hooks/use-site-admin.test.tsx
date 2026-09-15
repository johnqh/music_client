import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { BASE_URL, fakeServer, newQueryClient, wrapperFor } from '../test/fake-server.js';
import { useSiteAdmin } from './use-site-admin.js';

const me = (siteAdmin: boolean) => ({ data: { userId: 'u1', email: null, siteAdmin } });

describe('useSiteAdmin', () => {
  it('answers what /me says', async () => {
    const server = fakeServer({ 'GET /me': () => me(true) });
    const ctx = { networkClient: server.networkClient, baseUrl: BASE_URL, getToken: async () => 'tok', userId: 'u1' };
    const { result } = renderHook(() => useSiteAdmin(ctx), { wrapper: wrapperFor(newQueryClient()) });
    await waitFor(() => expect(result.current).toBe(true));
    expect(server.calls[0]!.authorization).toBe('Bearer tok');
  });

  it('is closed (false) while the request is in flight', () => {
    const server = fakeServer({ 'GET /me': () => new Promise(() => {}) });
    const ctx = { networkClient: server.networkClient, baseUrl: BASE_URL, getToken: async () => 'tok' };
    const { result } = renderHook(() => useSiteAdmin(ctx), { wrapper: wrapperFor(newQueryClient()) });
    expect(result.current).toBe(false);
  });

  it('is closed when the request fails', async () => {
    const server = fakeServer({ 'GET /me': () => ({ status: 500 }) });
    const qc = newQueryClient();
    const ctx = { networkClient: server.networkClient, baseUrl: BASE_URL, getToken: async () => 'tok' };
    const { result } = renderHook(() => useSiteAdmin(ctx), { wrapper: wrapperFor(qc) });
    await waitFor(() => expect(qc.getQueryCache().getAll()[0]?.state.status).toBe('error'));
    expect(result.current).toBe(false);
  });

  it('is false and asks nothing with no server or nobody signed in', () => {
    const server = fakeServer({ 'GET /me': () => me(true) });
    const wrapper = wrapperFor(newQueryClient());
    expect(renderHook(() => useSiteAdmin(null), { wrapper }).result.current).toBe(false);
    const signedOut = { networkClient: server.networkClient, baseUrl: BASE_URL, getToken: async () => null, userId: null };
    expect(renderHook(() => useSiteAdmin(signedOut), { wrapper }).result.current).toBe(false);
    expect(server.calls).toHaveLength(0);
  });

  it('does not carry one account’s answer over to the next', async () => {
    const server = fakeServer({
      'GET /me': (call) => me(call.authorization === 'Bearer admin'),
    });
    const qc = newQueryClient();
    let token = 'admin';
    let userId = 'u-admin';
    const { result, rerender } = renderHook(
      () =>
        useSiteAdmin({ networkClient: server.networkClient, baseUrl: BASE_URL, getToken: async () => token, userId }),
      { wrapper: wrapperFor(qc) }
    );
    await waitFor(() => expect(result.current).toBe(true));

    token = 'someone';
    userId = 'u-else';
    rerender();
    // Closed straight away for the new account, not after its own answer.
    expect(result.current).toBe(false);
    await waitFor(() => expect(server.calls).toHaveLength(2));
    expect(result.current).toBe(false);
  });
});
