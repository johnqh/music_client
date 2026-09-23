/**
 * Whether the signed-in account is a site administrator.
 *
 * `music_api` grants an administrator free generation — no quota, no balance
 * check, no charge — so they sit at a balance of zero forever, and a client
 * whose courtesy gate did not know it would refuse work the server would have
 * accepted. Both apps asked `GET /me` inside their own auth providers; this is
 * that question asked once, the same way, from either.
 */
import { useQuery } from '@tanstack/react-query';
import { musicQueryKeys } from './query-keys';
import { hookAuthEnabled, requireHookToken, type MusicHookContext } from './hook-context';
import { useMusicClient } from './use-projects';

/**
 * How long an answer is trusted. Administrator status changes by hand on the
 * server, so a reader promoted mid-session waiting a few minutes costs nothing.
 */
const SITE_ADMIN_STALE_MS = 5 * 60 * 1000;

/**
 * True only once the server has said so.
 *
 * **Closed by default**: `false` with no server (`ctx` null), while signed out,
 * while the request is in flight, and when it fails. Failing to learn somebody
 * is an administrator costs them one free job's gate; assuming it would hand
 * everyone an open gate the server then refuses with a 402.
 *
 * Keyed by `ctx.userId`, so after an account switch the previous account's
 * `true` is never shown for the new one while its own answer is on the way.
 * A caller that does not supply `userId` still gets the right answer after the
 * refetch, but may see the old one for that moment.
 */
export function useSiteAdmin(ctx: MusicHookContext | null): boolean {
  const client = useMusicClient(
    ctx?.networkClient as MusicHookContext['networkClient'],
    ctx?.baseUrl ?? ''
  );
  const enabled = hookAuthEnabled(ctx);
  const query = useQuery({
    queryKey: musicQueryKeys.me(ctx?.userId),
    enabled,
    queryFn: async () => client.getCurrentUser(await requireHookToken(ctx as MusicHookContext)),
    staleTime: SITE_ADMIN_STALE_MS,
  });
  return enabled && query.isSuccess && query.data?.siteAdmin === true;
}
