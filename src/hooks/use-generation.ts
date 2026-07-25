/**
 * AI generation mutation hooks. AbortSignal passes through so callers can
 * supersede in-flight requests (the music_lib generation slice keeps its own
 * token/abort discipline and may call MusicClient directly instead).
 */
import { useMutation } from '@tanstack/react-query';
import type {
  GenerateScoreRequest,
  RegenerateRegionRequest,
} from '@sudobility/music_types';
import { useMusicClient, type MusicHookContext } from './use-projects.js';

export function useGenerateScore(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  return useMutation({
    mutationFn: ({ req, signal }: { req: GenerateScoreRequest; signal?: AbortSignal }) =>
      client.generateScore(req, ctx.token as string, signal),
  });
}

export function useRegenerateRegion(ctx: MusicHookContext) {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  return useMutation({
    mutationFn: ({ req, signal }: { req: RegenerateRegionRequest; signal?: AbortSignal }) =>
      client.regenerateRegion(req, ctx.token as string, signal),
  });
}
