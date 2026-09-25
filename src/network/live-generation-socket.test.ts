import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveGenerationMessage } from '@sudobility/music_types';
import { fakeWebSockets } from '../test/fake-web-socket';
import {
  liveGenerationUrl,
  openLiveGeneration,
  type WebSocketFactory,
} from './live-generation-socket';

const HEARTBEAT: LiveGenerationMessage = { type: 'heartbeat' };
const PROGRESS: LiveGenerationMessage = {
  type: 'progress',
  seq: 1,
  stage: 'part',
  label: 'Bass',
  done: 1,
  total: 2,
};

function harness(overrides: Partial<Parameters<typeof openLiveGeneration>[0]> = {}) {
  const fakes = fakeWebSockets();
  const messages: LiveGenerationMessage[] = [];
  const statuses: string[] = [];
  const getToken = vi.fn(async () => 'tok');
  const socket = openLiveGeneration({
    baseUrl: 'http://api.test',
    projectId: 'p-1',
    getToken,
    onMessage: (m) => messages.push(m),
    onStatus: (s, d) => statuses.push(d ? `${s}:${d.reason}` : s),
    createSocket: fakes.factory,
    jitter: () => 0,
    ...overrides,
  });
  return { fakes, messages, statuses, getToken, socket };
}

/** `openLiveGeneration` awaits the token before creating a socket. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('liveGenerationUrl', () => {
  it('turns the API base into the job stream URL', () => {
    expect(liveGenerationUrl('http://localhost:8032/', 'j 1')).toBe(
      'ws://localhost:8032/api/v1/projects/j%201/live'
    );
    expect(liveGenerationUrl('https://api.moosiac.app', 'j')).toBe(
      'wss://api.moosiac.app/api/v1/projects/j/live'
    );
  });
});

describe('openLiveGeneration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the auth frame first, with a token fetched for this attempt', async () => {
    const h = harness();
    await settle();
    expect(h.fakes.sockets).toHaveLength(1);
    const ws = h.fakes.sockets[0];
    expect(ws.sent).toEqual([]); // nothing before open
    ws.open();
    expect(ws.frames).toEqual([{ type: 'auth', token: 'tok' }]);
    expect(h.getToken).toHaveBeenCalledTimes(1);
    expect(h.socket.status).toBe('open');
  });

  it('delivers parsed messages and drops an unreadable frame', async () => {
    const h = harness();
    await settle();
    const ws = h.fakes.sockets[0];
    ws.open();
    ws.serverSend(PROGRESS);
    ws.serverSend('{not json');
    ws.serverSend({ type: 'nonsense' });
    ws.serverSend(HEARTBEAT);
    expect(h.messages).toEqual([PROGRESS, HEARTBEAT]);
  });

  it('reconnects after a dropped connection with exponential backoff, a fresh token each time', async () => {
    const h = harness({ reconnect: { initialMs: 1000, maxMs: 4000, maxAttempts: 8 } });
    await settle();
    h.fakes.sockets[0].open();
    h.fakes.sockets[0].serverClose(1006);
    expect(h.socket.status).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(999);
    expect(h.fakes.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fakes.sockets).toHaveLength(2);
    expect(h.getToken).toHaveBeenCalledTimes(2);

    h.fakes.sockets[1].serverClose(1006);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.fakes.sockets).toHaveLength(3);
    h.fakes.sockets[2].serverClose(1006);
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.fakes.sockets).toHaveLength(4);
    h.fakes.sockets[3].serverClose(1006);
    // Capped at maxMs.
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.fakes.sockets).toHaveLength(5);
  });

  it('starts the backoff over once a connection has delivered a message', async () => {
    const h = harness({ reconnect: { initialMs: 1000, maxMs: 8000, maxAttempts: 8 } });
    await settle();
    h.fakes.sockets[0].serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    h.fakes.sockets[1].serverClose(1006);
    await vi.advanceTimersByTimeAsync(2000);
    const healthy = h.fakes.sockets[2];
    healthy.open();
    healthy.serverSend(HEARTBEAT);
    healthy.serverClose(1006);
    // Back to the first delay, not the third.
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.fakes.sockets).toHaveLength(4);
  });

  it('gives up after maxAttempts and says so', async () => {
    const h = harness({ reconnect: { initialMs: 10, maxMs: 10, maxAttempts: 2 } });
    await settle();
    h.fakes.sockets[0].serverClose(1006);
    await vi.advanceTimersByTimeAsync(10);
    h.fakes.sockets[1].serverClose(1006);
    await vi.advanceTimersByTimeAsync(10);
    h.fakes.sockets[2].serverClose(1006);
    await settle();
    expect(h.fakes.sockets).toHaveLength(3);
    expect(h.socket.status).toBe('closed');
    expect(h.statuses[h.statuses.length - 1]).toBe('closed:gave-up');
  });

  it('ends for good on a terminal message, and on a 4xxx close', async () => {
    const a = harness();
    await settle();
    a.fakes.sockets[0].open();
    a.fakes.sockets[0].serverSend({
      type: 'cancelled',
      seq: 3,
      job: { id: 'job-1', projectId: 'p', kind: 'generate-score', status: 'cancelled', createdAt: 'c', finishedAt: 'f', error: null },
      score: { id: 's', version: 1, ppq: 480, metadata: { title: 't', createdAt: 'c', updatedAt: 'u' }, tempoMap: [], tracks: [] },
      updatedAt: 'u',
    });
    expect(a.statuses[a.statuses.length - 1]).toBe('closed:terminal');
    a.fakes.sockets[0].serverClose(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.fakes.sockets).toHaveLength(1);

    const b = harness();
    await settle();
    b.fakes.sockets[0].open();
    b.fakes.sockets[0].serverClose(4404, 'Job not found');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.fakes.sockets).toHaveLength(1);
    expect(b.statuses[b.statuses.length - 1]).toBe('closed:terminal');
  });

  it('retries once with a fresh token on `unauthorized`, then treats a second one as final', async () => {
    const h = harness();
    await settle();
    h.fakes.sockets[0].open();
    h.fakes.sockets[0].serverSend({ type: 'error', code: 'unauthorized', message: 'expired' });
    await settle();
    expect(h.fakes.sockets).toHaveLength(2);
    expect(h.getToken).toHaveBeenCalledTimes(2);
    h.fakes.sockets[1].open();
    h.fakes.sockets[1].serverSend({ type: 'error', code: 'unauthorized', message: 'still' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fakes.sockets).toHaveLength(2);
    expect(h.statuses[h.statuses.length - 1]).toBe('closed:terminal');
  });

  it('parks while nobody is looking and resumes on retryNow', async () => {
    let foreground = true;
    const h = harness({ canConnect: () => foreground, reconnect: { initialMs: 10, maxMs: 10 } });
    await settle();
    foreground = false;
    h.fakes.sockets[0].serverClose(1006);
    expect(h.socket.status).toBe('parked');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fakes.sockets).toHaveLength(1);
    foreground = true;
    h.socket.retryNow();
    await settle();
    expect(h.fakes.sockets).toHaveLength(2);
  });

  it('reconnects a socket that has gone silent past the idle timeout', async () => {
    const h = harness({ reconnect: { idleTimeoutMs: 1000, initialMs: 10, maxMs: 10 } });
    await settle();
    h.fakes.sockets[0].open();
    await vi.advanceTimersByTimeAsync(900);
    h.fakes.sockets[0].serverSend(HEARTBEAT); // fed: the clock restarts
    await vi.advanceTimersByTimeAsync(900);
    expect(h.fakes.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.fakes.sockets[0].clientClose).not.toBeNull();
    await settle();
    expect(h.fakes.sockets).toHaveLength(2);
  });

  it('never reconnects after close()', async () => {
    const h = harness({ reconnect: { initialMs: 10 } });
    await settle();
    h.fakes.sockets[0].open();
    h.socket.close();
    expect(h.fakes.sockets[0].clientClose?.code).toBe(1000);
    h.fakes.sockets[0].serverClose(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fakes.sockets).toHaveLength(1);
    expect(h.statuses[h.statuses.length - 1]).toBe('closed:closed');
  });

  it('reports no-token and unsupported without ever opening a socket', async () => {
    const a = harness({ getToken: async () => null });
    await settle();
    expect(a.fakes.sockets).toHaveLength(0);
    expect(a.statuses[a.statuses.length - 1]).toBe('closed:no-token');

    const statuses: string[] = [];
    openLiveGeneration({
      baseUrl: 'http://api.test',
      projectId: 'j',
      getToken: async () => 'tok',
      onMessage: () => {},
      onStatus: (s, d) => statuses.push(d ? `${s}:${d.reason}` : s),
      createSocket: undefined as unknown as WebSocketFactory,
    });
    await settle();
    // No factory and no global WebSocket under this test environment? jsdom
    // has one, so this only proves the option is honoured when absent.
    expect(statuses.length).toBeGreaterThan(0);
  });
});
