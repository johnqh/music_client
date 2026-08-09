/**
 * Project React Query hooks. Sudojo signature convention: every hook takes
 * `networkClient`, `baseUrl`, `token` explicitly (token per-call, never
 * stored). Stale times: list ~2min (dashboard freshness), detail 0 (the
 * editor is the source of truth while a project is open).
 */
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NetworkClient } from '@sudobility/types';
import type {
  ProjectCreateRequest,
  ProjectListQuery,
  ProjectRecord,
  ProjectUpdateRequest,
} from '@sudobility/music_types';
import { MusicClient } from '../network/music-client.js';
import { musicQueryKeys } from './query-keys.js';

export type MusicHookContext = {
  networkClient: NetworkClient;
  baseUrl: string;
  token: string | null;
};

export function useMusicClient(networkClient: NetworkClient, baseUrl: string): MusicClient {
  return useMemo(() => new MusicClient(networkClient, baseUrl), [networkClient, baseUrl]);
}

const PROJECT_LIST_STALE_MS = 2 * 60 * 1000;

export function useProjects(ctx: MusicHookContext, query?: ProjectListQuery) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  return useQuery({
    queryKey: musicQueryKeys.projects.list(query),
    queryFn: () => client.listProjects(ctx.token as string, query),
    enabled: ctx.token !== null,
    staleTime: PROJECT_LIST_STALE_MS,
  });
}

export function useProject(ctx: MusicHookContext, id: string | null) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  return useQuery({
    queryKey: musicQueryKeys.projects.detail(id ?? 'none'),
    queryFn: () => client.getProject(id as string, ctx.token as string),
    enabled: ctx.token !== null && id !== null,
    staleTime: 0,
  });
}

export function useCreateProject(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: ProjectCreateRequest) => client.createProject(req, ctx.token as string),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: musicQueryKeys.projects.all });
    },
  });
}

export function useUpdateProject(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: ProjectUpdateRequest }) =>
      client.updateProject(id, req, ctx.token as string),
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
    mutationFn: (id: string) => client.deleteProject(id, ctx.token as string),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: musicQueryKeys.projects.all });
    },
  });
}
