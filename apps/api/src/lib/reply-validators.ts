// Phase 9 — Universal post-LLM reply validators.
//
// Runs AFTER the LLM produces a reply but BEFORE the reply is sent to
// WhatsApp + persisted. Each validator is small, focused, deterministic,
// and entirely tenant-agnostic — every tenant's bot replies pass through
// the same pipeline. NO hardcoded tenant names, products, or thresholds:
// every check reads from the candidate KB + draft cart + form-enablement
// state passed in by the caller.
//
// The pipeline is intentionally idempotent so re-running it on an
// already-validated reply is a no-op. Validators return the (possibly
// modified) reply + a list of structured warnings, which the caller
// logs and we surface in /aligned-admin/provenance over time.

import type { BotResponseInputs } from './bot-engine.js';
import type { ScanCandidates } from './provenance-scanner.js';

export type ValidatorCategory =
  | 'image_marker_unknown_sku'
  | 'voice_capability_apology'
  | 'cart_total_demur'
  | 'booking_confirmation_without_marker'
  | 'handoff_false_positive'
  | 'welcome_repeat'
  | 'cart_marker_missing'
  | 'currency_subunit_conversion';

export interface ValidatorWarning {
  category: ValidatorCategory;
  detail: string;
  matchedText?: string;
}

export interface CartDraftSnapshot {
  items: Array<{
    name: string;
    sku: string | null;
    quantity: number;
    unitPriceMinor: number;
  }>;
  totalMinor: number;
  currency: string;
}

export interface ValidationContext {
  reply: string;
  userMessage: string;
  inputs: BotResponseInputs;
  kb: ScanCandidates;
  cartDraft: CartDraftSnapshot | null;
  bookingFormEnabled: boolean;
  shopFormEnabled: boolean;
  voiceMode: 'text' | 'voice';
  // Body of the previous outbound bot reply to this thread, if any.
  // Used by the welcome-repeat dedup to avoid sending the same welcome
  // text twice in a row.
  previousBotReply: string | null;
  // Configured greeting text (BotConfig.greeting). Used by welcome dedup.
  configuredGreeting: string | null;
}

export interface ValidationResult {
  reply: string;
  warnings: ValidatorWarning[];
}

// ---------- helpers --------------------------------------------------------

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function formatMoney(minor: number, currency: string): string {
  const code = currency.toUpperCase();
  const dec = code === 'KWD' || code === 'BHD' || code === 'OMR' || code === 'JOD' ? 3 : 2;
  const div = Math.pow(10, dec);
  return `${(minor / div).toFixed(dec)} ${code}`;
}

// ---------- currency subunit table ----------------------------------------
//
// Operator wants prices quoted ONLY in the configured 3-letter currency
// code (e.g. KWD), never in subunits. Different currencies use different
// subunit names + ratios, so we look up by org's `biz.currency`:
//   KWD / BHD / OMR / JOD — 1000 minor subunits per major (3 decimals)
//   AED / SAR / QAR / EGP / USD / EUR / GBP / INR / TRY — 100 minor (2 dec)
//
// When the LLM writes "150 fils" we rewrite to "0.150 KWD" (or the proper
// major-unit form for that currency). Tenant-agnostic — the org's
// configured currency picks the right row.
// Trailing terminator that works for BOTH Latin and Arabic scripts: the
// next char must be whitespace, end-of-string, or terminal punctuation.
// `\b` doesn't fire between two Arabic chars (neither side is in JS's
// word-char set), so we can't rely on it for the Arabic alternations.
const END = '(?=\\s|$|[.,!?؟،؛:;\\)\\]])';

const SUBUNIT_TABLE: Record<
  string,
  { regex: RegExp; perMajor: number }
> = {
  KWD: {
    regex: new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(?:fils?|فلس|فلوس)${END}`, 'gi'),
    perMajor: 1000,
  },
  BHD: {
    regex: new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(?:fils?|فلس|فلوس)${END}`, 'gi'),
    perMajor: 1000,
  },
  OMR: {
    regex: new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(?:ba[iy]sas?|بيسة|بيسات)${END}`, 'gi'),
    perMajor: 1000,
  },
  JOD: {
    regex: new RegExp(
      `\\b(\\d+(?:[.,]\\d+)?)\\s*(?:piastres?|qirsh|fils?|قرش|فلس)${END}`,
      'gi',
    ),
    perMajor: 1000,
  },
  AED: {
    regex: new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(?:fils?|فلس)${END}`, 'gi'),
    perMajor: 100,
  },
  SAR: {
    regex: new RegExp(
      `\\b(\\d+(?:[.,]\\d+)?)\\s*(?:halalas?|halalat|هللة|هللات)${END}`,
      'gi',
    ),
    perMajor: 100,
  },
  // QAR's subunit IS called "dirham" — yes, the same word as the
  // UAE major currency, hence the careful word-boundary regex.
  QAR: {
    regex: new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(?:dirhams?)${END}`, 'gi'),
    perMajor: 100,
  },
  EGP: {
    regex: new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(?:piastres?|قرش)${END}`, 'gi'),
    perMajor: 100,
  },
  USD: {
    regex: new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(?:cents?|¢)${END}`, 'gi'),
    perMajor: 100,
  },
  EUR: {
    regex: new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(?:cents?|¢)${END}`, 'gi'),
    perMajor: 100,
  },
  GBP: {
    regex: new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(?:pence|pennies|p)${END}`, 'gi'),
    perMajor: 100,
  },
  INR: {
    regex: new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(?:paise|paisa)${END}`, 'gi'),
    perMajor: 100,
  },
  TRY: {
    regex: new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(?:kuruş|kurus)${END}`, 'gi'),
    perMajor: 100,
  },
};

// ---------- validators -----------------------------------------------------

/**
 * Strip [IMAGE: <SKU>] markers whose SKU isn't in the candidate product
 * catalog. The image-attach path would otherwise send the wrong product
 * picture (real bug: bot mentioned Oreo but emitted Crepe SKU → customer
 * received the wrong image). Comparison is case-insensitive; matchers
 * uppercase both sides.
 */
function validateImageMarkers(reply: string, ctx: ValidationContext): {
  reply: string;
  warnings: ValidatorWarning[];
} {
  const warnings: ValidatorWarning[] = [];
  if (!reply.includes('[IMAGE:')) return { reply, warnings };

  const knownSkus = new Set(
    ctx.kb.products.map((p) => p.sku.toUpperCase()).filter((s) => s.length > 0),
  );
  // Allow no-op if the catalog is empty — gives operators a chance to
  // ship with [IMAGE:] markers before the catalog is fully populated.
  if (knownSkus.size === 0) return { reply, warnings };

  const out = reply.replace(/\[IMAGE:\s*([^\]]+?)\s*\]/g, (full, skuRaw: string) => {
    const sku = skuRaw.trim().toUpperCase();
    if (knownSkus.has(sku)) return full;
    warnings.push({
      category: 'image_marker_unknown_sku',
      detail: `Bot emitted [IMAGE: ${skuRaw}] but no candidate product has that SKU; marker dropped server-side`,
      matchedText: skuRaw,
    });
    return '';
  });
  return { reply: out, warnings };
}

/**
 * Strip phrases where the bot tells the customer it can't send voice
 * notes / is a "text chatbot" / etc. These are wrong in TWO ways:
 *   1. When voice mode is on, the platform IS synthesising every reply
 *      as a WhatsApp voice note. Saying "I can't" is a lie.
 *   2. Even when voice mode is off, the apology is unhelpful — the
 *      operator just turned it off, the customer doesn't need a meta-
 *      commentary; they want the answer.
 *
 * Multi-language: covers English, Arabic (MSA + Lebanese), French, Spanish.
 * Patterns are conservative: we only strip clear apology lines, not
 * neutral mentions of "voice" or "audio".
 */
function stripVoiceApologies(reply: string, _ctx: ValidationContext): {
  reply: string;
  warnings: ValidatorWarning[];
} {
  const warnings: ValidatorWarning[] = [];
  // Each pattern matches ~one sentence. We replace with empty string +
  // collapse adjacent whitespace at the end.
  const patterns: RegExp[] = [
    // English — "I can / can't" forms
    /\bI(?:'m| am)? (?:sorry,? )?(?:but )?(?:I )?can(?:'?| no)t (?:send|provide|make|do|share|produce|reply with|respond with)(?:[^.!?\n]*?)(?:voice note|voice notes|voice message|voice|audio)(?:[^.!?\n]*)[.!?]?/gi,
    /\bI(?:'?m| am)?\s+(?:just |only )?(?:a |an )?(?:text|text[- ]based)\s+(?:chat\s*bot|chatbot|bot|assistant|ai)[^.!?\n]*[.!?]?/gi,
    /\bI(?:'?m| am)?\s+not (?:able|capable)\s+(?:to|of)\s+(?:send|provide|make|share)[^.!?\n]*(?:voice|audio)[^.!?\n]*[.!?]?/gi,
    /\bI\s+don'?t\s+have\s+the\s+ability\s+to\s+(?:send|provide)[^.!?\n]*(?:voice|audio)[^.!?\n]*[.!?]?/gi,
    /\bI\s+can\s+only\s+(?:reply|respond|chat)\s+(?:in\s+)?text[^.!?\n]*[.!?]?/gi,
    // Arabic — common transliteration / MSA / Lebanese.
    // The middle [^.!?\n]*? is intentionally non-greedy so it backtracks
    // to allow the trailing (?:صوت|…) to match the SAME audio noun.
    /آسف[^.!?\n]*?(?:لا|ما)\s*(?:أستطيع|بقدر|بقدرش|أقدر)[^.!?\n]*?(?:صوت|صوتية|فويس|أوديو|الصوت)[^.!?\n]*[.!?]?/g,
    /أنا\s+(?:فقط\s+)?(?:بوت|روبوت)\s+نص[يي](?:ة|\b)[^.!?\n]*[.!?]?/g,
    // French
    /\bje (?:ne )?(?:peux pas|ne peux pas|ne suis pas capable de)[^.!?\n]*(?:vocal|audio|note vocale)[^.!?\n]*[.!?]?/gi,
    // Spanish
    /\bno (?:puedo|tengo la capacidad)[^.!?\n]*(?:voz|audio|nota de voz)[^.!?\n]*[.!?]?/gi,
  ];
  let out = reply;
  for (const re of patterns) {
    const before = out;
    out = out.replace(re, (match) => {
      warnings.push({
        category: 'voice_capability_apology',
        detail: 'Bot apology about voice capability stripped server-side',
        matchedText: match.trim(),
      });
      return '';
    });
    // Collapse whitespace runs left by the strip so the sentence flow
    // looks natural. Single pass after each pattern keeps the output
    // tidy without infinite-looping.
    if (out !== before) out = out.replace(/[ \t]{2,}/g, ' ').replace(/\n[ \t]+/g, '\n');
  }
  return { reply: out.trim(), warnings };
}

/**
 * If the user's last message asked for the cart total / running total
 * and the bot replied with a demurral ("I can't provide the total"),
 * append the deterministically-computed total from the draft cart.
 * Pre-LLM enrichment in bot-engine should make this case rare, but the
 * LLM still demurs sometimes and we never want a customer to be told
 * the bot doesn't know its own running cart.
 */
function injectCartTotalIfRequested(reply: string, ctx: ValidationContext): {
  reply: string;
  warnings: ValidatorWarning[];
} {
  const warnings: ValidatorWarning[] = [];
  if (!ctx.cartDraft || ctx.cartDraft.items.length === 0) return { reply, warnings };

  const userAskedTotal =
    /\b(?:total|grand total|how much|whats? the price|whats? the cost|كم\s*المجموع|كم\s*التكلفة|cuánto|combien)\b/i.test(
      ctx.userMessage,
    );
  if (!userAskedTotal) return { reply, warnings };

  const botDemurred =
    /\b(?:can(?:no|')t (?:provide|compute|calculate|give you))\b/i.test(reply) ||
    /\b(?:I (?:don'?t|do not) have (?:the|that) (?:total|price|info))\b/i.test(reply) ||
    /\b(?:unable to (?:provide|compute))\b/i.test(reply);

  if (!botDemurred) return { reply, warnings };

  const formatted = formatMoney(ctx.cartDraft.totalMinor, ctx.cartDraft.currency);
  const itemCount = ctx.cartDraft.items.reduce((s, i) => s + i.quantity, 0);
  const injection = `Actually — your running total is ${formatted} for ${itemCount} item${itemCount === 1 ? '' : 's'}. Want me to confirm the order?`;
  warnings.push({
    category: 'cart_total_demur',
    detail: `Bot refused total despite a non-empty draft cart (${formatted}); injected the computed total server-side`,
  });
  return { reply: `${reply.trim()}\n\n${injection}`, warnings };
}

/**
 * If the bot reply contains a confirmation phrase ("your appointment is
 * booked", "your session is confirmed", "all set, your booking is …")
 * AND the org has a booking form enabled AND no [BOOKING:] marker was
 * emitted, the bot is lying. Replace the confirmation phrase with a
 * conservative "let me double-check the details" question so we never
 * tell a customer their slot is booked when no DB row was written.
 */
function validateBookingFidelity(reply: string, ctx: ValidationContext): {
  reply: string;
  warnings: ValidatorWarning[];
} {
  const warnings: ValidatorWarning[] = [];
  if (!ctx.bookingFormEnabled) return { reply, warnings };
  if (/\[BOOKING:/i.test(reply)) return { reply, warnings };

  // Multi-language confirmation phrases. Anchored so we don't false-match
  // "to book a session" or "if you want to book" — those are intent
  // phrasings, not confirmations.
  const confirmRe =
    /\b(?:your |the )?(?:appointment|session|meeting|booking|reservation|consultation)\s+(?:is|has been|is now)\s+(?:booked|confirmed|reserved|scheduled|set|locked in)\b|\ball set,? (?:your |the )?(?:appointment|session|meeting|booking|reservation)|\bbooking confirmed\b|\bdone! (?:your |the )?(?:appointment|session|booking)/i;

  if (!confirmRe.test(reply)) return { reply, warnings };

  warnings.push({
    category: 'booking_confirmation_without_marker',
    detail:
      'Bot claimed an appointment was booked but emitted no [BOOKING:] marker; replacing confirmation with a re-confirm question so no fake booking is shown to the customer',
    matchedText: reply.match(confirmRe)?.[0] ?? undefined,
  });

  // Replace the confirmation phrasing with a re-confirm question. This
  // gives the operator a chance to collect the missing form fields on
  // the NEXT turn and emit a proper marker.
  const safeReply =
    'Before I lock that in — could you confirm the details one more time? I want to make sure I have everything right.';
  return { reply: safeReply, warnings };
}

/**
 * Strip [HANDOFF] from the reply if the customer's last message doesn't
 * actually contain explicit person-noun keywords. Stops typos like
 * "reset convo" / "start over" / "new chat" from accidentally
 * triggering an escalation to the human team.
 */
function validateHandoffMarker(reply: string, ctx: ValidationContext): {
  reply: string;
  warnings: ValidatorWarning[];
} {
  const warnings: ValidatorWarning[] = [];
  if (!/\[HANDOFF\]/i.test(reply)) return { reply, warnings };

  // Inclusive multi-language list of person-nouns + service phrases the
  // customer typically uses when asking to leave the bot. If NONE
  // appears in the user message, the marker is almost certainly a false
  // positive from the LLM.
  const handoffIntentRe =
    /\b(?:human|agent|person|representative|specialist|teammate|staff|operator|consultant|advisor|customer\s*service|customer\s*support|support\s*team|real\s*person|live\s*chat|إنسان|شخص|موظف|الدعم|خدمة\s*العملاء|persona|representante|asesor|servicio\s*al\s*cliente|humano|agente|conseiller|service\s*client)\b/i;

  if (handoffIntentRe.test(ctx.userMessage)) return { reply, warnings };

  // Reset-style intents that LLMs sometimes mistake for handoff.
  const resetIntentRe =
    /\b(?:reset|restart|start\s*over|start\s*again|new\s*(?:chat|convo|conversation)|begin\s*again|من\s*جديد|إعادة|nouveau|recommencer|reiniciar)\b/i;

  const looksLikeReset = resetIntentRe.test(ctx.userMessage);

  warnings.push({
    category: 'handoff_false_positive',
    detail: looksLikeReset
      ? 'User asked for a conversation reset, not a human handoff; [HANDOFF] marker stripped'
      : 'User message lacked any explicit human/agent/support keyword; [HANDOFF] marker stripped',
  });

  return { reply: reply.replace(/\[HANDOFF\]/gi, '').trim(), warnings };
}

/**
 * Rewrite currency subunits ("150 fils", "50 cents", "halala") into the
 * configured 3-letter currency code. Operators do not want the LLM
 * converting prices into subunits — only the catalog currency code
 * (KWD, USD, AED, …) should appear in customer-facing replies.
 *
 * Conversion is deterministic + tenant-agnostic: looks up the org's
 * `biz.currency`, finds the subunit regex + per-major ratio in
 * SUBUNIT_TABLE, replaces every match with the major-unit form using
 * the same decimal-places rule formatMoney uses.
 */
function validateCurrencySubunits(reply: string, ctx: ValidationContext): {
  reply: string;
  warnings: ValidatorWarning[];
} {
  const warnings: ValidatorWarning[] = [];
  const currency = ctx.kb.biz?.currency?.toUpperCase();
  if (!currency) return { reply, warnings };
  const entry = SUBUNIT_TABLE[currency];
  if (!entry) return { reply, warnings };

  // Same decimals rule as formatMoney — keep them in sync. 3 decimals for
  // KWD/BHD/OMR/JOD, 2 for everything else we know about today.
  const decimals =
    currency === 'KWD' || currency === 'BHD' || currency === 'OMR' || currency === 'JOD'
      ? 3
      : 2;

  // Reset lastIndex on the shared regex before each call since it's
  // declared at module scope with the /g flag.
  entry.regex.lastIndex = 0;
  const out = reply.replace(entry.regex, (match, numStr: string) => {
    const value = parseFloat(numStr.replace(',', '.'));
    if (!Number.isFinite(value)) return match;
    const major = value / entry.perMajor;
    const formatted = `${major.toFixed(decimals)} ${currency}`;
    warnings.push({
      category: 'currency_subunit_conversion',
      detail: `Bot wrote "${match.trim()}"; rewrote to "${formatted}" — the configured currency is ${currency} and operators want only the 3-letter code in replies.`,
      matchedText: match.trim(),
    });
    return formatted;
  });
  return { reply: out, warnings };
}

/**
 * Suppress repeat-welcome bubbles when the previous bot reply already
 * sent the operator's configured greeting. Mirrors the 2-min greeting-
 * image dedup so the text doesn't keep firing every time the customer
 * just says "hello" again.
 */
function dedupWelcomeText(reply: string, ctx: ValidationContext): {
  reply: string;
  warnings: ValidatorWarning[];
} {
  const warnings: ValidatorWarning[] = [];
  const greet = ctx.configuredGreeting?.trim();
  const prev = ctx.previousBotReply?.trim();
  if (!greet || greet.length < 4 || !prev) return { reply, warnings };

  // Does THIS reply look like a welcome? (overlaps with prev that also
  // looked like a welcome?)
  const greetHead = greet.slice(0, Math.min(greet.length, 30));
  const replyHasGreet = normalize(reply).includes(normalize(greetHead));
  const prevHadGreet = normalize(prev).includes(normalize(greetHead));

  if (!replyHasGreet || !prevHadGreet) return { reply, warnings };

  warnings.push({
    category: 'welcome_repeat',
    detail: 'Bot re-sent the configured greeting on a back-to-back exchange; replacing with a softer continuation',
  });
  return {
    reply: 'What can I help with next?',
    warnings,
  };
}

// ---------- pipeline -------------------------------------------------------

type Validator = (
  reply: string,
  ctx: ValidationContext,
) => { reply: string; warnings: ValidatorWarning[] };

export function validateReply(ctx: ValidationContext): ValidationResult {
  const allWarnings: ValidatorWarning[] = [];
  let reply = ctx.reply;

  // Order matters:
  //   1. Image markers — drop anything pointing at an unknown SKU.
  //   2. Voice apologies — multi-language sentence scrubber.
  //   3. Cart total — patch the demurral if the customer asked.
  //   4. Booking fidelity — never claim a booking we didn't write.
  //   5. Handoff strictness — strip marker when user didn't ask for human.
  //   6. Currency subunits — rewrite "150 fils" → "0.150 KWD".
  //   7. Welcome dedup — last, because it can replace the whole reply.
  const pipeline: Validator[] = [
    validateImageMarkers,
    stripVoiceApologies,
    injectCartTotalIfRequested,
    validateBookingFidelity,
    validateHandoffMarker,
    validateCurrencySubunits,
    dedupWelcomeText,
  ];

  for (const step of pipeline) {
    const out = step(reply, { ...ctx, reply });
    reply = out.reply;
    for (const w of out.warnings) allWarnings.push(w);
  }

  return { reply, warnings: allWarnings };
}
