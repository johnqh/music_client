/**
 * The signed-in account's profile: the nickname it publishes snapshots under,
 * and its picture.
 *
 * Every write answers the whole profile, so a success is written straight into
 * the cache rather than refetched. The nickname is also what
 * `GET /snapshots/publisher-name` answers when one is set, so every write here
 * invalidates that query too — otherwise the publish form goes on offering the
 * name the account had before.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ProfileUpdateRequest, UserProfile } from '@sudobility/music_types';
import type { UploadableFile } from '../network/music-client';
import { musicQueryKeys } from './query-keys';
import { hookAuthEnabled, requireHookToken, type MusicHookContext } from './hook-context';
import { useMusicClient } from './use-projects';

/**
 * How long a profile is trusted. It changes only through the writes below,
 * which update the cache themselves; this covers a change made on another
 * device.
 */
const PROFILE_STALE_MS = 5 * 60 * 1000;

/** A picture on its way up, with the filename the server should see. */
export type AvatarUpload = { file: UploadableFile; filename: string };

/**
 * The profile query. Idle with no server (`ctx` null) and while signed out.
 *
 * Keyed by `ctx.userId`, so one account's nickname and picture are never shown
 * for the next one signed in on the same device.
 */
export function useProfile(ctx: MusicHookContext | null) {
  const client = useMusicClient(
    ctx?.networkClient as MusicHookContext['networkClient'],
    ctx?.baseUrl ?? ''
  );
  return useQuery({
    queryKey: musicQueryKeys.profile(ctx?.userId),
    enabled: hookAuthEnabled(ctx),
    queryFn: async () => client.getProfile(await requireHookToken(ctx as MusicHookContext)),
    staleTime: PROFILE_STALE_MS,
  });
}

/** What every profile write does with the profile the server answered. */
function adoptProfile(
  queryClient: QueryClient,
  userId: string | null | undefined,
  profile: UserProfile
): void {
  queryClient.setQueryData(musicQueryKeys.profile(userId), profile);
  void queryClient.invalidateQueries({ queryKey: musicQueryKeys.snapshots.publisherName(userId) });
}

/** Sets the nickname, or clears it with `{ nickname: null }`. */
export function useUpdateProfile(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (req: ProfileUpdateRequest) =>
      client.updateProfile(req, await requireHookToken(ctx)),
    onSuccess: (profile) => adoptProfile(queryClient, ctx.userId, profile),
  });
}

export function useUploadAvatar(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, filename }: AvatarUpload) =>
      client.uploadAvatar(file, filename, await requireHookToken(ctx)),
    onSuccess: (profile) => adoptProfile(queryClient, ctx.userId, profile),
  });
}

export function useDeleteAvatar(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => client.deleteAvatar(await requireHookToken(ctx)),
    onSuccess: (profile) => adoptProfile(queryClient, ctx.userId, profile),
  });
}
