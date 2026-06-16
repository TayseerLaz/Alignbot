// Send a text message via the Meta Page Send API (Messenger + Instagram).
// Shared by the bot reply path and the inbox operator-reply path so both use
// the same transport. Loads the per-org MessengerChannel, decrypts the page
// token, and POSTs. Returns the message id, or null on any failure (callers
// log + degrade — a send hiccup never throws into the hot path).
import { decryptSecret } from '@aligned/db';

import { withRlsBypass } from './db.js';

const GRAPH = 'https://graph.facebook.com/v20.0';

type Logger = { warn: (...a: unknown[]) => void };

export async function sendMessengerText(
  orgId: string,
  recipientId: string,
  text: string,
  log?: Logger,
): Promise<string | null> {
  const channel = await withRlsBypass((tx) =>
    tx.messengerChannel.findUnique({ where: { organizationId: orgId } }),
  );
  if (!channel || !channel.isActive || !channel.pageAccessToken) return null;
  const pageToken = decryptSecret(channel.pageAccessToken) ?? '';
  if (!pageToken) return null;
  try {
    const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(pageToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: 'RESPONSE',
        message: { text: text.slice(0, 1900) },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text();
    if (!res.ok) {
      log?.warn?.({ status: res.status, body: body.slice(0, 200) }, '[messenger] send failed');
      return null;
    }
    try {
      return (JSON.parse(body) as { message_id?: string }).message_id ?? null;
    } catch {
      return null;
    }
  } catch (err) {
    log?.warn?.({ err: err instanceof Error ? err.message : err }, '[messenger] send threw');
    return null;
  }
}

// Send an image attachment by URL (used to deliver product photos). Best-
// effort; returns the message id or null.
export async function sendMessengerImage(
  orgId: string,
  recipientId: string,
  imageUrl: string,
  log?: Logger,
): Promise<string | null> {
  const channel = await withRlsBypass((tx) =>
    tx.messengerChannel.findUnique({ where: { organizationId: orgId } }),
  );
  if (!channel || !channel.isActive || !channel.pageAccessToken) return null;
  const pageToken = decryptSecret(channel.pageAccessToken) ?? '';
  if (!pageToken) return null;
  try {
    const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(pageToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: 'RESPONSE',
        message: { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: true } } },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log?.warn?.({ status: res.status }, '[messenger] image send failed');
      return null;
    }
    const body = await res.text();
    try {
      return (JSON.parse(body) as { message_id?: string }).message_id ?? null;
    } catch {
      return null;
    }
  } catch (err) {
    log?.warn?.({ err: err instanceof Error ? err.message : err }, '[messenger] image send threw');
    return null;
  }
}
