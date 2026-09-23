/**
 * Project React Query hooks. Every hook takes a `MusicHookContext`
 * (`networkClient`, `baseUrl`, and `getToken` — the token is read per request,
 * never stored). Stale times: list ~2min (dashboard freshness), detail 0 (the
 * editor is the source of truth while a project is open).
 */
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NetworkClient } from '@sudobility/types';
import type {
  ProjectCreateRequest,
  ProjectDuplicateRequest,
  ProjectListQuery,
  ProjectRecord,
  ProjectSummary,
  ProjectUpdateRequest,
} from '@sudobility/music_types';
import { MusicClient } from '../network/music-client';
import { musicQueryKeys } from './query-keys';
import { hookAuthEnabled, requireHookToken, type MusicHookContext } from './hook-context';
import { GENERATION_POLL_MS } from './use-project-generation';

export type { MusicHookContext } from './hook-context';

export function useMusicClient(networkClient: NetworkClient, baseUrl: string): MusicClient {
  return useMemo(() => new MusicClient(networkClient, baseUrl), [networkClient, baseUrl]);
}

const PROJECT_LIST_STALE_MS = 2 * 60 * 1000;

export type UseProjectsOptions = {
  /**
   * Re-fetch the list every `GENERATION_POLL_MS` while any row is still being
   * worked on server-side (`generating`, or `transcribing` — both finish on
   * their own and flip the row back to `ready`), and stop the moment none is.
   *
   * Off by default. A list that refetched forever would keep a request loop
   * alive for the whole session; one that never did would leave a finished
   * generation showing its badge until the reader reloaded.
   */
  pollWhileGenerating?: boolean;
};

/** Whether a list still has server-side work in flight. */
export function hasProjectsInFlight(projects: readonly ProjectSummary[] | undefined): boolean {
  return (projects ?? []).some((p) => p.status !== 'ready');
}

export function useProjects(
  ctx: MusicHookContext,
  query?: ProjectListQuery,
  options: UseProjectsOptions = {}
) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  const { pollWhileGenerating = false } = options;
  return useQuery({
    queryKey: musicQueryKeys.projects.list(query),
    queryFn: async () => client.listProjects(await requireHookToken(ctx), query),
    enabled: hookAuthEnabled(ctx),
    staleTime: PROJECT_LIST_STALE_MS,
    refetchInterval: (q) =>
      pollWhileGenerating && hasProjectsInFlight(q.state.data) ? GENERATION_POLL_MS : false,
  });
}

export function useProject(ctx: MusicHookContext, id: string | null) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  return useQuery({
    queryKey: musicQueryKeys.projects.detail(id ?? 'none'),
    queryFn: async () => client.getProject(id as string, await requireHookToken(ctx)),
    enabled: hookAuthEnabled(ctx) && id !== null,
    staleTime: 0,
  });
}

export function useCreateProject(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (req: ProjectCreateRequest) =>
      client.createProject(req, await requireHookToken(ctx)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: musicQueryKeys.projects.all });
    },
  });
}

export function useUpdateProject(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, req }: { id: string; req: ProjectUpdateRequest }) =>
      client.updateProject(id, req, await requireHookToken(ctx)),
    onSuccess: (saved, { req }) => {
      // A save returns metadata, not a record — writing it into the detail
      // cache verbatim would replace a cached project with a score-less one.
      // Patch the cached entry instead, keeping the score this very request
      // just sent (or the cached one, for a prefs-only save).
      queryClient.setQueryData(
        musicQueryKeys.projects.detail(saved.id),
        (previous: ProjectRecord | undefined) => {
          const score = req.score ?? previous?.score;
          return score ? { ...saved, score } : previous;
        }
      );
      void queryClient.invalidateQueries({ queryKey: musicQueryKeys.projects.list() });
    },
  });
}

export function useDeleteProject(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => client.deleteProject(id, await requireHookToken(ctx)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: musicQueryKeys.projects.all });
    },
  });
}

/**
 * Copies a project server-side; the score never crosses the wire.
 *
 * `req.name` defaults on the server to "<original name> (copy)". Refreshes the
 * list, since the copy is a new row the reader is looking at the list for.
 */
export function useDuplicateProject(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, req = {} }: { id: string; req?: ProjectDuplicateRequest }) =>
      client.duplicateProject(id, req, await requireHookToken(ctx)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: musicQueryKeys.projects.all });
    },
  });
}

/**
 * Cancels a project's running generation by project id.
 *
 * By project rather than job, because a list row carries no job id — and a
 * project can have only one running job, so this is unambiguous. The server
 * releases the project synchronously; the list refresh shows it `ready`.
 */
export function useCancelProjectGeneration(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (projectId: string) =>
      client.cancelProjectGeneration(projectId, await requireHookToken(ctx)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: musicQueryKeys.projects.all });
    },
  });
}
