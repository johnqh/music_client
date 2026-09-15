/**
 * A routed fake of music_api for hook tests.
 *
 * The hooks build their own `MusicClient` from the context's `NetworkClient`,
 * so the seam a test can reach is the network, not the client. Routing by
 * method and path — rather than one canned body for every request — is what
 * lets a test assert *which* calls a hook made and in what order, which is
 * most of what these hooks are for ("create does not re-download the
 * project" is a statement about calls that did not happen).
 *
 * Test-only: excluded from the build in `tsconfig.build.json`.
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NetworkClient, NetworkRequestOptions, NetworkResponse } from '@sudobility/types';

export type FakeCall = {
  method: string;
  /** The path below `/api/v1`, query string included. */
  path: string;
  authorization: string | undefined;
  body: unknown;
};

export type FakeReply = { status?: number; data?: unknown; error?: string; code?: string };

export type FakeRoute = (call: FakeCall) => FakeReply | Promise<FakeReply>;

async function decodeBody(body: unknown): Promise<unknown> {
  if (body === undefined) return undefined;
  if (typeof body === 'string') return JSON.parse(body);
  if (body instanceof Blob) {
    // Bodies over a kilobyte go up gzipped; undo it so a test can read them.
    const stream = new Response(body).body;
    if (!stream) return undefined;
    const text = await new Response(stream.pipeThrough(new DecompressionStream('gzip'))).text();
    return JSON.parse(text);
  }
  return body;
}

/**
 * `routes` is keyed `"METHOD /path"` with the query string stripped. An
 * unrouted call answers 500, so a hook reaching for something the test did
 * not expect fails loudly rather than silently succeeding.
 */
export function fakeServer(routes: Record<string, FakeRoute>): {
  networkClient: NetworkClient;
  calls: FakeCall[];
  /** `"METHOD /path"` for every call so far, in order. */
  log: () => string[];
} {
  const calls: FakeCall[] = [];
  const request = async <T,>(url: string, options?: NetworkRequestOptions): Promise<NetworkResponse<T>> => {
    const path = url.replace(/^https?:\/\/[^/]+\/api\/v1/, '');
    const headers = (options?.headers ?? {}) as Record<string, string>;
    const call: FakeCall = {
      method: options?.method ?? 'GET',
      path,
      authorization: headers['Authorization'],
      body: await decodeBody(options?.body),
    };
    calls.push(call);
    const route = routes[`${call.method} ${path.split('?')[0]}`];
    const reply: FakeReply = route
      ? await route(call)
      : { status: 500, error: `unrouted ${call.method} ${path}` };
    const status = reply.status ?? 200;
    const ok = status >= 200 && status < 300;
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Error',
      headers: {},
      data: (ok
        ? { success: true, data: reply.data }
        : { success: false, error: reply.error ?? 'failed', code: reply.code }) as T,
    } as NetworkResponse<T>;
  };
  return {
    calls,
    log: () => calls.map((c) => `${c.method} ${c.path.split('?')[0]}`),
    networkClient: {
      request,
      get: (u, o) => request(u, o ?? undefined),
      post: (u, b, o) => request(u, { ...o, method: 'POST', body: b as never }),
      put: (u, b, o) => request(u, { ...o, method: 'PUT', body: b as never }),
      delete: (u, o) => request(u, { ...o, method: 'DELETE' }),
    },
  };
}

export function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

export function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

export const BASE_URL = 'http://api';
