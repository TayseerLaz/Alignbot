// Per-provider, per-model pricing — used to convert prompt/completion
// token counts (stored on every MessageProvenance row) into a dollar
// figure shown in /aligned-admin. All rates are USD per 1M tokens.
//
// Source of truth: each provider's public pricing page as of the most
// recent code-review pass. If a provider changes pricing, edit this
// table and re-deploy — no schema change, no migration. Operators
// reviewing historical bills should remember the rate applies to the
// time-of-call, not retroactively (we don't snapshot rates per row).

export type ChatModelKey =
  | 'groq:llama-3.3-70b-versatile'
  | 'openai:gpt-4o-mini'
  | 'openai:gpt-4o'
  | 'anthropic:claude-haiku-4-5'
  | 'anthropic:claude-sonnet-4-6'
  | 'anthropic:claude-opus-4-8';

interface Rate {
  /** Input rate, USD per 1M tokens. */
  inUsdPerM: number;
  /** Output rate, USD per 1M tokens. */
  outUsdPerM: number;
}

export const CHAT_PRICING: Record<ChatModelKey, Rate> = {
  'groq:llama-3.3-70b-versatile': { inUsdPerM: 0.59, outUsdPerM: 0.79 },
  'openai:gpt-4o-mini': { inUsdPerM: 0.15, outUsdPerM: 0.6 },
  'openai:gpt-4o': { inUsdPerM: 2.5, outUsdPerM: 10 },
  'anthropic:claude-haiku-4-5': { inUsdPerM: 1, outUsdPerM: 5 },
  'anthropic:claude-sonnet-4-6': { inUsdPerM: 3, outUsdPerM: 15 },
  'anthropic:claude-opus-4-8': { inUsdPerM: 15, outUsdPerM: 75 },
};

/**
 * Convert a (modelLabel, promptTokens, completionTokens) triple into a
 * cost in USD. `modelLabel` is whatever the bot-engine recorded in
 * MessageProvenance.model — "groq:<model>" or "<model>" depending on
 * provider. Returns 0 for any unknown model so historical rows from
 * before the dispatch existed don't break aggregation queries.
 */
export function tokensToUsd(
  modelLabel: string,
  promptTokens: number,
  completionTokens: number,
): number {
  // Normalise: bot-engine uses bare "gpt-4o-mini" (no provider prefix)
  // for legacy OpenAI calls. Map those to the openai:* keys.
  const key = normaliseModelKey(modelLabel);
  const rate = key ? CHAT_PRICING[key] : null;
  if (!rate) return 0;
  return (
    (promptTokens / 1_000_000) * rate.inUsdPerM +
    (completionTokens / 1_000_000) * rate.outUsdPerM
  );
}

// ---------------------------------------------------------------------------
// Non-LLM cost rates — voice transcription, WhatsApp messaging, object storage.
// These let the billing page show a full "what this tenant costs us" picture.
// All are best-effort estimates (LABEL them "est." in the UI): we don't store
// audio duration, Meta's per-message price is country/category dependent, and
// storage is billed monthly by Wasabi. Edit + redeploy if rates change.
// ---------------------------------------------------------------------------
export const COST_RATES = {
  /**
   * Estimated USD per inbound voice-note transcription. We route most English
   * notes to Groq Whisper (~$0.00185/min) and Arabic to OpenAI gpt-4o-transcribe
   * (~$0.006/min). With a typical ~20s note this averages out to a small flat
   * figure — used only when we can't measure duration.
   */
  transcriptionUsd: 0.003,
  /**
   * Estimated USD per outbound WhatsApp message (broadcast / template send).
   * Meta bills per conversation by country + category; this is a blended
   * marketing-conversation estimate. Adjust to your dominant market.
   */
  whatsappMessageUsd: 0.03,
  /** Wasabi storage, USD per GB per month (≈ $6.99/TB/mo). */
  storageUsdPerGbMonth: 0.0068,
} as const;

/** Estimated transcription cost for a count of voice notes. */
export function transcriptionCostUsd(count: number): number {
  return Math.max(0, count) * COST_RATES.transcriptionUsd;
}

/** Estimated WhatsApp messaging cost for a count of outbound messages. */
export function whatsappMessageCostUsd(count: number): number {
  return Math.max(0, count) * COST_RATES.whatsappMessageUsd;
}

/** Estimated monthly storage cost for a number of stored bytes. */
export function storageCostUsd(bytes: number): number {
  return (Math.max(0, bytes) / 1_000_000_000) * COST_RATES.storageUsdPerGbMonth;
}

function normaliseModelKey(modelLabel: string): ChatModelKey | null {
  const m = modelLabel.toLowerCase().trim();
  if (m.includes('groq:') || m.includes('llama-3.3-70b')) {
    return 'groq:llama-3.3-70b-versatile';
  }
  if (m.includes('gpt-4o-mini')) return 'openai:gpt-4o-mini';
  if (m.includes('gpt-4o')) return 'openai:gpt-4o';
  if (m.includes('haiku')) return 'anthropic:claude-haiku-4-5';
  if (m.includes('opus')) return 'anthropic:claude-opus-4-8';
  if (m.includes('sonnet') || m.includes('claude')) return 'anthropic:claude-sonnet-4-6';
  return null;
}

// Per-plan model label — what the bot-engine should record on
// MessageProvenance.model for downstream cost roll-ups. Keep aligned
// with the dispatch in lib/openai.ts complete() to avoid drift.
export function modelLabelForPlan(plan: 'basic' | 'middle' | 'max' | 'ultra'): string {
  switch (plan) {
    case 'ultra':
      // The final grounded reply (the cost driver) runs on Sonnet. The
      // ultra plan's auxiliary Haiku passes are metered + recorded
      // separately under the anthropic:claude-haiku-4-5 key.
      return 'anthropic:claude-sonnet-4-6';
    case 'max':
      return 'anthropic:claude-sonnet-4-6';
    case 'middle':
      return 'openai:gpt-4o';
    case 'basic':
    default:
      return 'groq:llama-3.3-70b-versatile';
  }
}
