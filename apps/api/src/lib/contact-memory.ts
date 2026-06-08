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
// Both paths use withRlsBypass (the bot runs outside a tenant tx) and
// therefore ALWAYS scope by organizationId in the where-clause.

import type { Prisma } from '@aligned/db';

import { withRlsBypass } from './db.js';
import { completeFast } from './openai.js';

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
    const row = await withRlsBypass((tx) =>
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
    'Use this to personalise — do NOT invent facts beyond it, and do NOT mention that you have a memory of them.',
  );
  return lines.join('\n');
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
    const existing = await withRlsBypass((tx) =>
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

    await withRlsBypass((tx) =>
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
