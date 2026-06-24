// Voice order capture — turns a structured order from the phone voicebot's
// `submit_order` tool into a real Cart (status 'new'), exactly like a WhatsApp/
// Messenger order, so it shows in /cart and alerts operators. Reuses the shared
// captureCart (cart-flow.ts) for line-item + delivery + total math; the only
// voice-specific parts are (1) matching SPOKEN item names to the catalog (the
// realtime model never sees SKUs) and (2) the absence of an inbox thread —
// threadId is null, so we always fire an operator notification + webhook
// (a WhatsApp order surfaces via the inbox thread instead).
import type { BotData } from './bot-engine.js';
import { captureCart } from './cart-flow.js';
import { createNotification } from './notifications.js';
import { dispatchVoiceOrderBill } from './voice-payment.js';
import { emitWebhookEvent } from './webhooks.js';

type CatalogLite = { id: string; sku: string; name: string; priceMinor: number | null };

// Lowercase, strip punctuation (keep Arabic block), collapse whitespace — the
// same normalisation idea as cart-parser, so "Zaatar Manakish" ≈ "zaatar
// manakish" and Arabic names compare cleanly.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Best-effort match of a spoken item name to a catalog product. Bidirectional
 * (unlike cart-parser's findProduct which only checks catalog⊆fragment) because
 * a caller may say a shorter or longer phrase than the exact menu name. Scores:
 * exact > one contains the other > shared-token count > literal SKU.
 */
export function matchProduct(spokenName: string, catalog: CatalogLite[]): CatalogLite | null {
  const q = normalize(spokenName);
  if (!q) return null;
  const qTokens = new Set(q.split(' ').filter((t) => t.length >= 3));
  let best: { p: CatalogLite; score: number } | null = null;
  for (const p of catalog) {
    const n = normalize(p.name);
    if (!n) continue;
    let score = 0;
    if (n === q) score = 1000;
    else if (q.includes(n)) score = 500 + n.length;
    else if (n.includes(q)) score = 400 + q.length;
    else {
      const nTokens = n.split(' ').filter((t) => t.length >= 3);
      const shared = nTokens.filter((t) => qTokens.has(t)).length;
      if (shared > 0) score = shared * 10 + Math.min(nTokens.length, 9);
    }
    if (score === 0 && p.sku && q.includes(normalize(p.sku))) score = 5;
    if (score > 0 && (!best || score > best.score)) best = { p, score };
  }
  return best?.p ?? null;
}

export interface VoiceOrderItemInput {
  name: string;
  quantity: number;
  notes?: string | null;
}

export interface CreateVoiceOrderArgs {
  orgId: string;
  callUuid: string;
  /** Caller's phone (normalised), used as the cart's customerPhone. */
  callerPhone: string;
  customerName: string | null;
  items: VoiceOrderItemInput[];
  /** Fulfillment details (name/phone/fulfillment/address/notes), kept on the cart. */
  fields: Record<string, unknown>;
  /** From gatherBotData — carries products[] + shopForm. */
  data: BotData;
}

export interface VoiceOrderResult {
  orderId: string;
  itemsCount: number;
  totalMinor: number;
  currency: string;
  matched: number;
  unmatched: string[];
}

/**
 * Create a confirmed order ('new') from a voice call. Returns null when the
 * tenant has no shop enabled or nothing could be captured.
 */
export async function createVoiceOrder(args: CreateVoiceOrderArgs): Promise<VoiceOrderResult | null> {
  const shopForm = args.data.shopForm;
  if (!shopForm) return null; // ordering not enabled for this tenant
  const products = args.data.products as CatalogLite[];

  const resolved: {
    sku?: string;
    name: string;
    quantity: number;
    unitPriceMinor?: number;
    notes?: string;
  }[] = [];
  const unmatched: string[] = [];
  let matched = 0;
  for (const it of args.items) {
    const qty = Math.max(1, Math.floor(Number(it.quantity) || 1));
    const p = matchProduct(it.name, products);
    if (p) {
      matched++;
      resolved.push({
        sku: p.sku,
        name: p.name,
        quantity: qty,
        unitPriceMinor: p.priceMinor ?? 0,
        notes: it.notes ?? undefined,
      });
    } else {
      unmatched.push(it.name);
      // Keep it on the order so nothing the caller asked for is silently lost;
      // price 0 flags it for the operator to confirm.
      resolved.push({
        name: it.name,
        quantity: qty,
        unitPriceMinor: 0,
        notes: it.notes ?? 'not matched to the menu — needs pricing',
      });
    }
  }
  if (resolved.length === 0) return null;

  const captured = await captureCart({
    orgId: args.orgId,
    threadId: null,
    customerId: args.callerPhone,
    customerName: args.customerName,
    cartMarkerPayload: { items: resolved, fields: args.fields },
    shopForm,
    products,
  });
  if (!captured) return null;

  // No inbox thread for voice → proactively notify operators + fire the same
  // webhook a WhatsApp order would.
  void emitWebhookEvent({
    organizationId: args.orgId,
    eventKind: 'cart_created',
    payload: {
      id: captured.id,
      source: 'voice',
      customerPhone: args.callerPhone,
      totalMinor: captured.totalMinor,
      currency: captured.currency,
      itemsCount: captured.itemsCount,
    },
  }).catch(() => undefined);

  void createNotification({
    organizationId: args.orgId,
    kind: 'cart_received',
    severity: unmatched.length > 0 ? 'warning' : 'info',
    title: `Voice order · ${captured.itemsCount} item${captured.itemsCount === 1 ? '' : 's'}`,
    body:
      `${args.customerName ?? args.callerPhone}` +
      (unmatched.length > 0 ? ` · ${unmatched.length} item(s) need pricing` : ''),
    link: '/cart',
    entityType: 'cart',
    entityId: captured.id,
  }).catch(() => undefined);

  // Mint + WhatsApp the payment "bill" to the caller. Backgrounded (void) so the
  // gateway + Meta round-trips never block the live call's submit_order response.
  void dispatchVoiceOrderBill({
    orgId: args.orgId,
    cartId: captured.id,
    customerName: args.customerName,
    customerPhone: args.callerPhone,
    totalMinor: captured.totalMinor,
    currency: captured.currency,
  }).catch(() => undefined);

  return {
    orderId: captured.id,
    itemsCount: captured.itemsCount,
    totalMinor: captured.totalMinor,
    currency: captured.currency,
    matched,
    unmatched,
  };
}
