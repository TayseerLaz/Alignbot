// Alinia real-estate helpers — behavior that applies ONLY to mirror products
// (Product.sourceSystem === 'alinia'). Every consumer gates on sourceSystem, so
// native products and pure-native tenants are byte-for-byte unaffected.
//
// The `attributes` JSON shape is produced by Alinia's haderSyncService.mapListing
// (camelCase keys). This module is the single place that reads/interprets it.

export interface AliniaAttrs {
  transactionType: 'sale' | 'rent' | 'both' | null;
  propertyCategory: string | null;
  houseType: string | null;
  city: string | null;
  areaLocation: string | null; // the neighbourhood (there is no `neighbourhood` key)
  bedrooms: number | null;
  bathrooms: number | null;
  propertySize: number | null; // sqm
  price: number | null;
  salePrice: number | null;
  rentPrice: number | null;
  currency: string | null;
  pricePeriod: string | null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function parseAliniaAttrs(attributes: unknown): AliniaAttrs | null {
  if (!attributes || typeof attributes !== 'object') return null;
  const a = attributes as Record<string, unknown>;
  const txn = a.transactionType;
  return {
    transactionType:
      txn === 'sale' || txn === 'rent' || txn === 'both' ? txn : null,
    propertyCategory: str(a.propertyCategory),
    houseType: str(a.houseType),
    city: str(a.city),
    areaLocation: str(a.areaLocation),
    bedrooms: num(a.bedrooms),
    bathrooms: num(a.bathrooms),
    propertySize: num(a.propertySize),
    price: num(a.price),
    salePrice: num(a.salePrice),
    rentPrice: num(a.rentPrice),
    currency: str(a.currency),
    pricePeriod: str(a.pricePeriod),
  };
}

/** The price a buyer/renter cares about, chosen by transaction type. */
function effectivePrice(a: AliniaAttrs): number | null {
  if (a.transactionType === 'rent') return a.rentPrice ?? a.price;
  return a.salePrice ?? a.price ?? a.rentPrice;
}

export function formatListingPrice(a: AliniaAttrs): string | null {
  const ccy = a.currency ?? 'USD';
  const per = a.pricePeriod === 'yearly' ? '/yr' : '/mo';
  const fmt = (n: number) => `${ccy} ${n.toLocaleString('en-US')}`;
  const parts: string[] = [];
  if (a.transactionType === 'rent') {
    if (a.rentPrice != null) parts.push(`For Rent: ${fmt(a.rentPrice)}${per}`);
  } else if (a.transactionType === 'both') {
    if (a.salePrice != null) parts.push(`For Sale: ${fmt(a.salePrice)}`);
    if (a.rentPrice != null) parts.push(`For Rent: ${fmt(a.rentPrice)}${per}`);
  } else {
    const p = a.salePrice ?? a.price;
    if (p != null) parts.push(`For Sale: ${fmt(p)}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

/** Compact structured facts appended to the LLM's product line for alinia rows. */
export function buildAliniaReTag(attributes: unknown): string {
  const a = parseAliniaAttrs(attributes);
  if (!a) return '';
  const bits: string[] = [];
  const price = formatListingPrice(a);
  if (price) bits.push(price);
  if (a.bedrooms != null) bits.push(`${a.bedrooms} bed`);
  if (a.bathrooms != null) bits.push(`${a.bathrooms} bath`);
  if (a.propertySize != null) bits.push(`${a.propertySize} sqm`);
  const where = [a.areaLocation, a.city].filter(Boolean).join(', ');
  if (where) bits.push(where);
  if (a.houseType) bits.push(a.houseType);
  return bits.length ? ` · ${bits.join(' · ')}` : '';
}

/** Canonical embed text for an alinia listing so semantic search is RE-aware. */
export function buildAliniaReEmbedText(attributes: unknown, fallbackName: string): string {
  const a = parseAliniaAttrs(attributes);
  if (!a) return fallbackName.slice(0, 500);
  const kind = [
    a.bedrooms != null ? `${a.bedrooms} bedroom` : '',
    a.houseType || a.propertyCategory || 'property',
  ]
    .filter(Boolean)
    .join(' ');
  const where = [a.areaLocation, a.city].filter(Boolean).join(', ');
  const txn =
    a.transactionType === 'rent'
      ? 'for rent'
      : a.transactionType === 'both'
        ? 'for sale or rent'
        : 'for sale';
  const size = a.propertySize != null ? `${a.propertySize} sqm` : '';
  const baths = a.bathrooms != null ? `${a.bathrooms} bathrooms` : '';
  const price = formatListingPrice(a) ?? '';
  return [kind, where, txn, size, baths, price].filter(Boolean).join(' — ').slice(0, 500);
}

// ---- Structured pre-filter: parse the user query into RE constraints ----

export interface ReConstraints {
  beds: number | null; // minimum bedrooms
  priceMax: number | null; // maximum price
  txn: 'sale' | 'rent' | null;
  area: string | null; // neighbourhood/city substring
}

export function parseReConstraints(message: string): ReConstraints {
  const m = message.toLowerCase();

  let beds: number | null = null;
  if (/\bstudio\b|استوديو/.test(m)) beds = 0;
  const bm = m.match(/(\d+)\s*\+?\s*(?:br\b|bed\b|beds\b|bedrooms?|bdr|غرف|غرفة|أوض|ghurf|gher)/);
  if (bm) beds = parseInt(bm[1]!, 10);

  let priceMax: number | null = null;
  const pm = m.match(
    /(?:under|below|less than|max(?:imum)?|up to|<=?|أقل من|تحت|حدود)\s*\$?\s*([\d.,]+)\s*(k|m|الف|ألف|مليون)?/,
  );
  if (pm) {
    let n = parseFloat(pm[1]!.replace(/,/g, ''));
    const unit = pm[2];
    if (unit === 'k' || unit === 'الف' || unit === 'ألف') n *= 1_000;
    else if (unit === 'm' || unit === 'مليون') n *= 1_000_000;
    if (Number.isFinite(n) && n > 0) priceMax = n;
  }

  let txn: 'sale' | 'rent' | null = null;
  if (/\b(rent|rental|to let|إيجار|للايجار|للإيجار|أجار|ajar)\b/.test(m)) txn = 'rent';
  else if (/\b(buy|sale|for sale|purchase|شراء|للبيع|بيع|be3|shera)\b/.test(m)) txn = 'sale';

  // "in <place>" — keep it short + word-only so it doesn't swallow "in good condition".
  let area: string | null = null;
  const am = m.match(/\b(?:in|at|near|بـ|في|منطقة)\s+([a-z؀-ۿ][a-z؀-ۿ-]{2,20})/);
  if (am) {
    const cand = am[1]!.trim();
    if (!/(good|great|cash|budget|mind|need|month|year|total)/.test(cand)) area = cand;
  }

  return { beds, priceMax, txn, area };
}

export function hasReConstraints(c: ReConstraints): boolean {
  return c.beds != null || c.priceMax != null || c.txn != null || !!c.area;
}

export function matchesReConstraints(attributes: unknown, c: ReConstraints): boolean {
  const a = parseAliniaAttrs(attributes);
  if (!a) return false;
  if (c.beds != null && (a.bedrooms == null || a.bedrooms < c.beds)) return false;
  if (c.priceMax != null) {
    const p = effectivePrice(a);
    if (p != null && p > c.priceMax) return false;
  }
  if (c.txn && a.transactionType && a.transactionType !== 'both' && a.transactionType !== c.txn) {
    return false; // 'both' satisfies either — mirrors Alinia's IN (txn,'both') rule
  }
  if (c.area) {
    const hay = `${a.areaLocation ?? ''} ${a.city ?? ''}`.toLowerCase();
    if (!hay.includes(c.area.toLowerCase())) return false;
  }
  return true;
}
