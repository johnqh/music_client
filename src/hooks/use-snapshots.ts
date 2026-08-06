/**
 * Snapshot React Query hooks.
 *
 * Same signature convention as `use-projects.ts`: `networkClient`, `baseUrl`
 * and `token` passed explicitly, token per call and never stored.
 *
 * A snapshot never changes once saved, so the list is only ever invalidated by
 * *adding* to it — there is no update or delete to invalidate for.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { musicQueryKeys } from './query-keys.js';
import type { MusicHookContext } from './use-projects.js';
import { useMusicClient } from './use-projects.js';

export function useSnapshots(ctx: MusicHookContext, projectId: string | null) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  return useQuery({
    queryKey: musicQueryKeys.snapshots.list(projectId ?? 'none'),
    queryFn: () => client.listSnapshots(projectId as string, ctx.token as string),
    enabled: ctx.token !== null && projectId !== null,
  });
}

export function useCreateSnapshot(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { projectId: string; name: string }) =>
      client.createSnapshot(vars.projectId, vars.name, ctx.token as string),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: musicQueryKeys.snapshots.list(vars.projectId),
      });
      // The project's parentSnapshotId moved, so its cached detail is stale.
      void queryClient.invalidateQueries({
        queryKey: musicQueryKeys.projects.detail(vars.projectId),
      });
    },
  });
}

export function useOpenSnapshot(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { snapshotId: string; projectId: string }) =>
      client.openSnapshot(vars.snapshotId, ctx.token as string),
    onSuccess: (_data, vars) => {
      // The live score was replaced underneath; a stale cache would show the
      // work that was just discarded.
      void queryClient.invalidateQueries({
        queryKey: musicQueryKeys.projects.detail(vars.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: musicQueryKeys.snapshots.list(vars.projectId),
      });
    },
  });
}
