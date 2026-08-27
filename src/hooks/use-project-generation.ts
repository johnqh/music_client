/**
 * Watching a project through a generation, and starting one.
 *
 * A generation is a **server-side job**: `POST /jobs` returns as soon as the row
 * exists, the server runs the work in-process, applies the result to the project
 * itself, and flips `projects.status` back to `ready`. So there is nothing to
 * await — there is only something to watch.
 *
 * This hook watches the **project**, not the job it started. A generation begun
 * somewhere else — another device, or this app's own dashboard — belongs to no
 * job id here, and a job-only poll left an editor showing the placeholder score
 * forever: no overlay, no reload, nothing to say it was still working. The
 * project's status is the one thing that answers "can I be edited right now",
 * whoever started the job, which is exactly why the server keeps it.
 *
 * Every dependency is passed in, including the two that differ by platform: the
 * store this app keeps its score in, and how to tell whether anybody is looking
 * (a browser tab's `visibilitychange`, or React Native's `AppState`). That is
 * what lets one implementation of these rules serve both apps — and the rules
 * are the valuable part, since almost every one of them is a bug somebody hit.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GenerationJob, GenerationJobKind } from '@sudobility/music_types';
import type { MusicClient } from '../network/music-client.js';

/** How often the project is checked while a job is running. */
export const GENERATION_POLL_MS = 3000;

/**
 * How often it is checked when *nothing* is generating.
 *
 * The poll has a second job besides watching a job: noticing that the server's
 * copy moved under this editor. That is rare, so asking every three seconds
 * meant roughly 1,200 requests an hour per open editor to learn nothing. Three
 * seconds is what a running job deserves; half a minute is what an idle project
 * deserves, and an app brought back to the front checks immediately rather than
 * waiting out the interval.
 */
export const GENERATION_IDLE_POLL_MS = 30_000;

/**
 * Whether anybody is looking at this app, and a way to be told when that
 * changes.
 *
 * A port rather than a global, because the answer comes from a browser tab's
 * `document.hidden` on one platform and React Native's `AppState` on the other.
 * It is what makes the slow idle cadence affordable: the wait is never felt,
 * because the moment anyone looks the answer is already being fetched.
 */
export type ForegroundPort = {
  isForeground(): boolean;
  /** Calls back when the app comes to the front. Returns an unsubscribe. */
  subscribe(onForeground: () => void): () => void;
};

/** Always-foreground, for a platform with no such notion and for tests. */
export const ALWAYS_FOREGROUND: ForegroundPort = {
  isForeground: () => true,
  subscribe: () => () => {},
};

/**
 * The part of an editor store this hook reads and writes.
 *
 * Structural rather than an import of `EditorStoreApi`, so music_client does
 * not depend on the store library — and so a native app whose stores are
 * per-document can pass whichever one the open document has.
 */
export type GenerationStore = {
  getState(): {
    /** Where this client last saw the server's copy, if it tracks that. */
    serverUpdatedAt?: string | null;
    saveState?: string;
    /**
     * Shows a message that outlives whatever raised it.
     *
     * Typed loosely on purpose: each app's toast slice has its own severity
     * union and its own return value, and narrowing to one of them here would
     * make this hook depend on a store library. What matters is that a failed
     * job can still say so after the overlay that would have shown it is gone.
     */
    pushToast?(toast: { message: string; severity: 'error' }): unknown;
  };
};

/** The client calls this hook makes. Narrowed so a test can stub four methods. */
export type GenerationClient = Pick<
  MusicClient,
  | 'createJob'
  | 'getJob'
  | 'cancelJob'
  | 'cancelProjectGeneration'
  | 'getProjectStatus'
>;

export type ProjectGeneration = {
  /** True from the moment a job is submitted until it reaches a terminal status. */
  generating: boolean;
  jobId: string | null;
  /** A failed job's message, cleared when the next one starts. */
  error: string | null;
  start: (kind: GenerationJobKind, request: unknown) => Promise<void>;
  cancel: () => Promise<void>;
};

export type UseProjectGenerationOptions = {
  store: GenerationStore;
  client: GenerationClient;
  getToken: () => Promise<string | null>;
  /** How the app knows whether anybody is looking. */
  foreground?: ForegroundPort;
  /**
   * Flushes any pending save before the job is created.
   *
   * The job reads the **stored** score, so an edit still sitting in a debounce
   * window would be invisible to it and then overwritten by its result. Passed
   * in rather than called on the store, because who owns saving differs: the
   * web app's store autosaves a project, where the native app writes a file and
   * the store knows nothing about it.
   */
  flush?: () => Promise<unknown> | unknown;
  /** Called when the server's copy has moved on. Awaited before unlocking. */
  onApplied?: () => void | Promise<void>;
  /**
   * Handles a start failure that has its own remedy — running out of credits,
   * which opens a store rather than printing a message. Returning true means
   * "handled"; the inline error then stays empty, because the modal is the
   * message and a banner behind it reads as two separate failures.
   */
  onStartError?: (error: unknown) => boolean;
  /** The message for a start attempted with no token. */
  signInRequiredMessage?: string;
  pollMs?: number;
  idlePollMs?: number;
};

export function useProjectGeneration(
  projectId: string | null,
  options: UseProjectGenerationOptions
): ProjectGeneration {
  const {
    store,
    client,
    getToken,
    foreground = ALWAYS_FOREGROUND,
    flush,
    onApplied,
    onStartError,
    signInRequiredMessage = 'You must be signed in.',
    pollMs = GENERATION_POLL_MS,
    idlePollMs = GENERATION_IDLE_POLL_MS,
  } = options;

  const [jobId, setJobId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read inside the interval callback, never as a dep: re-creating the timer on
  // every render would reset the poll clock continuously.
  const onAppliedRef = useRef(onApplied);
  onAppliedRef.current = onApplied;

  /** Which cadence the next tick should use. A ref because the timer reads it. */
  const generatingRef = useRef(generating);
  generatingRef.current = generating;

  /**
   * The server's `updatedAt` as of the last poll, for a store that tracks none.
   *
   * A witnessed `generating -> ready` transition is not enough: open a project
   * in the instant its job finishes and the transition happens in the gap
   * between the fetch and the first poll, so the editor keeps the placeholder
   * score forever. Comparing freshness catches that, and any other change the
   * server makes, without needing to have seen it happen.
   *
   * A ref, not an effect-local: `start()` sets `jobId`, which re-runs the poll
   * effect, and a local would forget everything it had already seen.
   */
  const lastUpdatedAtRef = useRef<string | null>(null);

  const start = useCallback(
    async (kind: GenerationJobKind, request: unknown): Promise<void> => {
      if (!projectId) return;
      setError(null);
      try {
        // Flush first: the job reads the *stored* score, so a pending edit
        // would be invisible to it and then overwritten by its result.
        await flush?.();

        const token = await getToken();
        if (!token) throw new Error(signInRequiredMessage);

        const job = await client.createJob({ projectId, kind, request }, token);
        setJobId(job.id);
        setGenerating(true);
        // Written straight through as well, so the next tick is scheduled at
        // the running-job cadence rather than one idle interval late.
        generatingRef.current = true;
      } catch (err) {
        setGenerating(false);
        generatingRef.current = false;
        if (onStartError?.(err)) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [projectId, flush, client, getToken, onStartError, signInRequiredMessage]
  );

  const cancel = useCallback(async (): Promise<void> => {
    const id = jobId;
    // Optimistic: the server releases the project synchronously, and the editor
    // should unlock now rather than after a round trip.
    setGenerating(false);
    generatingRef.current = false;
    setJobId(null);
    try {
      const token = await getToken();
      if (!token) return;
      // Cancel by project when this hook did not start the job — a generation
      // begun elsewhere is perfectly cancellable from the editor.
      if (id) await client.cancelJob(id, token);
      else if (projectId) await client.cancelProjectGeneration(projectId, token);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [jobId, projectId, client, getToken]);

  useEffect(() => {
    if (!projectId) return;
    let stopped = false;

    const check = async (): Promise<void> => {
      // Nobody is looking at a backgrounded app, and the subscription below
      // catches it up the instant somebody is.
      if (!foreground.isForeground()) return;
      try {
        const token = await getToken();
        if (!token || stopped) return;

        // Status only: the score cannot change while generating (writes are
        // rejected), so refetching it every few seconds is pure waste — and
        // under load it was enough to time jobs out.
        const { status, updatedAt } = await client.getProjectStatus(
          projectId,
          token
        );
        if (stopped) return;

        /*
          What this client already knows the server's copy to say.

          The store's own record when it has one, because that is updated by
          *this client's* writes as well as by its reads — an autosave used to
          read as a foreign change here, so every edit was followed by a full
          re-download of the project it had just uploaded, undo history and all.
          The ref is the fallback for a store that tracks none.
        */
        const state = store.getState();
        const known = state.serverUpdatedAt ?? lastUpdatedAtRef.current;
        lastUpdatedAtRef.current = updatedAt;

        if (status === 'generating') {
          setGenerating(true);
          generatingRef.current = true;
          return;
        }

        /*
          Strictly newer, not merely different: a poll that started before a
          save landed reports the older stamp, and "different" would send it to
          reload over the top of the save it raced.

          A save still in flight may already have committed while its response
          is in the air, so for that moment a newer stamp is not evidence of
          anybody else. The save will record where it left the server, and the
          next poll compares against that.

          First observation only records where things stand; it must not be read
          as a change, or every mount would refetch and clobber unsaved local
          edits.

          Reload *before* unlocking. Clearing the cover first shows the old
          music as though it were the result, and a reader who starts editing in
          that window has their work replaced a moment later.
        */
        if (
          state.saveState !== 'saving' &&
          known !== null &&
          known !== undefined &&
          updatedAt > known
        ) {
          await onAppliedRef.current?.();
        }
        if (stopped) return;
        setGenerating(false);
        generatingRef.current = false;

        /*
          A job we started that ended badly still owes an explanation.

          Through a toast as well as the inline error, because whatever renders
          the inline one has just been unmounted by the line above: the editor
          came back, the track was missing, and the reason was written to a
          component that no longer existed. A toast outlives the overlay, which
          is the whole point of having one.
        */
        if (jobId) {
          const job: GenerationJob = await client.getJob(jobId, token);
          if (!stopped && job.status === 'failed') {
            const message = job.error ?? 'Generation failed.';
            setError(message);
            store.getState().pushToast?.({ message, severity: 'error' });
          }
        }
      } catch (err) {
        /*
          A transient poll failure is not a finished job — keep polling rather
          than unlocking an editor whose project is still generating.

          A *programming* error is different: a stale bundle missing a client
          method once hid behind this catch for a whole debugging session, so
          that is surfaced rather than swallowed.

          Matched on the message, not `instanceof TypeError`: fetch rejects with
          a TypeError for ordinary network failures too ("Failed to fetch"), and
          treating a page navigating away as a bug logged errors and put a
          spurious message in the overlay.
        */
        const message = err instanceof Error ? err.message : '';
        if (
          /is not a function|undefined is not an object|Cannot read propert/.test(
            message
          )
        ) {
          // Logged as well as shown: this is the case where a stale bundle
          // missing a client method hid behind the catch for a whole debugging
          // session, and the overlay's message alone was not enough to place
          // it.
          console.error('[generation] poll failed', err);
          setError(message);
        }
      }
    };

    /*
      A self-rescheduling timeout rather than an interval, so the cadence can
      change with what is actually happening: three seconds while a job runs,
      half a minute while nothing does.
    */
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async (): Promise<void> => {
      await check();
      if (stopped) return;
      timer = setTimeout(
        () => void tick(),
        generatingRef.current ? pollMs : idlePollMs
      );
    };

    const unsubscribe = foreground.subscribe(() => void check());

    void tick();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [
    projectId,
    jobId,
    pollMs,
    idlePollMs,
    client,
    getToken,
    store,
    foreground,
  ]);

  return { generating, jobId, error, start, cancel };
}
