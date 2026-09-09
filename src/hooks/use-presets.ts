/**
 * The briefs offered as generation starting points.
 *
 * A query rather than a constant because which briefs suit which genre is
 * server-owned product data — retunable without shipping an app, and the same
 * for every client that asks.
 */
import { useQuery } from '@tanstack/react-query';
import { musicQueryKeys } from './query-keys.js';
import { useMusicClient, type MusicHookContext } from './use-projects.js';

/**
 * Static product data, so it is fetched once a session rather than per dialog.
 *
 * `Infinity` and not merely a long stale time: this list changes when the
 * server is deployed, and a reader who has the dialog open through a deploy is
 * not the case worth a refetch loop.
 */
const PRESETS_STALE_MS = Infinity;

/**
 * The briefs for a style, or the general set when none is chosen.
 *
 * Deliberately **not** gated on `ctx.token`, unlike every other query here:
 * the route is public, and gating it would leave the menu empty until Firebase
 * restored the session — the same race that once made the credits balance
 * report "Authorization header required".
 */
export function useScorePresets(
  /**
   * Null where there is no server at all — the native app opens local
   * documents with no `MusicClient`. The query is then simply not run, rather
   * than run and failed on every mount.
   */
  ctx: MusicHookContext | null,
  style: string | undefined,
) {
  const client = useMusicClient(
    ctx?.networkClient as MusicHookContext['networkClient'],
    ctx?.baseUrl ?? '',
  );
  return useQuery({
    queryKey: musicQueryKeys.presets.forStyle(style),
    enabled: ctx !== null,
    queryFn: () => client.getScorePresets(style),
    staleTime: PRESETS_STALE_MS,
    gcTime: PRESETS_STALE_MS,
  });
}
