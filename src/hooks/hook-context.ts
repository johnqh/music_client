/**
 * What every hook in this package is handed, and how it gets a token from it.
 *
 * The token is **resolved per request**, not captured. A token copied into the
 * context when it was built goes stale an hour into a session, and one read at
 * start-up is null for a signed-in user until Firebase has restored the
 * session — the native app worked around that with a state-and-effect dance in
 * front of every hook, and the web app avoided the hooks altogether. With
 * `getToken`, the moment a hook sends is the moment it asks.
 */
import type { NetworkClient } from '@sudobility/types';
import { ApiError } from '../errors.js';

export type MusicHookContext = {
  networkClient: NetworkClient;
  baseUrl: string;
  /**
   * Answers the bearer token at the moment a request is sent, or null when
   * nobody is signed in. Awaited per request — pass the auth layer's own
   * function (it should wait for the session to be restored), never a closure
   * over a token read earlier.
   */
  getToken?: () => Promise<string | null>;
  /**
   * Who is signed in: an id when somebody is, `null` when nobody is, and
   * absent when the caller does not track it.
   *
   * With `getToken`, a query cannot know synchronously whether it may run —
   * so `null` here is what keeps queries idle while signed out, and the id is
   * what keys per-account answers (`useSiteAdmin`) so one account's answer is
   * never shown to the next. Absent means "assume signed in": the request
   * runs, and fails with a 401-shaped `ApiError` if there is no token.
   */
  userId?: string | null;
  /**
   * @deprecated A token captured when the context was built. Use `getToken`.
   * Still honoured when `getToken` is absent, so existing callers compile and
   * behave exactly as before: queries are disabled while it is null.
   */
  token?: string | null;
};

/** Whether a token-requiring query may run at all. False for no server. */
export function hookAuthEnabled(ctx: MusicHookContext | null): boolean {
  if (!ctx) return false;
  if (ctx.getToken) return ctx.userId !== null;
  return ctx.token !== null && ctx.token !== undefined;
}

/** The token for a request being sent now: `getToken` first, the deprecated field after. */
export async function resolveHookToken(ctx: MusicHookContext): Promise<string | null> {
  if (ctx.getToken) return ctx.getToken();
  return ctx.token ?? null;
}

/**
 * The token, or a rejection before anything is sent.
 *
 * A 401-shaped `ApiError` rather than a request without a header: the server
 * would answer the same thing a round trip later, and a caller branching on
 * `status` sees one failure either way.
 */
export async function requireHookToken(ctx: MusicHookContext): Promise<string> {
  const token = await resolveHookToken(ctx);
  if (!token) throw new ApiError('Sign in required.', 401);
  return token;
}
