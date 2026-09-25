/**
 * A WebSocket that a test drives from the server's side.
 *
 * Nothing opens or arrives on its own: the test calls `open()`,
 * `serverSend()` and `serverClose()`, and reads what the client sent from
 * `sent`. `fakeWebSockets()` gives a factory that records every instance,
 * so a reconnect is visible as a second socket.
 */
import type { LiveSocketLike, WebSocketFactory } from '../network/live-generation-socket';

export class FakeWebSocket implements LiveSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  /** The code the client closed with, if it did. */
  clientClose: { code?: number; reason?: string } | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.clientClose = { code, reason };
  }

  // -- the server's side --

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  serverSend(message: unknown): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  serverClose(code = 1006, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  /** The frames the client sent, parsed. */
  get frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s) as unknown);
  }
}

export function fakeWebSockets(): { factory: WebSocketFactory; sockets: FakeWebSocket[] } {
  const sockets: FakeWebSocket[] = [];
  return {
    sockets,
    factory: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
  };
}
