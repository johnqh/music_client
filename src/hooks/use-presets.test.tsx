/**
 * The presets hook, against a real QueryClientProvider and a fake network.
 *
 * Two rules matter here and neither is visible in the type: the list is static
 * product data, so it must not be refetched on every dialog open; and it must
 * not need a token, because the route is public and a token-gated fetch on
 * mount loses the race Firebase's session restore creates.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NetworkClient, NetworkRequestOptions, NetworkResponse } from '@sudobility/types';
import { useScorePresets } from './use-presets';

function fakeNetwork(presets: string[]): {
  client: NetworkClient;
  urls: string[];
} {
  const urls: string[] = [];
  const respond = <T,>(url: string, _options?: NetworkRequestOptions): Promise<NetworkResponse<T>> => {
    urls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { success: true, data: { presets } } as T,
    } as NetworkResponse<T>);
  };
  return {
    urls,
    client: {
      request: respond,
      get: respond,
      post: (url: string) => respond(url),
      put: (url: string) => respond(url),
      delete: respond,
    } as NetworkClient,
  };
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const ctx = (client: NetworkClient) => ({
  networkClient: client,
  baseUrl: 'http://localhost:8022',
  token: null,
});

describe('useScorePresets', () => {
  it('fetches the briefs for a style', async () => {
    const { client, urls } = fakeNetwork(['organStabs']);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useScorePresets(ctx(client), 'reggae'), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.data).toEqual(['organStabs']));
    expect(urls[0]).toContain('/public/presets?style=reggae');
  });

  it('runs with no token, because the route is public', async () => {
    // Every other query in this client is gated on `ctx.token`; this one must
    // not be, or the menu is empty until Firebase restores the session.
    const { client } = fakeNetwork(['simpleBeginner']);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useScorePresets(ctx(client), undefined), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.data).toEqual(['simpleBeginner']));
  });

  it('caches per style, so reopening the dialog is not another request', async () => {
    const { client, urls } = fakeNetwork(['organStabs']);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const first = renderHook(() => useScorePresets(ctx(client), 'reggae'), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(first.result.current.data).toBeDefined());
    const second = renderHook(() => useScorePresets(ctx(client), 'reggae'), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(second.result.current.data).toBeDefined());
    expect(urls).toHaveLength(1);
  });

  it('asks again when the style changes, since the answer depends on it', async () => {
    const { client, urls } = fakeNetwork(['organStabs']);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result, rerender } = renderHook(
      ({ style }: { style?: string }) => useScorePresets(ctx(client), style),
      { wrapper: wrapper(queryClient), initialProps: { style: 'reggae' } },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    rerender({ style: 'waltz' });
    await waitFor(() => expect(urls).toHaveLength(2));
    expect(urls[1]).toContain('style=waltz');
  });

  it('asks for nothing when there is no server to ask', async () => {
    /*
      The native app runs against local documents with no `MusicClient` at all.
      A query fired anyway would fail on every mount, and the menu is meant to
      be absent rather than broken.
    */
    const { client, urls } = fakeNetwork(['lullaby']);
    void client;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useScorePresets(null, 'reggae'), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(urls).toEqual([]);
    expect(result.current.data).toBeUndefined();
  });
});
