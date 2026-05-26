// EventSource cannot set Authorization headers, so we authenticate SSE by
// exchanging the session for a short-lived single-use nonce via
// POST /api/v1/auth/sse-nonce, then connect with `?nonce=<value>`. The
// nonce is consumed atomically server-side (GETDEL on Redis), so even a
// leaked URL is worthless after the SSE connection is established.
//
// Browser auto-reconnect can't reuse a single-use nonce, so this helper
// owns its own reconnect loop — on error it closes, waits with exponential
// backoff, fetches a fresh nonce, and reopens.
import { api } from './api';

export type SseHandlers = {
  onHello?: (data: unknown) => void;
  onTick?: () => void;
  onEvent?: (name: string, data: unknown) => void;
};

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const MAX_BACKOFF_MS = 30_000;

/**
 * Open an authenticated EventSource at the given API path.
 * Returns a disposer; call it on unmount to close the stream.
 */
export function connectSse(path: string, handlers: SseHandlers): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let backoff = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReopen = () => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void open();
    }, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  };

  const open = async () => {
    if (closed) return;
    try {
      const { nonce } = await api.post<{ nonce: string }>('/api/v1/auth/sse-nonce');
      if (closed) return;
      const url = `${API_BASE}${path}?nonce=${encodeURIComponent(nonce)}`;
      const source = new EventSource(url, { withCredentials: true });
      es = source;
      source.addEventListener('open', () => {
        // Reset backoff once the server accepts the nonce + holds the stream open.
        backoff = 1000;
      });
      if (handlers.onTick) source.addEventListener('tick', () => handlers.onTick!());
      if (handlers.onHello) {
        source.addEventListener('hello', (ev) => {
          try {
            handlers.onHello!(JSON.parse((ev as MessageEvent).data));
          } catch {
            // ignore — server sent malformed JSON
          }
        });
      }
      if (handlers.onEvent) {
        source.addEventListener('message', (ev) => {
          try {
            handlers.onEvent!('message', JSON.parse((ev as MessageEvent).data));
          } catch {
            handlers.onEvent!('message', (ev as MessageEvent).data);
          }
        });
      }
      source.onerror = () => {
        try {
          source.close();
        } catch {
          // noop
        }
        if (es === source) es = null;
        scheduleReopen();
      };
    } catch {
      // Could not get a nonce (network blip, 401 because session truly expired,
      // rate limit). Back off and try again — the session manager will refresh
      // tokens on its own; once that lands, the next attempt will succeed.
      scheduleReopen();
    }
  };

  void open();

  return () => {
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    try {
      es?.close();
    } catch {
      // noop
    }
    es = null;
  };
}
