// Voice prompt compiler — turns one tenant's BotData into a single system
// prompt for the OpenAI Realtime speech model running inside the Aseer-time
// voice media gateway.
//
// Differences from the WhatsApp prompt in bot-engine.ts, on purpose:
//   - One static prompt per tenant (no per-message top-K packing): the
//     realtime session is configured ONCE at call start, so everything the
//     bot may need must be in the prompt up front. Catalog is capped hard.
//   - Phone-call style rules: short spoken sentences, no lists, no emoji,
//     no markdown, no [IMAGE:]/[BOOKING:]/[CART:] markers — none of those
//     can be rendered on a voice call.
//   - The escape hatch is the voicebot's `transfer_to_human` tool, so the
//     prompt instructs the model to use it instead of WhatsApp escalation
//     phrasing.
//
// Same non-negotiables as bot-engine.ts: never invent products, prices, or
// facts not present in the data, and never put literal example product names
// in instruction text (gpt models copy examples into real replies).
//
// All tenant-authored text is passed through clean()/cleanBlock() — HTML
// stripped (same defense the read API applies via stripHtmlForBot) and
// newlines collapsed on single-line fields so catalog data cannot fabricate
// instruction lines — and per-field caps + a total budget keep the compiled
// prompt well inside the realtime session's context.
import type { BotData } from './bot-engine.js';
import { formatMoney, formatOperatingHours } from './bot-engine.js';
import { stripHtmlForBot } from '../modules/catalog/shared.js';

// Spoken-style variants of bot-engine's PERSONALITY_DESCRIPTIONS (those
// mention emoji + lists, which don't exist on a call).
const VOICE_PERSONALITY: Record<string, string> = {
  formal: 'Professional and precise. Full sentences, no slang.',
  casual: 'Conversational and relaxed. Contractions are fine.',
  friendly: 'Warm and helpful. Sound genuinely glad to help.',
  clinical: 'Concise and factual. No marketing language.',
  professional: 'Polite and direct. Clarity over warmth.',
};

// Mirrors bot-engine's LANGUAGE_NAMES so a tenant configured for, say,
// French is not silently forced to English.
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ar: 'Arabic',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  tr: 'Turkish',
  pt: 'Portuguese',
  it: 'Italian',
  ru: 'Russian',
  hi: 'Hindi',
  ur: 'Urdu',
  zh: 'Chinese',
};

// gatherBotData caps its queries at 30 products / 30 services / 30 FAQs /
// 10 policies (bot-engine.ts `take:` clauses) — these compile-side caps only
// matter if those queries ever widen, but keeping them aligned documents the
// real bound.
const MAX_PRODUCTS = 30;
const MAX_FAQS = 30;

// Per-field character caps (phone prompts need facts, not essays) and the
// total instructions budget. gpt-realtime sessions hold ~32k tokens; staying
// around 24k CHARS (~6k tokens) leaves the bulk of the window for the live
// conversation.
const CAP = {
  tagline: 200,
  about: 1200,
  shortDescription: 200,
  faqQuestion: 300,
  faqAnswer: 600,
  policy: 800,
  personality: 500,
  greeting: 300,
  fallback: 300,
};
const TOTAL_BUDGET = 24_000;

// Control chars (C0 except tab/newline) that could smuggle formatting into
// the prompt. Expressed as unicode escapes to keep this source pure ASCII.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

// Single-line tenant text: strip HTML, collapse ALL whitespace (incl.
// newlines — a value spanning lines could otherwise mimic instruction
// bullets), truncate.
function clean(input: string | null | undefined, max: number): string | null {
  const stripped = stripHtmlForBot(input);
  if (!stripped) return null;
  const flat = stripped.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Multi-line tenant text (about, policies): strip HTML, drop control chars,
// collapse blank-line runs, truncate.
function cleanBlock(input: string | null | undefined, max: number): string | null {
  const stripped = stripHtmlForBot(input);
  if (!stripped) return null;
  const text = stripped
    .replace(/\r/g, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function languageRule(languages: string | null | undefined): string {
  const codes = [
    ...new Set(
      (languages ?? 'en')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((c) => LANGUAGE_NAMES[c]),
    ),
  ];
  if (codes.length === 0) codes.push('en');
  const hasAr = codes.includes('ar');
  const hasEn = codes.includes('en');

  if (hasAr && hasEn && codes.length === 2) {
    return (
      'Languages: speak ONLY English or Arabic — never any other language under any circumstance. ' +
      "Mirror the caller's Arabic dialect (Lebanese, Gulf, Egyptian, or MSA — match what you hear). " +
      'Start in English. If the caller speaks Arabic, switch and continue in Arabic; if they switch back, follow them.'
    );
  }
  if (codes.length === 1) {
    const only = LANGUAGE_NAMES[codes[0]!]!;
    return (
      `Languages: speak ONLY ${only} — never any other language under any circumstance.` +
      (codes[0] === 'ar' ? " Mirror the caller's dialect (Lebanese, Gulf, Egyptian, or MSA)." : '')
    );
  }
  const names = codes.map((c) => LANGUAGE_NAMES[c]!).join(', ');
  return (
    `Languages: speak ONLY one of: ${names} — never any other language under any circumstance. ` +
    "Start in the first listed language and follow the caller's switches between the listed languages." +
    (hasAr ? " For Arabic, mirror the caller's dialect." : '')
  );
}

export interface CompiledVoiceConfig {
  instructions: string;
  greeting: string | null;
  languages: string;
  businessName: string | null;
}

export function compileVoiceConfig(data: BotData, orgName: string): CompiledVoiceConfig {
  const { config, biz, faqs, policies, locations, contactChannels, services } = data;
  const businessName = clean(biz?.legalName, 120) || clean(orgName, 120) || 'this business';
  // Org currency wins over the per-row column, same as bot-engine
  // (formatMoney(p.priceMinor, biz?.currency ?? p.currency)) — rows default
  // to "USD" while imports often only set the org currency, and minor-unit
  // math differs (KWD/BHD/OMR/JOD are 1000s, not 100s).
  const orgCurrency = biz?.currency ?? null;

  const personalityKey = config?.personality ?? config?.detectedTone ?? 'friendly';
  const personality =
    clean(config?.customPersonality, CAP.personality) ||
    VOICE_PERSONALITY[personalityKey] ||
    VOICE_PERSONALITY.friendly!;

  const sections: string[] = [];

  sections.push(
    `You are the AI phone receptionist for ${businessName}. You are on a live phone call with a customer.`,
  );

  sections.push(
    [
      'STRICT CALL RULES:',
      `- Tone: ${personality}`,
      `- ${languageRule(config?.languages)}`,
      '- Keep every reply under 25 words. Natural spoken sentences only — no lists, no bullet points, no emoji, no markdown, nothing that only works in writing.',
      '- Greet ONCE at the very start of the call and never re-greet.',
      '- Only state facts found in the BUSINESS DATA below. If the answer is not there, say you will have someone follow up and offer to take the caller\'s name and number — never invent or guess products, prices, hours, or policies.',
      '- When taking an order, booking, or message, read back the key details (name, number, time, items) before confirming.',
      '- Never ask for card numbers or payment details. If the caller wants to pay, say a payment link will be sent.',
      '- Human transfer: if the caller asks for a person, agent, or human, OR has a complaint, refund, or sensitive issue, OR asks something outside the BUSINESS DATA — say one short sentence like "Connecting you to one of our team now, please hold" in their language, then immediately call the transfer_to_human function. Do not keep chatting.',
    ].join('\n'),
  );

  // Ordering — only advertised when the tenant has the shop enabled. The
  // submit_order function is defined on the voicebot side; here we tell the
  // model HOW and WHEN to use it.
  if (data.shopForm) {
    sections.push(
      [
        'TAKING ORDERS (you can place orders for callers):',
        '- Take orders ONLY for items in the menu under BUSINESS DATA, and quote prices ONLY from there. If a caller asks for something not on the menu, say it is unavailable — never invent items or prices.',
        '- Collect: each item and its quantity, the customer\'s name, and whether it is pickup or delivery (get the address if delivery).',
        '- When the caller says that is everything, READ BACK the full order — every item with its quantity, the name, pickup or delivery, and the total — and ask them to confirm.',
        '- ONLY after they clearly confirm, call the submit_order function with the items (each item\'s name and quantity), the customer name, and the fulfillment details. Do NOT say the order is placed until the function returns a confirmation.',
        '- After the function confirms, tell the caller the order is in and read the total. For payment, say a payment link will be sent to their WhatsApp, or they can pay on pickup or delivery. Never take card or payment-card numbers.',
      ].join('\n'),
    );
  }

  // ---- BUSINESS DATA -------------------------------------------------------
  const dataLines: string[] = ['BUSINESS DATA (the only source of truth):'];

  if (biz) {
    const bizLines: string[] = [`Business: ${businessName}`];
    const tagline = clean(biz.tagline, CAP.tagline);
    if (tagline) bizLines.push(`Tagline: ${tagline}`);
    const about = cleanBlock(biz.about, CAP.about);
    if (about) bizLines.push(`About: ${about}`);
    if (biz.websiteUrl) bizLines.push(`Website: ${clean(biz.websiteUrl, 200)}`);
    const hours = formatOperatingHours(biz.operatingHours);
    if (hours) bizLines.push(`Opening hours:\n${hours}`);
    dataLines.push(bizLines.join('\n'));
  }

  if (locations.length > 0) {
    dataLines.push(
      'Locations:\n' +
        locations
          .map((l) => {
            const addr = [l.addressLine1, l.addressLine2, l.city, l.region, l.country]
              .filter(Boolean)
              .join(', ');
            const bits = [
              clean(l.name, 80),
              clean(addr, 200),
              l.phone ? `phone ${clean(l.phone, 40)}` : null,
            ].filter(Boolean);
            return `- ${bits.join(' — ')}${l.isPrimary ? ' (main branch)' : ''}`;
          })
          .join('\n'),
    );
  }

  if (contactChannels.length > 0) {
    dataLines.push(
      'Contact channels:\n' +
        contactChannels
          .map((c) => `- ${clean(c.label ?? c.kind, 60)}: ${clean(c.value, 120)}`)
          .join('\n'),
    );
  }

  if (data.products.length > 0) {
    const capped = data.products.slice(0, MAX_PRODUCTS);
    dataLines.push(
      `Products / menu (${capped.length} items; if a caller asks for something not listed, treat it as unknown — do not guess):\n` +
        capped
          .map((p) => {
            const price = formatMoney(p.priceMinor, orgCurrency ?? p.currency);
            const variants = p.variants
              .map(
                (v) =>
                  `${clean(v.name, 60)}${v.priceMinor != null ? ` ${formatMoney(v.priceMinor, orgCurrency ?? p.currency)}` : ''}`,
              )
              .join(', ');
            const desc = clean(p.shortDescription, CAP.shortDescription);
            return [
              `- ${clean(p.name, 120)}`,
              price ? ` — ${price}` : '',
              p.categoryName ? ` (${clean(p.categoryName, 60)})` : '',
              variants ? ` [${variants}]` : '',
              desc ? `: ${desc}` : '',
            ].join('');
          })
          .join('\n'),
    );
  }

  if (services.length > 0) {
    dataLines.push(
      'Services:\n' +
        services
          .map((s) => {
            const price = formatMoney(s.basePriceMinor, orgCurrency ?? s.currency);
            const desc = clean(s.shortDescription, CAP.shortDescription);
            return [
              `- ${clean(s.name, 120)}`,
              price ? ` — from ${price}` : '',
              s.durationMinutes ? ` (${s.durationMinutes} min)` : '',
              desc ? `: ${desc}` : '',
            ].join('');
          })
          .join('\n'),
    );
  }

  let faqSection: string | null = null;
  if (faqs.length > 0) {
    faqSection =
      'FAQs:\n' +
      faqs
        .slice(0, MAX_FAQS)
        .map((f) => `Q: ${clean(f.question, CAP.faqQuestion)}\nA: ${cleanBlock(f.answer, CAP.faqAnswer)}`)
        .join('\n');
    dataLines.push(faqSection);
  }

  let policySection: string | null = null;
  if (policies.length > 0) {
    policySection =
      'Policies:\n' +
      policies
        .map((p) => `- ${clean(p.title, 100)}: ${cleanBlock(p.content, CAP.policy)}`)
        .join('\n');
    dataLines.push(policySection);
  }

  sections.push(dataLines.join('\n\n'));

  // Operator-authored escalation fallback wording, if any.
  const escalation = (config?.escalationRules ?? {}) as Record<string, unknown>;
  const fallback =
    typeof escalation.fallback === 'string' ? clean(escalation.fallback, CAP.fallback) : null;
  if (fallback) {
    sections.push(`When you cannot help and no human is reachable, say: "${fallback}"`);
  }

  // Total budget: drop the heaviest optional sections (policies first, then
  // FAQs) rather than serving a prompt that crowds out the conversation.
  let instructions = sections.join('\n\n');
  if (instructions.length > TOTAL_BUDGET && policySection) {
    instructions = instructions.replace(`\n\n${policySection}`, '');
  }
  if (instructions.length > TOTAL_BUDGET && faqSection) {
    instructions = instructions.replace(`\n\n${faqSection}`, '');
  }
  if (instructions.length > TOTAL_BUDGET) {
    instructions = instructions.slice(0, TOTAL_BUDGET);
  }

  // Voice ALWAYS opens in English, then mirrors the caller (per the language
  // rule). The tenant's BotConfig.greeting is authored for chat (often Arabizi
  // / emoji), which would force a non-English open and can't be spoken cleanly,
  // so we synthesize a short spoken English greeting from the business name
  // instead. (WhatsApp keeps its own greeting — this only affects voice.)
  const greeting = `Hello, thanks for calling ${businessName}. How can I help you today?`;

  return {
    instructions,
    greeting,
    languages: config?.languages ?? 'en',
    businessName,
  };
}
