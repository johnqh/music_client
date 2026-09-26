/**
 * The live-generation socket: connect, hand over the token, deliver parsed
 * messages, and stay connected for as long as the job is running.
 *
 * Only the `WebSocket` global, `setTimeout` and `JSON` — which is what lets
 * one file serve the browser and React Native (which has the same global)
 * and pass this package's portability guards. A factory is injected for
 * tests; nothing here touches `window` or `document`.
 *
 * ## What it promises the hook above it
 *
 * - `getToken()` is called fresh on every connection attempt, never cached:
 *   a token can expire during a long job, and the retry must carry a new one.
 * - The first frame after `open` is `{ type: "auth", token }`; the server
 *   sends nothing until it has seen it.
 * - Every frame is validated with the shared schema; one that does not
 *   parse is logged and dropped, never fatal.
 * - A terminal message, or a close code in the 4xxx range (the server said
 *   no), ends the stream for good. Anything else — a dropped connection, a
 *   1001 from a server going away — is retried with exponential backoff,
 *   because the server's snapshot makes a reconnect a full resync.
 * - `error{unauthorized}` earns exactly one reconnect with a fresh token.
 * - While the host says nobody is looking (`canConnect` false) the socket
 *   parks instead of retrying; `retryNow()` resumes it.
 * - Every server `heartbeat` is answered with a `pong`, so the server can
 *   tell a client that is there from one whose tab was killed without a
 *   close frame; it closes 1001 after `LIVE_GENERATION_IDLE_TIMEOUT_MS` of
 *   silence, and that code is retried like any other drop.
 * - A watchdog reconnects a socket that has gone quiet longer than the
 *   server's heartbeat allows — a half-open connection after a phone came
 *   back from the background looks exactly like silence. `ping()` shortens
 *   that wait to `pingTimeoutMs` for a connection the host has reason to
 *   doubt: it sends a `ping`, and a server that is there answers at once.
 */
import {
  LIVE_GENERATION_IDLE_TIMEOUT_MS,
  isTerminalLiveGenerationMessage,
  parseLiveGenerationMessage,
  type LiveGenerationMessage,
} from '@sudobility/music_types';

/** The subset of `WebSocket` this uses, so a test can hand in a fake. */
export type LiveSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type WebSocketFactory = (url: string) => LiveSocketLike;

/** The platform's own `WebSocket`, or null where there is none. */
export function defaultWebSocketFactory(): WebSocketFactory | null {
  if (typeof WebSocket === 'undefined') return null;
  return (url) => new WebSocket(url) as unknown as LiveSocketLike;
}

/** `http(s)://host` → `ws(s)://host/api/v1/projects/:id/live`. */
export function liveGenerationUrl(baseUrl: string, projectId: string): string {
  const base = baseUrl.replace(/\/$/, '').replace(/^http/, 'ws');
  return `${base}/api/v1/projects/${encodeURIComponent(projectId)}/live`;
}

export type LiveSocketStatus =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'parked'
  | 'closed';

export type LiveSocketCloseReason =
  | 'terminal'
  | 'gave-up'
  | 'closed'
  | 'unsupported'
  | 'no-token';

export type ReconnectPolicy = {
  initialMs: number;
  maxMs: number;
  maxAttempts: number;
  /** Silence longer than this is treated as a dead connection. */
  idleTimeoutMs: number;
  /** After `ping()`, how long the server has to answer before the connection is dropped. */
  pingTimeoutMs: number;
};

export const LIVE_RECONNECT_DEFAULTS: ReconnectPolicy = {
  initialMs: 1000,
  maxMs: 15_000,
  maxAttempts: 8,
  idleTimeoutMs: LIVE_GENERATION_IDLE_TIMEOUT_MS,
  pingTimeoutMs: 5_000,
};

export type OpenLiveGenerationOptions = {
  baseUrl: string;
  projectId: string;
  getToken: () => Promise<string | null>;
  onMessage: (message: LiveGenerationMessage) => void;
  onStatus?: (status: LiveSocketStatus, detail?: { reason: LiveSocketCloseReason }) => void;
  /** Whether a (re)connection may be made now — the foreground gate. */
  canConnect?: () => boolean;
  createSocket?: WebSocketFactory;
  reconnect?: Partial<ReconnectPolicy>;
  /** Injectable for tests; defaults to `Math.random`. */
  jitter?: () => number;
};

export type LiveGenerationSocket = {
  readonly status: LiveSocketStatus;
  /** Reconnects a parked socket now, and pulls a scheduled retry forward. */
  retryNow(): void;
  /**
   * Asks an open connection whether it is still one. Sends a `ping`; if
   * nothing comes back within `pingTimeoutMs` the socket is dropped and
   * reconnected. Does nothing unless the socket is open.
   */
  ping(): void;
  /** Ends the stream; no reconnect follows. */
  close(): void;
};

/** A server refusal, which is never retried. */
const APPLICATION_CLOSE_FLOOR = 4000;

export function openLiveGeneration(
  options: OpenLiveGenerationOptions
): LiveGenerationSocket {
  const policy: ReconnectPolicy = { ...LIVE_RECONNECT_DEFAULTS, ...options.reconnect };
  const createSocket = options.createSocket ?? defaultWebSocketFactory();
  const jitter = options.jitter ?? Math.random;
  const url = liveGenerationUrl(options.baseUrl, options.projectId);

  let status: LiveSocketStatus = 'connecting';
  let socket: LiveSocketLike | null = null;
  let attempt = 0;
  let reauthed = false;
  let finished = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The generation of the current connection; a stale socket's events are ignored. */
  let generation = 0;

  const setStatus = (next: LiveSocketStatus, detail?: { reason: LiveSocketCloseReason }) => {
    status = next;
    options.onStatus?.(next, detail);
  };

  const clearTimers = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const armIdle = (ms = policy.idleTimeoutMs) => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Quiet for longer than the server's heartbeat allows: assume the
      // connection is dead under us and start again.
      idleTimer = null;
      dropAndReconnect();
    }, ms);
  };

  /** A frame to the server; a socket that throws is one the close will report. */
  const say = (ws: LiveSocketLike, frame: { type: 'ping' } | { type: 'pong' }) => {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // The close that follows decides what happens.
    }
  };

  const end = (reason: LiveSocketCloseReason) => {
    if (finished) return;
    finished = true;
    clearTimers();
    const current = socket;
    socket = null;
    generation += 1;
    try {
      current?.close(1000, reason);
    } catch {
      // Already gone.
    }
    setStatus('closed', { reason });
  };

  const scheduleRetry = () => {
    if (finished) return;
    if (options.canConnect && !options.canConnect()) {
      setStatus('parked');
      return;
    }
    if (attempt >= policy.maxAttempts) {
      end('gave-up');
      return;
    }
    const delay =
      Math.min(policy.maxMs, policy.initialMs * 2 ** attempt) + Math.floor(jitter() * 250);
    attempt += 1;
    setStatus('reconnecting');
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };

  const dropAndReconnect = () => {
    if (finished) return;
    const current = socket;
    socket = null;
    generation += 1;
    try {
      current?.close(1000, 'reconnect');
    } catch {
      // Already gone.
    }
    scheduleRetry();
  };

  const connect = async (): Promise<void> => {
    if (finished) return;
    if (!createSocket) {
      end('unsupported');
      return;
    }
    if (options.canConnect && !options.canConnect()) {
      setStatus('parked');
      return;
    }
    const token = await options.getToken();
    if (finished) return;
    if (!token) {
      end('no-token');
      return;
    }
    const mine = ++generation;
    const alive = () => !finished && mine === generation;
    let ws: LiveSocketLike;
    try {
      ws = createSocket(url);
    } catch {
      scheduleRetry();
      return;
    }
    socket = ws;
    setStatus('connecting');

    ws.onopen = () => {
      if (!alive()) return;
      ws.send(JSON.stringify({ type: 'auth', token }));
      setStatus('open');
      armIdle();
    };
    ws.onmessage = (event) => {
      if (!alive()) return;
      armIdle();
      let message: LiveGenerationMessage;
      try {
        message = parseLiveGenerationMessage(
          JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
        );
      } catch (error) {
        console.warn('[live] dropped an unreadable frame', error);
        return;
      }
      // A healthy connection: the next drop starts the backoff from scratch.
      attempt = 0;
      // The server's heartbeat is its ping; this is the pong it is counting.
      if (message.type === 'heartbeat') say(ws, { type: 'pong' });
      if (message.type === 'error' && message.code === 'unauthorized' && !reauthed) {
        // Once, with a fresh token; the server closes 4401 right after this,
        // which must not be read as a refusal to retry.
        reauthed = true;
        options.onMessage(message);
        generation += 1;
        socket = null;
        try {
          ws.close(1000, 'reauth');
        } catch {
          // Already gone.
        }
        void connect();
        return;
      }
      if (isTerminalLiveGenerationMessage(message)) {
        // The stream is over: hand the message on, then close from this side
        // too — the server closes right after it, but a client that waited
        // for that would keep a finished socket open across a slow network.
        finished = true;
        clearTimers();
        options.onMessage(message);
        socket = null;
        generation += 1;
        try {
          ws.close(1000, 'terminal');
        } catch {
          // Already gone.
        }
        setStatus('closed', { reason: 'terminal' });
        return;
      }
      options.onMessage(message);
    };
    ws.onerror = () => {
      // The close that follows decides what happens; nothing to do here.
    };
    ws.onclose = (event) => {
      if (!alive()) return;
      socket = null;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = null;
      if (finished) return;
      if (event.code >= APPLICATION_CLOSE_FLOOR) {
        end('terminal');
        return;
      }
      scheduleRetry();
    };
  };

  void connect();

  return {
    get status() {
      return status;
    },
    retryNow() {
      if (finished) return;
      if (status === 'parked' || status === 'reconnecting') {
        if (retryTimer !== null) clearTimeout(retryTimer);
        retryTimer = null;
        void connect();
      }
    },
    ping() {
      if (finished || status !== 'open' || !socket) return;
      say(socket, { type: 'ping' });
      // Any frame re-arms the full window; only silence trips this one.
      armIdle(policy.pingTimeoutMs);
    },
    close() {
      end('closed');
    },
  };
}
