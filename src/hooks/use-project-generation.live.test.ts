/**
 * `useProjectGeneration` with a live stream: what reaches the store, when,
 * and how the poll and the socket stay out of each other's way.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createEmptyScore, extractFragment, replaceFragment } from '@sudobility/music_types';
import type {
  GenerationJob,
  LiveGenerationMessage,
  ProjectStatusResult,
  Score,
} from '@sudobility/music_types';
import { fakeWebSockets, type FakeWebSocket } from '../test/fake-web-socket';
import {
  ALWAYS_FOREGROUND,
  useProjectGeneration,
  type GenerationClient,
  type GenerationStore,
  type LiveGenerationFinal,
  type LiveScoreMeta,
} from './use-project-generation.js';

const JOB: GenerationJob = {
  id: 'job-1',
  projectId: 'p1',
  kind: 'generate-score',
  status: 'running',
  createdAt: 'c',
  finishedAt: null,
  error: null,
};

function score(): Score {
  return createEmptyScore({
    title: 'L',
    measures: 4,
    tracks: [{ name: 'Lead', instrumentName: 'Flute', clef: 'treble' }],
  });
}

/** Bar `bar` of the score's one track, with its measure id changed — a visible partial. */
function fragmentAt(base: Score, bar: number) {
  const track = base.tracks[0];
  const m = track.measures[bar];
  const fragment = extractFragment(base, {
    startTick: m.startTick,
    endTick: m.startTick + m.durationTicks,
    trackIds: [track.id],
  });
  return {
    ...fragment,
    tracks: fragment.tracks.map((t) => ({
      ...t,
      measures: t.measures.map((measure) => ({ ...measure, id: `live-${bar}` })),
    })),
  };
}

function client(status: Partial<ProjectStatusResult> & { status: ProjectStatusResult['status'] }) {
  const getProjectStatus = vi.fn().mockResolvedValue({
    updatedAt: 't1',
    lastGenerationError: null,
    parentSnapshotId: null,
    ...status,
  } satisfies ProjectStatusResult);
  return {
    client: {
      createJob: vi.fn(),
      getJob: vi.fn().mockResolvedValue({ ...JOB, status: 'done' }),
      cancelJob: vi.fn(),
      cancelProjectGeneration: vi.fn(),
      getProjectStatus,
    } as unknown as GenerationClient,
    getProjectStatus,
  };
}

function liveStore() {
  const applied: { score: Score; meta: LiveScoreMeta }[] = [];
  let serverUpdatedAt: string | null = 't1';
  const store: GenerationStore = {
    getState: () => ({
      serverUpdatedAt,
      applyLiveScore: (s, meta) => {
        applied.push({ score: s, meta });
        if (meta.serverUpdatedAt) serverUpdatedAt = meta.serverUpdatedAt;
        return true;
      },
    }),
  };
  return { store, applied, setServerUpdatedAt: (v: string) => (serverUpdatedAt = v) };
}

/** Stable across renders: a fresh arrow per render would re-run the effects and reopen the socket. */
const getToken = async () => 'token';

async function opened(fakes: { sockets: FakeWebSocket[] }): Promise<FakeWebSocket> {
  await waitFor(() => expect(fakes.sockets.length).toBeGreaterThan(0));
  const ws = fakes.sockets[fakes.sockets.length - 1];
  act(() => ws.open());
  return ws;
}

describe('useProjectGeneration, live', () => {
  it('opens the project stream as soon as the status poll says busy, and shows the snapshot at once', async () => {
    const fakes = fakeWebSockets();
    const { store, applied } = liveStore();
    const base = score();
    const { client: c } = client({ status: 'generating', jobId: 'job-1' });
    const live = { baseUrl: 'http://api.test', createSocket: fakes.factory };
    const { result } = renderHook(() =>
      useProjectGeneration('p1', { store, client: c, getToken, foreground: ALWAYS_FOREGROUND, live })
    );
    const ws = await opened(fakes);
    expect(ws.url).toBe('ws://api.test/api/v1/projects/p1/live');
    expect(ws.frames[0]).toEqual({ type: 'auth', token: 'token' });

    act(() => ws.serverSend({ type: 'snapshot', seq: 0, status: 'generating', job: JOB, score: base, updatedAt: 't2' }));
    expect(applied).toHaveLength(1);
    expect(applied[0].meta).toEqual({ projectId: 'p1', reason: 'snapshot', serverUpdatedAt: 't2' });
    expect(applied[0].score).toEqual(base);
    await waitFor(() => expect(result.current.live).toBe('live'));
  });

  it('opens the stream for a transcribing project as well, and adopts its result', async () => {
    // Busy is busy: a transcription has no job to name, and the project's
    // stream is found by the project alone.
    const fakes = fakeWebSockets();
    const { store, applied } = liveStore();
    const base = score();
    const onComplete = vi.fn(async (_f: LiveGenerationFinal) => undefined);
    const { client: c, getProjectStatus } = client({ status: 'transcribing' });
    const live = { baseUrl: 'http://api.test', createSocket: fakes.factory };
    const { result } = renderHook(() =>
      useProjectGeneration('p1', { store, client: c, getToken, onComplete, live })
    );
    await waitFor(() => expect(result.current.status).toBe('transcribing'));
    const ws = await opened(fakes);
    expect(ws.url).toBe('ws://api.test/api/v1/projects/p1/live');
    act(() =>
      ws.serverSend({ type: 'snapshot', seq: 0, status: 'transcribing', job: null, score: base, updatedAt: 't2' })
    );
    expect(applied).toHaveLength(1);
    getProjectStatus.mockResolvedValue({
      status: 'ready',
      updatedAt: 't9',
      lastGenerationError: null,
      parentSnapshotId: null,
    });
    act(() => ws.serverSend({ type: 'complete', seq: 1, job: null, score: base, updatedAt: 't9' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0][0].job).toBeNull();
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(ws.clientClose?.code).toBe(1000);
  });

  it('coalesces a burst of fragments into one merged store update', async () => {
    const fakes = fakeWebSockets();
    const { store, applied } = liveStore();
    const base = score();
    const { client: c } = client({ status: 'generating', jobId: 'job-1' });
    const live = { baseUrl: 'http://api.test', createSocket: fakes.factory, coalesceMs: 50 };
    renderHook(() => useProjectGeneration('p1', { store, client: c, getToken, live }));
    const ws = await opened(fakes);
    act(() => ws.serverSend({ type: 'snapshot', seq: 0, status: 'generating', job: JOB, score: base, updatedAt: 't2' }));
    const fragments = [1, 2, 3].map((bar) => fragmentAt(base, bar));
    act(() => {
      fragments.forEach((fragment, i) =>
        ws.serverSend({ type: 'fragment', seq: i + 1, fragment } satisfies LiveGenerationMessage)
      );
    });
    expect(applied).toHaveLength(1); // nothing yet: the window is open
    await waitFor(() => expect(applied).toHaveLength(2));
    expect(applied[1].meta.reason).toBe('partial');
    // One update carrying all three, equal to folding them in order.
    const expected = fragments.reduce(replaceFragment, base);
    expect(applied[1].score).toEqual(expected);
    expect(applied[1].score.tracks[0].measures.map((m) => m.id).slice(1)).toEqual([
      'live-1',
      'live-2',
      'live-3',
    ]);
  });

  it('adopts the final score through onComplete, unlocks, and does not also trigger onApplied', async () => {
    const fakes = fakeWebSockets();
    const { store } = liveStore();
    const base = score();
    const final = replaceFragment(base, fragmentAt(base, 0));
    const onApplied = vi.fn();
    const onComplete = vi.fn(async (_f: LiveGenerationFinal) => undefined);
    const { client: c, getProjectStatus } = client({ status: 'generating', jobId: 'job-1' });
    const live = { baseUrl: 'http://api.test', createSocket: fakes.factory };
    const { result } = renderHook(() =>
      useProjectGeneration('p1', { store, client: c, getToken, onApplied, onComplete, pollMs: 30, live })
    );
    const ws = await opened(fakes);
    act(() => ws.serverSend({ type: 'snapshot', seq: 0, status: 'generating', job: JOB, score: base, updatedAt: 't2' }));
    // The server is ready, with the same stamp the stream is about to
    // deliver: what a poll sees from the moment `complete` is sent.
    getProjectStatus.mockResolvedValue({
      status: 'ready',
      updatedAt: 't9',
      lastGenerationError: null,
      parentSnapshotId: null,
    });
    act(() =>
      ws.serverSend({
        type: 'complete',
        seq: 5,
        job: { ...JOB, status: 'done', finishedAt: 'f' },
        score: final,
        updatedAt: 't9',
      })
    );
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0][0].score).toEqual(final);
    expect(onComplete.mock.calls[0][0].updatedAt).toBe('t9');
    await waitFor(() => expect(result.current.generating).toBe(false));
    expect(ws.clientClose?.code).toBe(1000);

    // The freshness rule sees nothing newer than what was adopted, so the
    // polling fallback does not download the score a second time.
    await new Promise((r) => setTimeout(r, 120));
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('surfaces a failed job and hands back to the poll without touching the score', async () => {
    const fakes = fakeWebSockets();
    const { store, applied } = liveStore();
    const { client: c, getProjectStatus } = client({ status: 'generating', jobId: 'job-1' });
    const live = { baseUrl: 'http://api.test', createSocket: fakes.factory };
    const { result } = renderHook(() => useProjectGeneration('p1', { store, client: c, getToken, live }));
    const ws = await opened(fakes);
    act(() => ws.serverSend({ type: 'snapshot', seq: 0, status: 'generating', job: JOB, score: score(), updatedAt: 't2' }));
    getProjectStatus.mockResolvedValue({
      status: 'ready',
      updatedAt: 't2',
      lastGenerationError: 'model exploded',
      parentSnapshotId: null,
    });
    act(() =>
      ws.serverSend({
        type: 'failed',
        seq: 3,
        job: { ...JOB, status: 'failed', error: 'model exploded' },
        score: score(),
        updatedAt: 't2',
      })
    );
    await waitFor(() => expect(result.current.error).toBe('model exploded'));
    await waitFor(() => expect(result.current.generating).toBe(false));
    expect(applied).toHaveLength(1); // the snapshot only
  });

  it('falls back to polling, immediately, when the socket gives up', async () => {
    const fakes = fakeWebSockets();
    const { store } = liveStore();
    const { client: c, getProjectStatus } = client({ status: 'generating', jobId: 'job-1' });
    const live = {
      baseUrl: 'http://api.test',
      createSocket: fakes.factory,
      reconnect: { initialMs: 1, maxMs: 1, maxAttempts: 0 },
    };
    const { result } = renderHook(() =>
      useProjectGeneration('p1', { store, client: c, getToken, pollMs: 10_000, live })
    );
    const ws = await opened(fakes);
    const pollsBefore = getProjectStatus.mock.calls.length;
    act(() => ws.serverClose(1006));
    await waitFor(() => expect(result.current.live).toBe('fallback'));
    await waitFor(() => expect(getProjectStatus.mock.calls.length).toBeGreaterThan(pollsBefore));
  });

  it('asks for the status not at all while the socket is open, and again the moment it drops', async () => {
    const fakes = fakeWebSockets();
    const { store } = liveStore();
    const { client: c, getProjectStatus } = client({ status: 'generating', jobId: 'job-1' });
    const live = {
      baseUrl: 'http://api.test',
      createSocket: fakes.factory,
      reconnect: { initialMs: 1, maxMs: 1, maxAttempts: 8 },
    };
    const { result } = renderHook(() =>
      useProjectGeneration('p1', { store, client: c, getToken, pollMs: 10, live })
    );
    const ws = await opened(fakes);
    await waitFor(() => expect(result.current.live).toBe('live'));
    // A check already in the air when the socket opened may still land.
    await new Promise((r) => setTimeout(r, 30));
    const whileLive = getProjectStatus.mock.calls.length;
    // Ten running-cadence intervals: the stream carries the news, so nothing is asked.
    await new Promise((r) => setTimeout(r, 100));
    expect(getProjectStatus.mock.calls.length).toBe(whileLive);

    // Dropped, not ended: the socket reconnects, and the poll watches meanwhile.
    act(() => ws.serverClose(1006));
    await waitFor(() => expect(result.current.live).toBe('reconnecting'));
    await waitFor(() => expect(getProjectStatus.mock.calls.length).toBeGreaterThan(whileLive));
  });

  it('resumes polling when the server ends the stream with no terminal message', async () => {
    // A 4xxx close is the server saying no, with nothing to fold: the poll is
    // the only watcher left, and a paused one would lock the editor forever.
    const fakes = fakeWebSockets();
    const { store } = liveStore();
    const { client: c, getProjectStatus } = client({ status: 'generating', jobId: 'job-1' });
    const live = { baseUrl: 'http://api.test', createSocket: fakes.factory };
    const { result } = renderHook(() =>
      useProjectGeneration('p1', { store, client: c, getToken, pollMs: 10, live })
    );
    const ws = await opened(fakes);
    await waitFor(() => expect(result.current.live).toBe('live'));
    await new Promise((r) => setTimeout(r, 30));
    const whileLive = getProjectStatus.mock.calls.length;
    act(() => ws.serverClose(4001));
    await waitFor(() => expect(result.current.live).toBe('off'));
    await waitFor(() => expect(getProjectStatus.mock.calls.length).toBeGreaterThan(whileLive));
  });

  it('opens nothing when the store cannot take a live score, or live is off', async () => {
    const fakes = fakeWebSockets();
    const plain: GenerationStore = { getState: () => ({}) };
    const { client: c } = client({ status: 'generating', jobId: 'job-1' });
    const live = { baseUrl: 'http://api.test', createSocket: fakes.factory };
    const { result } = renderHook(() => useProjectGeneration('p1', { store: plain, client: c, getToken, live }));
    await waitFor(() => expect(result.current.generating).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(fakes.sockets).toHaveLength(0);
    expect(result.current.live).toBe('off');
  });
});
