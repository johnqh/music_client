/**
 * Snapshot history for an open project: list, create, publish, rename,
 * withdraw, open.
 *
 * Both apps carried this — the web editor's title bar and the native
 * `SnapshotsPanel` — and they had drifted: the native one re-downloaded the
 * whole project after every create and every open, and suggested a different
 * public title. The rules, each of which is a bug somebody hit:
 *
 * - **Create flushes the live score first.** The server copies the stored
 *   projects row, and saving is debounced — without the flush a snapshot pins
 *   whatever the server last received rather than what is on screen, which
 *   right after a generation is the empty placeholder.
 * - **Nothing re-downloads the project.** Creating a snapshot changes no music;
 *   opening one hands the score back in its own response. What both *do* change
 *   is the project row's `updatedAt` (it is re-parented), so this client tells
 *   the host where the server now stands (`noteServerVersion`) — otherwise the
 *   generation poll reads this client's own write as somebody else's and
 *   reloads over the top of it, undo history and all.
 * - **There is no edit or delete.** Immutability is enforced by the absence of
 *   a route. Publishing is metadata about *sharing*, so a published title can
 *   still change: re-publishing sets it, and the server keeps the first
 *   `publicId`, so a link already shared stays valid across a rename.
 * - **A blank public title or publisher is refused** before anything is sent,
 *   including the snapshot a publish-on-create would have made — a half-made
 *   result (a snapshot that silently did not publish) is worse than none.
 */
import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  snapshotTree,
  type ProjectRecord,
  type PublishNames,
  type Score,
  type SnapshotSummary,
  type TreeNode,
} from '@sudobility/music_types';
import { musicQueryKeys } from './query-keys';
import { hookAuthEnabled, requireHookToken, type MusicHookContext } from './hook-context';
import { useMusicClient } from './use-projects';

/**
 * The public title offered for a new snapshot: the project's name, then the
 * snapshot's, separated by a space, with a blank half dropped — "Song Version 2".
 *
 * The web rule. The native sheet joined them with an em dash and kept a blank
 * half, which produced "Song — " for an unnamed snapshot.
 */
export function suggestedPublicName(projectName: string, snapshotName: string): string {
  return [projectName.trim(), snapshotName.trim()].filter((part) => part).join(' ');
}

/**
 * Which name makes a publish impossible, or null when both are usable.
 *
 * A form can use this to say *why* it will not submit; the hook applies the
 * same rule and refuses. A blank publisher puts an unattributable row on a
 * public page; a blank title puts an unnamed one there.
 */
export function publishNamesProblem(names: PublishNames): 'publisherName' | 'publicName' | null {
  if (names.publisherName.trim() === '') return 'publisherName';
  if (names.publicName.trim() === '') return 'publicName';
  return null;
}

export type ProjectSnapshotsCallbacks = {
  /**
   * Writes any pending edit to the server. Awaited before a snapshot is asked
   * for. Supply the autosaver's own flush (music_lib's `saveNow`), which is a
   * no-op when nothing is dirty — not a PUT of its own.
   */
  flush?: () => Promise<unknown> | unknown;
  /**
   * Takes an opened snapshot's score into the editor.
   *
   * Called with the score from `openSnapshot`'s response; the project is not
   * re-read. The host must **stop playback first** (a score arriving from
   * outside bypasses the edit lock) and adopt it as an ordinary replacement
   * rather than a fresh document — undo history is kept, so opening an old
   * version by mistake is one undo away from the work it replaced.
   */
  onAdopt: (score: Score, project: ProjectRecord) => void | Promise<void>;
  /**
   * Records where this client's own write left the server's copy
   * (music_lib's `noteServerVersion`). Called after create and after open,
   * after `onAdopt` for the latter.
   */
  noteServerVersion?: (updatedAt: string) => void;
};

export type ProjectSnapshots = {
  /** The project's snapshots, oldest first as the server lists them; null until loaded. */
  snapshots: SnapshotSummary[] | null;
  /** `snapshotTree(snapshots, parentSnapshotId)`, live node included; empty until loaded. */
  nodes: TreeNode[];
  /** The snapshot the live work descends from. */
  parentSnapshotId: string | null;
  /** The snapshots that are currently public. */
  published: SnapshotSummary[];
  /** The name this account last published under, to prefill the form. */
  defaultPublisherName: string | undefined;
  isLoading: boolean;
  /** The list's load failure, if any. Writes reject instead. */
  error: unknown;
  refresh: () => Promise<void>;
  /**
   * Pins the live score (flushing first), optionally publishing it in the same
   * step. Names are trimmed. Resolves null — having sent nothing — for a blank
   * name or unusable publish names; resolves the (published, when asked)
   * summary otherwise.
   */
  create: (input: { name: string; publish?: PublishNames }) => Promise<SnapshotSummary | null>;
  /** Publishes (or re-publishes) a snapshot. Null, having sent nothing, for unusable names. */
  publish: (snapshotId: string, names: PublishNames) => Promise<SnapshotSummary | null>;
  /**
   * Renames a publication: a re-publish with the existing publisher kept.
   * Null, having sent nothing, for a blank title or a snapshot not published.
   */
  rename: (snapshotId: string, publicName: string) => Promise<SnapshotSummary | null>;
  unpublish: (snapshotId: string) => Promise<SnapshotSummary>;
  /**
   * Replaces the live project with a snapshot on the server (branching, never
   * overwriting history), hands the score to `onAdopt`, and notes the new
   * server version.
   */
  open: (snapshotId: string) => Promise<ProjectRecord>;
};

type SnapshotState = {
  snapshots: SnapshotSummary[];
  parentSnapshotId: string | null;
  updatedAt: string;
};

export function useProjectSnapshots(
  ctx: MusicHookContext,
  projectId: string | null,
  callbacks: ProjectSnapshotsCallbacks
): ProjectSnapshots {
  const client = useMusicClient(ctx.networkClient, ctx.baseUrl);
  const queryClient = useQueryClient();
  const enabled = hookAuthEnabled(ctx) && projectId !== null;
  const stateKey = useMemo(() => musicQueryKeys.snapshots.forProject(projectId ?? ''), [projectId]);
  const publisherKey = useMemo(() => musicQueryKeys.snapshots.publisherName(ctx.userId), [ctx.userId]);

  const fetchState = useCallback(async (): Promise<SnapshotState> => {
    const token = await requireHookToken(ctx);
    // The live project's parent rides on the status call, so nothing fetches a
    // whole project (score and all) to read one id.
    const [snapshots, status] = await Promise.all([
      client.listSnapshots(projectId as string, token),
      client.getProjectStatus(projectId as string, token),
    ]);
    return { snapshots, parentSnapshotId: status.parentSnapshotId ?? null, updatedAt: status.updatedAt };
  }, [client, ctx, projectId]);

  const state = useQuery({
    queryKey: stateKey,
    enabled,
    queryFn: fetchState,
    staleTime: 0,
  });

  const publisher = useQuery({
    queryKey: publisherKey,
    enabled: hookAuthEnabled(ctx),
    queryFn: async () => client.lastPublisherName(await requireHookToken(ctx)),
  });

  /** Re-reads the list and status now, and answers what it read. */
  const reread = useCallback(async (): Promise<SnapshotState> => {
    return queryClient.fetchQuery({ queryKey: stateKey, queryFn: fetchState, staleTime: 0 });
  }, [queryClient, fetchState, stateKey]);

  const { flush, onAdopt, noteServerVersion } = callbacks;

  const publish = useCallback(
    async (snapshotId: string, names: PublishNames): Promise<SnapshotSummary | null> => {
      if (publishNamesProblem(names)) return null;
      const token = await requireHookToken(ctx);
      const published = await client.publishSnapshot(
        snapshotId,
        { publisherName: names.publisherName.trim(), publicName: names.publicName.trim() },
        token
      );
      void queryClient.invalidateQueries({ queryKey: publisherKey });
      await reread();
      return published;
    },
    [ctx, client, queryClient, reread, publisherKey]
  );

  const create = useCallback(
    async (input: { name: string; publish?: PublishNames }): Promise<SnapshotSummary | null> => {
      if (!projectId) return null;
      const name = input.name.trim();
      if (name === '') return null;
      if (input.publish && publishNamesProblem(input.publish)) return null;

      await flush?.();
      const token = await requireHookToken(ctx);
      let snapshot = await client.createSnapshot(projectId, name, token);
      if (input.publish) {
        snapshot = await client.publishSnapshot(
          snapshot.id,
          {
            publisherName: input.publish.publisherName.trim(),
            publicName: input.publish.publicName.trim(),
          },
          token
        );
        void queryClient.invalidateQueries({ queryKey: publisherKey });
      }
      // Creating re-parents the project row; the status read that refreshes the
      // tree is also where this client learns the row's new stamp.
      const next = await reread();
      noteServerVersion?.(next.updatedAt);
      return snapshot;
    },
    [projectId, flush, ctx, client, queryClient, reread, noteServerVersion, publisherKey]
  );

  const rename = useCallback(
    async (snapshotId: string, publicName: string): Promise<SnapshotSummary | null> => {
      // From the cache, not the render: a rename straight after a publish must
      // see the publication even before the component has re-rendered.
      const current = queryClient.getQueryData<SnapshotState>(stateKey);
      const existing = current?.snapshots.find((s) => s.id === snapshotId);
      // This dialog edits the title, not the attribution.
      if (!existing?.publicId || !existing.publisherName) return null;
      return publish(snapshotId, { publisherName: existing.publisherName, publicName });
    },
    [queryClient, stateKey, publish]
  );

  const unpublish = useCallback(
    async (snapshotId: string): Promise<SnapshotSummary> => {
      const withdrawn = await client.unpublishSnapshot(snapshotId, await requireHookToken(ctx));
      await reread();
      return withdrawn;
    },
    [client, ctx, reread]
  );

  const open = useCallback(
    async (snapshotId: string): Promise<ProjectRecord> => {
      const project = await client.openSnapshot(snapshotId, await requireHookToken(ctx));
      // Adopted before the stamp is noted, so a poll never pairs the new stamp
      // with the old score.
      await onAdopt(project.score, project);
      noteServerVersion?.(project.updatedAt);
      await reread();
      return project;
    },
    [client, ctx, onAdopt, noteServerVersion, reread]
  );

  const refresh = useCallback(async () => {
    if (!enabled) return;
    await reread();
  }, [enabled, reread]);

  const data = enabled ? state.data : undefined;
  const nodes = useMemo(
    () => (data ? snapshotTree(data.snapshots, data.parentSnapshotId) : []),
    [data]
  );

  return {
    snapshots: data?.snapshots ?? null,
    nodes,
    parentSnapshotId: data?.parentSnapshotId ?? null,
    published: (data?.snapshots ?? []).filter((s) => s.publicId),
    defaultPublisherName: publisher.data?.publisherName ?? undefined,
    isLoading: enabled && state.isLoading,
    error: state.error,
    refresh,
    create,
    publish,
    rename,
    unpublish,
    open,
  };
}
