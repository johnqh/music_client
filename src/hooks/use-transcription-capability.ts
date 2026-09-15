/**
 * Whether this deployment can transcribe audio at all.
 *
 * Probed before offering the upload rather than discovered by failing:
 * uploading a recording and only then being told the server never could is the
 * worst order to learn it in.
 */
import { useQuery } from '@tanstack/react-query';
import { musicQueryKeys } from './query-keys.js';
import { hookAuthEnabled, requireHookToken, type MusicHookContext } from './hook-context.js';
import { useMusicClient } from './use-projects.js';

export type TranscriptionCapability = {
  /**
   * `true`/`false` once the server has answered; `null` while unknown — before
   * the answer, with no server, and when the probe **fails**. A host should
   * leave the option enabled on `null`: a failed probe says nothing about
   * whether transcription works, and the upload reports its own 503 clearly
   * enough if it does not.
   */
  available: boolean | null;
  /**
   * Asks again. Call it when the import dialog opens: a deployment can gain or
   * lose its credentials while an app stays open, which is why the answer is
   * never treated as fresh (`staleTime` 0) either.
   */
  recheck: () => Promise<unknown>;
};

export function useTranscriptionCapability(ctx: MusicHookContext | null): TranscriptionCapability {
  const client = useMusicClient(
    ctx?.networkClient as MusicHookContext['networkClient'],
    ctx?.baseUrl ?? ''
  );
  const query = useQuery({
    queryKey: musicQueryKeys.transcription.capability,
    enabled: hookAuthEnabled(ctx),
    queryFn: async () =>
      client.getTranscriptionCapability(await requireHookToken(ctx as MusicHookContext)),
    staleTime: 0,
  });
  return {
    available: query.isSuccess ? query.data.available : null,
    recheck: () => query.refetch(),
  };
}
