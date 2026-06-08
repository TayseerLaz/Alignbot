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
