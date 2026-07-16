// Deterministic scripted-flow engine.
//
// A guided, button-driven state machine that runs BEFORE the LLM in the WhatsApp
// inbound path. When a tenant has an ENABLED BotConfig.scriptedFlow, the bot no
// longer generates replies — it sends the operator's EXACT text + tappable
// buttons and advances node-by-node on each tap/answer, guaranteeing verbatim
// wording and strict branching (used by tenants whose bot is a scripted intake
// flow, not a Q&A / shop bot).
//
// Content lives entirely in the DB (BotConfig.scriptedFlow), so refining a
// message is a data update, not a redeploy. This module is the stable engine.
import { withTenant } from './db.js';

// ---------- flow definition (stored as JSON on BotConfig.scriptedFlow) -------
export interface FlowButton {
  title: string; // ≤ 20 chars (WhatsApp button limit), rendered as a tap-button
  next: string; // node id to go to when tapped
}
export interface FlowKeyword {
  match: string; // case-insensitive substring the customer might type
  next: string;
}
export interface FlowNode {
  // Message text to send for this node (may be multi-line). Optional for
  // action-only nodes.
  text?: string;
  // Optional voice note (Asset id) sent BEFORE the text.
  voiceAssetId?: string | null;
  // Tap-buttons (max 3 on WhatsApp). Presence implies waitFor:'button'.
  buttons?: FlowButton[];
  // Typed-keyword shortcuts (checked when the node waits on a button but the
  // customer types instead — e.g. a menu's merged 4th option).
  keywords?: FlowKeyword[];
  // What advances the flow from here. Defaults: 'button' if buttons present,
  // else 'text' if `next` present, else the node ends the flow.
  waitFor?: 'button' | 'text' | 'image';
  // Where to go on a text answer / an image / an auto-advance.
  next?: string;
  // Side effect on entering this node.
  action?: 'end' | 'handoff' | 'booking' | 'payment';
  // For action 'booking': a booking URL appended to the message.
  bookingUrl?: string | null;
}
export interface ScriptedFlow {
  enabled?: boolean;
  channel?: string; // 'whatsapp'
  entry: string; // entry node id
  nodes: Record<string, FlowNode>;
}
interface FlowState {
  nodeId: string;
  done?: boolean;
  answers?: string[];
}

const GRAPH = 'https://graph.facebook.com/v20.0';
const MAX_CHAIN = 6; // safety bound on auto-advance chaining

export interface FlowChannel {
  id: string;
  phoneNumberId: string | null;
  accessToken: string | null;
}
export interface FlowInbound {
  from: string;
  type: string; // 'text' | 'interactive' | 'button' | 'image' | ...
  bodyText: string | null; // for interactive/button this is the tapped title
  mediaId?: string | null;
}
type Logger = {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
};

function parseFlow(raw: unknown): ScriptedFlow | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as ScriptedFlow;
  if (!f.enabled) return null;
  if (!f.entry || !f.nodes || typeof f.nodes !== 'object') return null;
  if (!f.nodes[f.entry]) return null;
  return f;
}
function parseState(raw: unknown): FlowState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as FlowState;
  if (typeof s.nodeId !== 'string') return null;
  return s;
}

/**
 * Handle one inbound WhatsApp message with the tenant's scripted flow.
 * Returns true if the flow handled it (the caller MUST then skip the LLM);
 * false if there's no active flow and the normal bot should run.
 */
export async function runScriptedFlow(args: {
  organizationId: string;
  channel: FlowChannel;
  thread: { id: string; flowState: unknown };
  scriptedFlow: unknown;
  message: FlowInbound;
  log: Logger;
}): Promise<boolean> {
  const flow = parseFlow(args.scriptedFlow);
  if (!flow) return false;
  if (flow.channel && flow.channel !== 'whatsapp') return false;
  if (!args.channel.phoneNumberId || !args.channel.accessToken) return false;

  const sendText = async (body: string): Promise<void> => {
    await postAndPersist(args, { type: 'text', text: { preview_url: true, body: body.slice(0, 4096) } }, body, []);
  };
  const sendButtons = async (body: string, buttons: FlowButton[]): Promise<void> => {
    const btns = buttons.slice(0, 3);
    await postAndPersist(
      args,
      {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: body.slice(0, 1024) },
          action: {
            buttons: btns.map((b, i) => ({
              type: 'reply',
              reply: { id: `flow_${i}`, title: b.title.slice(0, 20) },
            })),
          },
        },
      },
      body,
      btns.map((b) => b.title),
    );
  };

  // Send a node's message(s) + run its side effect. Returns the NEXT state's
  // nodeId to persist, and whether the flow is now waiting for input (stop) or
  // should keep chaining.
  const enterNode = async (
    nodeId: string,
  ): Promise<{ nodeId: string; done: boolean; waiting: boolean }> => {
    const node = flow.nodes[nodeId];
    if (!node) {
      args.log.warn({ nodeId }, '[flow] missing node — ending');
      return { nodeId, done: true, waiting: false };
    }
    // Optional voice note first.
    if (node.voiceAssetId) {
      await sendVoice(args, node.voiceAssetId).catch((err) =>
        args.log.warn({ err, nodeId }, '[flow] voice send failed (continuing)'),
      );
    }
    // Compose the text (booking URL appended when configured).
    let body = node.text ?? '';
    if (node.action === 'booking' && node.bookingUrl) {
      body = body ? `${body}\n\n${node.bookingUrl}` : node.bookingUrl;
    }
    const buttons = node.buttons ?? [];
    if (body || buttons.length > 0) {
      if (buttons.length > 0) await sendButtons(body || '👇', buttons);
      else await sendText(body);
    }
    // Side effects.
    if (node.action === 'handoff') {
      await markThreadPending(args).catch(() => undefined);
    }
    // Decide what happens next.
    const waitFor = node.waitFor ?? (buttons.length > 0 ? 'button' : node.next ? 'text' : undefined);
    if (node.action === 'end') return { nodeId, done: true, waiting: false };
    if (waitFor) return { nodeId, done: false, waiting: true };
    if (node.next) return { nodeId: node.next, done: false, waiting: false }; // auto-advance
    return { nodeId, done: true, waiting: false }; // terminal node with no next
  };

  // Advance through auto-chaining nodes until one waits for input or the flow
  // ends, then persist the resting state.
  const settle = async (startNodeId: string, answers: string[]): Promise<void> => {
    let cur = startNodeId;
    let done = false;
    for (let i = 0; i < MAX_CHAIN; i++) {
      const r = await enterNode(cur);
      cur = r.nodeId;
      if (r.done) {
        done = true;
        break;
      }
      if (r.waiting) break;
    }
    await saveState(args, { nodeId: cur, done, answers });
  };

  const state = parseState(args.thread.flowState);

  // ---- Fresh start: no state, or a previous run already finished ----
  if (!state || state.done) {
    // If the flow already completed for this conversation, stay silent (the
    // operator follows up) rather than restarting the whole intake.
    if (state?.done) return true;
    await settle(flow.entry, []);
    return true;
  }

  // ---- Mid-flow: process the customer's input at the current node ----
  const node = flow.nodes[state.nodeId];
  if (!node) {
    await settle(flow.entry, state.answers ?? []); // corrupt state → restart cleanly
    return true;
  }
  const isTap = args.message.type === 'interactive' || args.message.type === 'button';
  const tapped = (args.message.bodyText ?? '').trim();
  const text = (args.message.bodyText ?? '').trim();
  const isImage = args.message.type === 'image';
  const effectiveWait = node.waitFor ?? (node.buttons?.length ? 'button' : node.next ? 'text' : undefined);

  // Keyword shortcuts work regardless of what the node waits on.
  if (node.keywords && text) {
    const low = text.toLowerCase();
    const kw = node.keywords.find((k) => low.includes(k.match.toLowerCase()));
    if (kw) {
      await settle(kw.next, state.answers ?? []);
      return true;
    }
  }

  if (effectiveWait === 'button') {
    const match =
      (isTap && node.buttons?.find((b) => b.title === tapped)) ||
      node.buttons?.find((b) => b.title === text) ||
      null;
    if (match) {
      await settle(match.next, state.answers ?? []);
      return true;
    }
    // Didn't tap a known button — re-show the current node so they can choose.
    await settle(state.nodeId, state.answers ?? []);
    return true;
  }

  if (effectiveWait === 'image') {
    if (isImage && node.next) {
      await settle(node.next, state.answers ?? []);
      return true;
    }
    // Gently re-prompt for the drawing.
    await settle(state.nodeId, state.answers ?? []);
    return true;
  }

  if (effectiveWait === 'text') {
    const answers = [...(state.answers ?? []), text].filter(Boolean);
    if (node.next) {
      await settle(node.next, answers);
      return true;
    }
    await saveState(args, { nodeId: state.nodeId, done: true, answers });
    return true;
  }

  // No wait defined (shouldn't happen mid-flow) — re-enter to be safe.
  await settle(state.nodeId, state.answers ?? []);
  return true;
}

// ---------- side effects / persistence --------------------------------------
async function postAndPersist(
  args: {
    organizationId: string;
    channel: FlowChannel;
    thread: { id: string };
    message: FlowInbound;
    log: Logger;
  },
  content: Record<string, unknown>,
  body: string,
  quickReplies: string[],
): Promise<void> {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: args.message.from,
    ...content,
  };
  let metaId: string | null = null;
  try {
    const res = await fetch(`${GRAPH}/${encodeURIComponent(args.channel.phoneNumberId!)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.channel.accessToken!}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const t = await res.text();
    if (!res.ok) {
      args.log.error({ status: res.status, body: t.slice(0, 300) }, '[flow] Meta send failed');
      return;
    }
    metaId = (JSON.parse(t) as { messages?: { id?: string }[] }).messages?.[0]?.id ?? null;
  } catch (err) {
    args.log.error({ err }, '[flow] Meta send threw');
    return;
  }
  // Persist so the message shows in the inbox thread.
  await withTenant(args.organizationId, async (tx) => {
    await tx.whatsAppMessage.create({
      data: {
        organizationId: args.organizationId,
        threadId: args.thread.id,
        channel: 'whatsapp',
        direction: 'outbound',
        metaMessageId: metaId,
        toNumber: args.message.from,
        messageType: quickReplies.length > 0 ? 'interactive' : 'text',
        body,
        rawPayload: { sentBy: 'bot', flow: true, quickReplies } as never,
      },
    });
    await tx.whatsAppThread.update({
      where: { id: args.thread.id },
      data: { lastMessageAt: new Date() },
    });
  }).catch((err) => args.log.warn({ err }, '[flow] persist outbound failed'));
}

async function saveState(
  args: { organizationId: string; thread: { id: string }; log: Logger },
  state: FlowState,
): Promise<void> {
  await withTenant(args.organizationId, (tx) =>
    tx.whatsAppThread.update({ where: { id: args.thread.id }, data: { flowState: state as never } }),
  ).catch((err) => args.log.warn({ err }, '[flow] save state failed'));
}

async function markThreadPending(args: {
  organizationId: string;
  thread: { id: string };
}): Promise<void> {
  await withTenant(args.organizationId, (tx) =>
    tx.whatsAppThread.update({ where: { id: args.thread.id }, data: { status: 'pending' } }),
  );
}

// Voice note: download the Asset from storage → upload to Meta /media → send as
// audio. No-op (logged) if the asset/storage isn't available yet.
async function sendVoice(
  args: { organizationId: string; channel: FlowChannel; message: FlowInbound; log: Logger },
  assetId: string,
): Promise<void> {
  const asset = await withTenant(args.organizationId, (tx) =>
    tx.asset.findFirst({ where: { id: assetId }, select: { storageKey: true, contentType: true } }),
  );
  if (!asset) {
    args.log.warn({ assetId }, '[flow] voice asset not found — skipping');
    return;
  }
  const { getObjectStream, isStorageConfigured } = await import('./storage.js');
  if (!isStorageConfigured()) return;
  const stream = await getObjectStream(asset.storageKey);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  const buf = Buffer.concat(chunks);
  // Upload to Meta /media.
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append(
    'file',
    new Blob([new Uint8Array(buf)], { type: asset.contentType || 'audio/ogg' }),
    'voice.ogg',
  );
  const up = await fetch(`${GRAPH}/${encodeURIComponent(args.channel.phoneNumberId!)}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.channel.accessToken!}` },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  if (!up.ok) {
    args.log.warn({ status: up.status }, '[flow] voice media upload failed');
    return;
  }
  const mediaId = (JSON.parse(await up.text()) as { id?: string }).id;
  if (!mediaId) return;
  await fetch(`${GRAPH}/${encodeURIComponent(args.channel.phoneNumberId!)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.channel.accessToken!}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: args.message.from,
      type: 'audio',
      audio: { id: mediaId },
    }),
    signal: AbortSignal.timeout(15_000),
  });
}
