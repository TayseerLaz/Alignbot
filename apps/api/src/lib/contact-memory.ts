// Per-contact persona / memory for the `ultra` AI plan.
//
// Distils durable facts worth remembering across conversations (preferred
// language, tone, past orders/bookings, recurring needs) and injects a
// compact block into the system prompt before each reply. This is NOT a
// transcript cache — only the "important things" survive, exactly as small
// as possible. The customer explicitly asked for "don't cache it, just save
// the important things in a chat with the user."
//
// Read path:  loadPersonaBlock() — cheap single-row lookup, returns a
//             prompt-ready text block + detected language. Runs BEFORE the
//             reply, on the hot path, so it's a plain indexed read.
// Write path: updateContactMemory() — a Haiku summarization pass folds the
//             latest turn into the stored persona. Fire-and-forget AFTER the
//             reply has been sent, so it never adds latency for the customer.
//
// Both paths run under withTenant (F-02 — RLS is the backstop) and ALSO scope
// by organizationId in the where-clause as defence-in-depth.

import type { Prisma } from '@aligned/db';

import { withTenant } from './db.js';
import { completeFast } from './openai.js';
import { getRedis } from './redis.js';

export interface PersonaBlock {
  persona: string | null;
  language: string | null;
}

// Compact, prompt-ready persona for a contact, or null if we have nothing
// useful yet. Never throws — memory is an enhancement, never a hard
// dependency of the reply.
export async function loadPersonaBlock(
  organizationId: string,
  phoneE164: string,
): Promise<PersonaBlock | null> {
  try {
    const row = await withTenant(organizationId, (tx) =>
      tx.contactMemory.findUnique({
        where: { organizationId_phoneE164: { organizationId, phoneE164 } },
        select: { persona: true, language: true },
      }),
    );
    if (!row || (!row.persona && !row.language)) return null;
    return { persona: row.persona ?? null, language: row.language ?? null };
  } catch {
    return null;
  }
}

// Render the persona into the block the bot-engine injects into the system
// prompt. Kept here (not in bot-engine) so the wording lives next to the
// data shape. Returns '' when there's nothing to say.
export function renderPersonaForPrompt(block: PersonaBlock | null): string {
  if (!block || (!block.persona && !block.language)) return '';
  const lines = ['# What you remember about THIS customer (private — never read it back verbatim)'];
  if (block.persona) lines.push(block.persona.trim());
  if (block.language) {
    lines.push(
      `Their primary language is "${block.language}". Reply in the language they wrote in this turn; default to ${block.language} if ambiguous.`,
    );
  }
  lines.push(
    'Use this to personalise, but CONFIRM specifics (delivery address, payment) with the customer for each order instead of assuming them from memory. Do NOT invent facts beyond this, and do NOT say you have a memory of them.',
  );
  return lines.join('\n');
}

// ---- Order history (for "what did I order before" + re-order requests) -----
// Pulls the customer's recent FINALISED orders (carts promoted past 'draft')
// straight from the DB — authoritative, not a chat summary. Injected into the
// prompt so the bot can answer "what was my last order?" and re-order the same
// items, instead of "I don't have access to your order history".

export interface PastOrder {
  at: Date;
  totalMinor: number;
  currency: string;
  items: { name: string; quantity: number; sku: string | null }[];
}

// Flatten the distinct product SKUs across a set of past orders. The bot
// call-site pins these into the packed catalog so the model can actually
// re-add a previous order ("yes add these") instead of wrongly claiming the
// items aren't in the catalog (top-K would otherwise drop them).
export function pinnedSkusFromOrders(orders: PastOrder[]): string[] {
  return Array.from(
    new Set(
      orders.flatMap((o) => o.items.map((i) => i.sku).filter((s): s is string => !!s)),
    ),
  );
}

export async function loadRecentOrders(
  organizationId: string,
  phoneE164: string,
  limit = 3,
): Promise<PastOrder[]> {
  try {
    const rows = await withTenant(organizationId, (tx) =>
      tx.cart.findMany({
        where: {
          organizationId,
          customerPhone: phoneE164,
          status: { in: ['new', 'confirmed'] },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          createdAt: true,
          totalMinor: true,
          currency: true,
          items: { select: { name: true, quantity: true, sku: true } },
        },
      }),
    );
    return rows
      .filter((c) => c.items.length > 0)
      .map((c) => ({
        at: c.createdAt,
        totalMinor: c.totalMinor ?? 0,
        currency: c.currency,
        items: c.items.map((i) => ({ name: i.name, quantity: i.quantity, sku: i.sku })),
      }));
  } catch {
    return [];
  }
}

export function renderOrdersForPrompt(orders: PastOrder[]): string {
  if (orders.length === 0) return '';
  const lines = orders.map((o, idx) => {
    const items = o.items.map((i) => `${i.quantity}x ${i.name}`).join(', ');
    const dec = ['KWD', 'BHD', 'OMR', 'JOD'].includes(o.currency) ? 3 : 2;
    const total = (o.totalMinor / Math.pow(10, dec)).toFixed(dec);
    const label = idx === 0 ? 'Most recent order' : `Order ${idx + 1} back`;
    return `- ${label}: ${items} (${total} ${o.currency})`;
  });
  return [
    "# This customer's recent orders (authoritative — from our records)",
    'Use these to answer "what did I order before?" and to re-order ("the same as last time") — quote the items + totals VERBATIM, never invent. If they ask to re-order, add those exact items to a fresh cart and confirm.',
    ...lines,
  ].join('\n');
}

// Fold the latest exchange into the contact's stored memory via a cheap
// Haiku pass. Best-effort: any failure is swallowed so it can never affect
// the reply that already went out. Call AFTER sending the reply.
export async function updateContactMemory(args: {
  organizationId: string;
  phoneE164: string;
  customerName?: string | null;
  history: { role: 'user' | 'assistant'; content: string }[];
  latestUserMessage: string;
  latestBotReply?: string | null;
}): Promise<void> {
  try {
    // Per-contact throttle — at most one re-summarisation per ~90s, so a burst
    // of messages doesn't fire a summariser call per message (this runs on all
    // plans now, so the token cost matters). Skipped turns are still folded in
    // next time, since we re-read recent history each run.
    try {
      const redis = getRedis();
      const set = await redis.set(
        `memthrottle:${args.organizationId}:${args.phoneE164}`,
        '1',
        'PX',
        90_000,
        'NX',
      );
      if (set !== 'OK') return;
    } catch {
      /* redis unavailable — proceed without throttling */
    }
    const existing = await withTenant(args.organizationId, (tx) =>
      tx.contactMemory.findUnique({
        where: {
          organizationId_phoneE164: {
            organizationId: args.organizationId,
            phoneE164: args.phoneE164,
          },
        },
        select: { persona: true, facts: true, language: true },
      }),
    );

    const transcript = [
      ...args.history,
      { role: 'user' as const, content: args.latestUserMessage },
      ...(args.latestBotReply ? [{ role: 'assistant' as const, content: args.latestBotReply }] : []),
    ]
      .slice(-12)
      .map((m) => `${m.role === 'user' ? 'Customer' : 'Bot'}: ${m.content}`)
      .join('\n')
      .slice(0, 4000);

    const sys = [
      'You maintain a concise CRM-style memory of ONE customer for a business chatbot.',
      'Given the existing memory and the latest conversation, output an UPDATED memory.',
      'Keep ONLY durable, reusable facts: preferred language, name, tone, past or open orders/bookings, stated preferences, constraints/allergies, do-not-contact requests.',
      'Drop small talk, one-off questions, and anything not worth remembering next time. Be brief — "persona" is one short paragraph at most.',
      'Detect the primary language the customer writes in as an ISO code: "ar", "en", or "fr" (or another code if clearly different).',
      'Return JSON only: {"persona": string, "facts": object, "language": string}.',
    ].join(' ');

    const user = [
      args.customerName ? `Customer name (if known): ${args.customerName}` : '',
      existing?.persona ? `Existing persona:\n${existing.persona}` : 'Existing persona: (none yet)',
      existing?.facts ? `Existing facts JSON:\n${JSON.stringify(existing.facts)}` : '',
      `Recent conversation:\n${transcript}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const result = await completeFast<{
      persona?: string;
      facts?: Record<string, unknown>;
      language?: string;
    }>({
      organizationId: args.organizationId,
      systemPrompt: sys,
      userContent: user,
      maxTokens: 400,
    });

    const persona = (result.persona ?? '').trim().slice(0, 2000) || existing?.persona || null;
    const language = (result.language ?? '').trim().slice(0, 12) || existing?.language || null;
    const facts =
      result.facts && typeof result.facts === 'object'
        ? result.facts
        : (existing?.facts as Record<string, unknown> | undefined) ?? {};

    await withTenant(args.organizationId, (tx) =>
      tx.contactMemory.upsert({
        where: {
          organizationId_phoneE164: {
            organizationId: args.organizationId,
            phoneE164: args.phoneE164,
          },
        },
        create: {
          organizationId: args.organizationId,
          phoneE164: args.phoneE164,
          persona,
          facts: facts as Prisma.InputJsonValue,
          language,
          turnsSummarized: 1,
          lastSummaryAt: new Date(),
        },
        update: {
          persona,
          facts: facts as Prisma.InputJsonValue,
          language,
          turnsSummarized: { increment: 1 },
          lastSummaryAt: new Date(),
        },
      }),
    );
  } catch (err) {
    // Best-effort: memory never breaks the reply path.
    // eslint-disable-next-line no-console
    console.warn(
      '[contact-memory] update failed',
      err instanceof Error ? err.message.slice(0, 160) : String(err),
    );
  }
}
