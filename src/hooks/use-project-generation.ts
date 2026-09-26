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
 *
 * ## Live generation
 *
 * With `live` configured the hook also opens the job's WebSocket
 * (`/api/v1/jobs/:id/live`) and folds what arrives — the server's snapshot,
 * then each partial — into the store through `applyLiveScore`, so the reader
 * watches the notes appear rather than a spinner. **While the socket is open
 * the status poll does not run at all**: the stream carries every change the
 * poll could report, and a status request every few seconds beside it was
 * pure repetition. The poll is what runs when the socket is *not* delivering —
 * it never opened, it is reconnecting, it gave up, or the app is in the
 * background — and it resumes the instant the socket reports any of those,
 * so a job that ends while nobody was connected is still noticed. On
 * `complete` the final score is adopted straight from the message — the
 * server read it back from the row after its last write, so it is byte for
 * byte what `GET /projects/:id` would return — and the poll's freshness rule
 * is told so, which is what keeps `onApplied` from re-downloading a project
 * the client already holds.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyLiveGenerationMessage,
  INITIAL_LIVE_GENERATION_STATE,
  type GenerationJob,
  type GenerationJobKind,
  type GenerationRecord,
  type LiveGenerationMessage,
  type LiveGenerationProgress,
  type LiveGenerationState,
  type ProjectStatus,
  type Score,
  type ScoreRange,
} from '@sudobility/music_types';
import type { MusicClient } from '../network/music-client';
import {
  openLiveGeneration,
  defaultWebSocketFactory,
  type LiveGenerationSocket,
  type ReconnectPolicy,
  type WebSocketFactory,
} from '../network/live-generation-socket';

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
 * How long incoming partials are gathered before one goes into the store.
 *
 * Every new score object costs the renderer a full relayout and a flush of
 * its glyph cache, and a job can emit several partials in one burst (a
 * copied chorus lands in a few milliseconds). Four merges a second is what
 * the renderer tolerates and more than a reader can follow; a slow merge
 * stretches the window further, up to a second.
 */
export const LIVE_COALESCE_MS = 250;
const LIVE_COALESCE_MAX_MS = 1000;

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

export type LiveScoreMeta = {
  projectId: string;
  /** The snapshot resets history; a partial keeps it. */
  reason: 'snapshot' | 'partial';
  serverUpdatedAt?: string;
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
    /**
     * Puts a live score into the store without dirtying it, touching the
     * transport, or marking it as this client's edit. Returns false when it
     * cannot right now — the caller retries a moment later. Absent, and the
     * hook never opens a socket.
     */
    applyLiveScore?(score: Score, meta: LiveScoreMeta): boolean;
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

/** Where the live stream stands, for a status strip. */
export type LiveStatus = 'off' | 'connecting' | 'live' | 'reconnecting' | 'fallback';

export type LiveGenerationFinal = {
  score: Score;
  /** The server's stamp for `score`, exactly as `GET /projects/:id` would report it. */
  updatedAt: string;
  /** The job that produced it; null for a transcription, which has none. */
  job: GenerationJob | null;
  lastGeneration?: GenerationRecord;
  /** Every range the stream wrote, for highlighting what is new. */
  touched: readonly ScoreRange[];
};

export type LiveGenerationOptions = {
  /** The API's base URL; the socket URL is derived from it. */
  baseUrl: string;
  createSocket?: WebSocketFactory;
  coalesceMs?: number;
  reconnect?: Partial<ReconnectPolicy>;
};

export type ProjectGeneration = {
  /**
   * The project's status — the one source of truth for "can this be edited,
   * played, and is there a stream to watch". `ready`, or busy with a
   * generation or a transcription.
   */
  status: ProjectStatus;
  /** `status !== 'ready'`: from the moment a job is submitted until the project is ready again. */
  generating: boolean;
  jobId: string | null;
  /** A failed job's message, cleared when the next one starts. */
  error: string | null;
  /** The stream's last progress note, while one is open. */
  progress: LiveGenerationProgress | null;
  live: LiveStatus;
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
   * Adopts the final score a live stream delivered. Awaited before unlocking.
   * Without it the live stream still shows the notes arriving, and the end is
   * handled by `onApplied` through the poll, one full download later.
   */
  onComplete?: (final: LiveGenerationFinal) => void | Promise<void>;
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
  /** The live stream. `false` or absent: poll only. */
  live?: LiveGenerationOptions | false;
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
    onComplete,
    onStartError,
    signInRequiredMessage = 'You must be signed in.',
    pollMs = GENERATION_POLL_MS,
    idlePollMs = GENERATION_IDLE_POLL_MS,
    live = false,
  } = options;

  const [jobId, setJobId] = useState<string | null>(null);
  /*
    The project's status, as the server last said it. Written by the poll,
    by `start` (a created job means `generating` — the server flipped it in
    the same transaction), by `cancel`, and by the stream's end. Everything
    else here derives from it: the lock, the socket, the poll's cadence.
  */
  const [status, setStatus] = useState<ProjectStatus>('ready');
  const generating = status !== 'ready';
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<LiveGenerationProgress | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('off');

  // Read inside the interval callback, never as a dep: re-creating the timer on
  // every render would reset the poll clock continuously.
  const onAppliedRef = useRef(onApplied);
  onAppliedRef.current = onApplied;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  /** Which cadence the next tick should use. A ref because the timer reads it. */
  const generatingRef = useRef(generating);
  generatingRef.current = generating;
  /** Whether the socket is delivering, in which case the poll does not run. */
  const liveHealthyRef = useRef(false);
  /** Set while `complete` is being adopted, so a poll landing then does not reload over it. */
  const completingRef = useRef(false);
  /**
   * The server stamp of the last score adopted from a live `complete`. A poll
   * that reports it afterwards is describing a copy this client already holds,
   * whatever the store's own record says — a store that tracks no stamp, or
   * an `onComplete` that has not written one yet, must not turn that poll
   * into a full re-download of the score the stream just delivered.
   */
  const adoptedAtRef = useRef<string | null>(null);
  /**
   * The poll's controls, for the live effect. `pause` stops the timer while
   * the socket carries the news; `resume` checks now and starts it again.
   */
  const pollRef = useRef<{ pause(): void; resume(): void } | null>(null);

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
        setStatus('generating');
        // Written straight through as well, so the next tick is scheduled at
        // the running-job cadence rather than one idle interval late.
        generatingRef.current = true;
      } catch (err) {
        setStatus('ready');
        generatingRef.current = false;
        if (onStartError?.(err)) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [projectId, flush, client, getToken, onStartError, signInRequiredMessage]
  );

  const socketRef = useRef<LiveGenerationSocket | null>(null);

  const cancel = useCallback(async (): Promise<void> => {
    const id = jobId;
    // Optimistic: the server releases the project synchronously, and the editor
    // should unlock now rather than after a round trip.
    setStatus('ready');
    generatingRef.current = false;
    setJobId(null);
    socketRef.current?.close();
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
        const status = await client.getProjectStatus(projectId, token);
        const { updatedAt } = status;
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

        // `transcribing` means exactly what `generating` does here — see
        // `ProjectStatus`'s own comment: both mean "a job is producing this
        // project's music, and writes must be refused until it lands," kept
        // distinct only so the *caller* could say which one it is. This hook
        // does not currently make that distinction, but it must still treat
        // both as busy — an editor opened straight onto a fresh transcription
        // (the normal flow: `POST /projects/transcribe` returns immediately,
        // before the job has produced anything) previously saw `generating`
        // go `false` on the very first poll, hid the overlay, and showed the
        // still-empty score as though the transcription had finished blank.
        if (status.status === 'generating' || status.status === 'transcribing') {
          setStatus(status.status);
          generatingRef.current = true;
          return;
        }

        // A live `complete` is being adopted this very moment: the stamp it
        // carries is newer than anything known, and reloading over it would
        // download what the client already holds.
        if (completingRef.current) return;
        const adopted = adoptedAtRef.current;
        const alreadyHeld = adopted !== null && updatedAt <= adopted;

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
          !alreadyHeld &&
          state.saveState !== 'saving' &&
          known !== null &&
          known !== undefined &&
          updatedAt > known
        ) {
          await onAppliedRef.current?.();
        }
        if (stopped) return;
        setStatus('ready');
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
      half a minute while nothing does — and nothing at all while the socket is
      carrying the news itself. A tick that finds the socket open does not
      reschedule; the live effect pauses the timer when the socket opens and
      resumes it the moment the socket stops delivering.
    */
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    const pause = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const tick = async (): Promise<void> => {
      // A resume landing on a check already in the air asks nothing more:
      // that check is recent enough, and it reschedules when it lands.
      if (inFlight) return;
      inFlight = true;
      try {
        await check();
      } finally {
        inFlight = false;
      }
      if (stopped || liveHealthyRef.current) return;
      pause();
      timer = setTimeout(() => void tick(), generatingRef.current ? pollMs : idlePollMs);
    };
    const controls = {
      pause,
      resume: () => {
        pause();
        void tick();
      },
    };
    pollRef.current = controls;

    const unsubscribe = foreground.subscribe(() => void check());

    void tick();
    return () => {
      stopped = true;
      if (pollRef.current === controls) pollRef.current = null;
      pause();
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

  /*
    The live stream, for as long as the project is busy.

    Opened the moment the status reads anything but `ready` — a generation
    this hook started, one started elsewhere that the poll noticed, or a
    transcription — and closed by the cleanup when the project is ready
    again, when it changes, or on unmount. The stream is the project's, so
    no job id is needed to find it. Everything it learns is folded through
    music_types' reducer — the same fold the server's own tests use — and
    the store sees the result at most a few times a second.
  */
  const liveBaseUrl = live ? live.baseUrl : null;
  const liveCreateSocket = live ? live.createSocket : undefined;
  const liveCoalesceMs = live ? (live.coalesceMs ?? LIVE_COALESCE_MS) : LIVE_COALESCE_MS;
  const liveReconnect = live ? live.reconnect : undefined;
  useEffect(() => {
    if (!projectId || !liveBaseUrl || !generating) {
      liveHealthyRef.current = false;
      setLiveStatus('off');
      return;
    }
    if (typeof store.getState().applyLiveScore !== 'function') {
      setLiveStatus('off');
      return;
    }
    const createSocket = liveCreateSocket ?? defaultWebSocketFactory();
    if (!createSocket) {
      setLiveStatus('fallback');
      return;
    }

    let stopped = false;
    let state: LiveGenerationState = INITIAL_LIVE_GENERATION_STATE;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let nextDelay = liveCoalesceMs;

    const flush = () => {
      flushTimer = null;
      if (stopped || !state.score) return;
      const started = Date.now();
      // Read at flush time rather than captured: a store that swaps its
      // methods (a reset between projects) is asked, not a stale closure.
      const applied =
        store.getState().applyLiveScore?.(state.score, {
          projectId,
          reason: state.lastSeq >= 0 && state.touched.length === 0 ? 'snapshot' : 'partial',
          ...(state.updatedAt ? { serverUpdatedAt: state.updatedAt } : {}),
        }) ?? false;
      if (!applied) {
        // The store could not take it right now; ask again shortly.
        flushTimer = setTimeout(flush, liveCoalesceMs);
        return;
      }
      const took = Date.now() - started;
      // A slow merge — a big score on a slow device — widens the window, so
      // the renderer is never asked for more than it can give.
      nextDelay = Math.min(LIVE_COALESCE_MAX_MS, Math.max(liveCoalesceMs, took * 4));
    };
    const scheduleFlush = () => {
      if (flushTimer === null) flushTimer = setTimeout(flush, nextDelay);
    };

    const finish = async (final: LiveGenerationState) => {
      if (stopped) return;
      completingRef.current = true;
      // Told to the poll BEFORE anything is awaited: the stamp is the final
      // one, so a poll landing mid-adoption has nothing newer to reload.
      if (final.updatedAt) {
        lastUpdatedAtRef.current = final.updatedAt;
        adoptedAtRef.current = final.updatedAt;
      }
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      try {
        if (final.score && final.updatedAt && onCompleteRef.current) {
          await onCompleteRef.current({
            score: final.score,
            updatedAt: final.updatedAt,
            job: final.job,
            ...(final.lastGeneration ? { lastGeneration: final.lastGeneration } : {}),
            touched: final.touched,
          });
        } else {
          await onAppliedRef.current?.();
        }
      } finally {
        completingRef.current = false;
      }
      if (stopped) return;
      setProgress(null);
      setStatus('ready');
      generatingRef.current = false;
      liveHealthyRef.current = false;
      setJobId(null);
      // Ready: the socket closes (the effect's cleanup), the state is fetched
      // once more — status, stamp, any error — so what this hook reports is
      // the server's word, not the stream's last one, and the idle poll is
      // back on its clock.
      pollRef.current?.resume();
    };

    /**
     * Whether a terminal message arrived. The close that follows one is not
     * news — the message's own path has already resumed the poll — where a
     * close with no message before it (a 4xxx code, the server saying no)
     * is the only word this hook will get, and must resume it.
     */
    let terminalSeen = false;

    const onMessage = (message: LiveGenerationMessage) => {
      if (stopped) return;
      const next = applyLiveGenerationMessage(state, message);
      if (next === state) return;
      state = next;
      switch (message.type) {
        case 'snapshot':
          // Shown at once: this is the first thing the reader sees.
          if (flushTimer !== null) clearTimeout(flushTimer);
          flush();
          return;
        case 'fragment':
          scheduleFlush();
          return;
        case 'progress':
          setProgress(next.progress);
          return;
        case 'complete':
          terminalSeen = true;
          void finish(next);
          return;
        case 'failed':
        case 'cancelled': {
          terminalSeen = true;
          // Not adopted here: the poll's own path unlocks, reloads if the
          // server's copy moved, and reports the failure through the toast.
          if (flushTimer !== null) clearTimeout(flushTimer);
          flushTimer = null;
          if (message.type === 'failed') setError(next.failure ?? 'Generation failed.');
          liveHealthyRef.current = false;
          pollRef.current?.resume();
          return;
        }
        default:
          return;
      }
    };

    setLiveStatus('connecting');
    const socket = openLiveGeneration({
      baseUrl: liveBaseUrl,
      projectId,
      getToken,
      onMessage,
      canConnect: () => foreground.isForeground(),
      createSocket,
      ...(liveReconnect ? { reconnect: liveReconnect } : {}),
      onStatus: (status, detail) => {
        if (stopped) return;
        switch (status) {
          case 'open':
            // The stream carries the news from here: no status requests
            // until it stops.
            liveHealthyRef.current = true;
            pollRef.current?.pause();
            setLiveStatus('live');
            return;
          case 'connecting':
            return;
          case 'reconnecting':
          case 'parked':
            // Not delivering: the poll takes over at its running cadence,
            // starting now, until the socket is back.
            liveHealthyRef.current = false;
            setLiveStatus('reconnecting');
            pollRef.current?.resume();
            return;
          case 'closed':
            liveHealthyRef.current = false;
            if (detail?.reason === 'terminal' || detail?.reason === 'closed') {
              setLiveStatus('off');
            } else {
              // Gave up, no socket here, or no token: the poll is all there is.
              setLiveStatus('fallback');
            }
            // Whatever ended it, the poll is the watcher again — unless a
            // terminal message already put it back, in which case a second
            // resume would only be a second status request.
            if (!terminalSeen) pollRef.current?.resume();
            return;
        }
      },
    });
    socketRef.current = socket;
    // Back in front: a parked socket reconnects, and an open one — which may
    // be half-open after the background — is asked to prove it, so a dead
    // connection is found in seconds rather than after the idle timeout.
    const unsubscribe = foreground.subscribe(() => {
      socket.retryNow();
      socket.ping();
    });

    return () => {
      stopped = true;
      unsubscribe();
      if (flushTimer !== null) clearTimeout(flushTimer);
      if (socketRef.current === socket) socketRef.current = null;
      socket.close();
      liveHealthyRef.current = false;
    };
  }, [
    projectId,
    generating,
    liveBaseUrl,
    liveCreateSocket,
    liveCoalesceMs,
    liveReconnect,
    store,
    getToken,
    foreground,
  ]);

  return { status, generating, jobId, error, progress, live: liveStatus, start, cancel };
}
