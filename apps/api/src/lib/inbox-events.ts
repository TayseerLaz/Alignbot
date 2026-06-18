// In-process pub/sub for the inbox SSE stream.
//
// The inbox SSE used to tick every 2s, so new messages took up to 2s to show.
// Instead we publish an event the instant a message is written (inbound from a
// webhook, a bot reply, or an operator reply) and the SSE handler pushes it to
// connected clients immediately — sub-100ms perceived. A slow heartbeat in the
// SSE handler still covers keep-alive + anything that didn't publish.
//
// Scope note: this is in-process. The API runs as a single process (systemd
// `aligned-api`), so every SSE client shares this emitter. If the API is ever
// scaled to multiple replicas, swap this for Redis pub/sub.
import { EventEmitter } from 'node:events';

const emitter = new EventEmitter();
// Many concurrent SSE connections subscribe; lift the default 10-listener cap.
emitter.setMaxListeners(0);

function channel(orgId: string): string {
  return `inbox:${orgId}`;
}

/** Notify all inbox SSE clients for an org that something changed. */
export function publishInboxEvent(orgId: string): void {
  try {
    emitter.emit(channel(orgId));
  } catch {
    /* never let a notify failure break the write path */
  }
}

/** Subscribe an SSE handler to an org's inbox events. Returns an unsubscribe fn. */
export function subscribeInboxEvents(orgId: string, cb: () => void): () => void {
  const ch = channel(orgId);
  emitter.on(ch, cb);
  return () => emitter.off(ch, cb);
}
