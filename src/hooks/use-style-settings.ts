import { useQuery } from '@tanstack/react-query';
import { musicQueryKeys } from './query-keys';
import { useMusicClient, type MusicHookContext } from './use-projects';

const STYLE_SETTINGS_STALE_MS = Infinity;

/** Backend-owned style controls, shared by web and native generation forms. */
export function useScoreStyleSettings(ctx: MusicHookContext | null) {
  const client = useMusicClient(
    ctx?.networkClient as MusicHookContext['networkClient'],
    ctx?.baseUrl ?? '',
  );
  return useQuery({
    queryKey: musicQueryKeys.styleSettings.all,
    enabled: ctx !== null,
    queryFn: () => client.getScoreStyleSettings(),
    staleTime: STYLE_SETTINGS_STALE_MS,
    gcTime: STYLE_SETTINGS_STALE_MS,
  });
}
