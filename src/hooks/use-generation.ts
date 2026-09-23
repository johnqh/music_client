/**
 * AI generation mutation hooks. AbortSignal passes through so callers can
 * supersede in-flight requests (the music_lib generation slice keeps its own
 * token/abort discipline and may call MusicClient directly instead).
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  CreateGenerationJobRequest,
  GenerateScoreRequest,
  RegenerateRegionRequest,
} from '@sudobility/music_types';
import { musicQueryKeys } from './query-keys';
import { useMusicClient, type MusicHookContext } from './use-projects';
import { hookAuthEnabled, requireHookToken } from './hook-context';

/** How often a running job is checked. Minutes of work, so seconds of latency cost nothing. */
const JOB_POLL_MS = 3000;

export function useGenerateScore(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  return useMutation({
    mutationFn: async ({ req, signal }: { req: GenerateScoreRequest; signal?: AbortSignal }) =>
      client.generateScore(req, await requireHookToken(ctx), signal),
  });
}

export function useRegenerateRegion(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  return useMutation({
    mutationFn: async ({ req, signal }: { req: RegenerateRegionRequest; signal?: AbortSignal }) =>
      client.regenerateRegion(req, await requireHookToken(ctx), signal),
  });
}

/** Starts a generation job. Resolves as soon as the server has recorded it, not when the music is ready. */
export function useCreateGenerationJob(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  return useMutation({
    mutationFn: async (req: CreateGenerationJobRequest) =>
      client.createJob(req, await requireHookToken(ctx)),
  });
}

export function useCancelGenerationJob(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  return useMutation({
    mutationFn: async (id: string) => client.cancelJob(id, await requireHookToken(ctx)),
  });
}

/**
 * Polls a job while it is running.
 *
 * `refetchInterval` returning `false` on a terminal status is what stops the
 * timer — a finished job that kept polling would keep a request loop alive for
 * the rest of the session.
 */
export function useGenerationJob(ctx: MusicHookContext, id: string | null) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  return useQuery({
    queryKey: musicQueryKeys.jobs.detail(id ?? ''),
    enabled: id !== null && hookAuthEnabled(ctx),
    queryFn: async () => client.getJob(id as string, await requireHookToken(ctx)),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? JOB_POLL_MS : false),
  });
}
