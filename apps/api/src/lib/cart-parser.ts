// Stateful-cart helper. The bot's "[CART:]" marker is fragile —
// GPT-4o-mini sometimes drops items from it on long carts — so we
// instead track the cart as it builds, by parsing the bot's own
// reply text for "added N× <product>" lines and persisting items
// into a `status='draft'` Cart row in real time. At confirmation
// the draft is promoted to a real cart and the marker's items are
// IGNORED. Outcome: cart contents always match what the bot
// actually agreed to add.
//
// Same parsing also powers the auto-image fix — for each parsed
// add we inject [IMAGE: <sku>] into the reply so the existing
// image-send pipeline fires even when the LLM forgot the marker.

export interface CatalogProduct {
  id: string;
  sku: string;
  name: string;
  priceMinor: number | null;
}

export interface ParsedAdd {
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
}

// Detect the bot's "I've added N× <name>" / "added N <name>" lines.
// The bot is multilingual so we match Arabic ("أضفت") + English variants.
// We pull the integer quantity + the rest of the line for fuzzy product
// matching against the catalog (the LLM sometimes paraphrases — "Oreo
// Milkshake (vanilla)" — so exact-match on name doesn't cut it).
const ADD_PATTERNS = [
  // English: "Got it — 4× Oreo …", "I've added 1× Oreo …", "Added 4 Oreo …"
  /(?:i(?:'ve|\s+have)?\s+added|got\s+it\s*[—\-,]?\s*|added)\s+(\d{1,3})\s*[x×]?\s+([^\n.;]{2,80})/gi,
  // English: "4× Oreo Milkshake at 0.150 KWD" (running-total line variant)
  /\b(\d{1,3})\s*[x×]\s+([a-z][^.\n;]{2,80})/gi,
  // Arabic: "أضفت 4× Oreo Milkshake" or "Nأضفت X "
  /(?:أضفت|أَضَفْتُ|تمت\s+إضافة)\s+(\d{1,3})\s*[x×]?\s+([^\n.؛.]{2,80})/g,
];

// Cancel / restart phrases the customer might use to wipe the cart
// before confirming. Conservative — we only match clear intents so
// "nevermind, what about the oreo" doesn't nuke the cart.
const CANCEL_PATTERNS = [
  /^\s*(cancel|nevermind|never\s*mind|forget\s+it|start\s+over|clear\s+(my\s+)?(cart|order)|reset)\s*[.!?]?\s*$/i,
  /^\s*(actually\s+(no|nevermind|cancel))\s*[.!?]?\s*$/i,
  // Arabic
  /(إلغاء|ألغي\s*(الطلب|السلة)|ابدأ\s*من\s*جديد)/,
];

/**
 * True iff the customer's message clearly says "cancel / start over".
 * Used to delete the draft cart before the bot replies.
 */
export function detectCancelIntent(userMessage: string): boolean {
  const m = userMessage.trim();
  if (m.length === 0 || m.length > 200) return false;
  return CANCEL_PATTERNS.some((re) => re.test(m));
}

/**
 * Lowercase + strip punctuation + collapse whitespace.
 * Used both for catalog name + the bot's quoted name so we can
 * substring-match across the LLM's paraphrasing.
 */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Best-effort match of an extracted name fragment against the catalog.
 * Returns the most specific match — prefers the longest catalog name
 * that's a substring of the parsed fragment.
 */
function findProduct(fragment: string, catalog: CatalogProduct[]): CatalogProduct | null {
  const fragNorm = normalise(fragment);
  if (!fragNorm) return null;
  let best: { product: CatalogProduct; score: number } | null = null;
  for (const p of catalog) {
    const nameNorm = normalise(p.name);
    if (!nameNorm) continue;
    if (fragNorm.includes(nameNorm)) {
      const score = nameNorm.length;
      if (!best || score > best.score) best = { product: p, score };
    } else if (p.sku && fragNorm.includes(normalise(p.sku))) {
      // Last-ditch: maybe the bot leaked a SKU into the line.
      if (!best) best = { product: p, score: 1 };
    }
  }
  return best?.product ?? null;
}

/**
 * Parse a single bot reply for all "added N× <name>" lines.
 * Returns one ParsedAdd per item that resolves against the catalog.
 * Unresolved fragments are silently dropped (the bot might hallucinate
 * a name; we'd rather skip than fabricate a cart row).
 *
 * Multiple matches for the same SKU within one reply collapse to a
 * single entry — quantity is the LARGEST mentioned (bot saying "I've
 * added 1× X. Running total 1× X" shouldn't double-count).
 */
export function parseAddedItems(
  reply: string,
  catalog: CatalogProduct[],
): ParsedAdd[] {
  if (!reply || catalog.length === 0) return [];
  const bySku = new Map<string, ParsedAdd>();
  for (const re of ADD_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(reply)) !== null) {
      const qty = Math.max(1, Math.min(999, Number(match[1])));
      if (!Number.isFinite(qty)) continue;
      const fragment = match[2] ?? '';
      const product = findProduct(fragment, catalog);
      if (!product) continue;
      const prev = bySku.get(product.sku);
      if (!prev || qty > prev.quantity) {
        bySku.set(product.sku, {
          productId: product.id,
          sku: product.sku,
          name: product.name,
          quantity: qty,
          unitPriceMinor: product.priceMinor ?? 0,
        });
      }
    }
  }
  return Array.from(bySku.values());
}

/**
 * Inject [IMAGE: <sku>] markers into the reply text for each parsed
 * add whose marker isn't already present. The downstream send pipeline
 * resolves these to product images, so the customer always sees a
 * picture even when the LLM forgot the marker. Placed at the end of
 * the reply on their own line; the existing marker stripper handles
 * removal from the visible body.
 */
export function augmentReplyWithImageMarkers(reply: string, items: ParsedAdd[]): string {
  if (items.length === 0) return reply;
  const lower = reply.toLowerCase();
  const missing: string[] = [];
  for (const it of items) {
    const tag = `[image: ${it.sku.toLowerCase()}]`;
    if (!lower.includes(tag)) missing.push(it.sku);
  }
  if (missing.length === 0) return reply;
  const markerLines = missing.map((sku) => `[IMAGE: ${sku}]`).join('\n');
  return `${reply.trimEnd()}\n${markerLines}`;
}
