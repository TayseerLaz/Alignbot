// Thin wrapper around the Anthropic SDK so route + worker code stays
// short and so we centralise prompt-caching + token-cap policy here.
//
// Strategy:
//   - System prompt is sent with `cache_control: { type: "ephemeral" }` so
//     the same KB blob doesn't re-bill on every turn within a 5-minute
//     window. (This costs roughly 1.25× write but every cached re-use
//     reads at 0.10×, so amortises after ~3 uses.)
//   - Per-org daily token budget is enforced in Redis to bound spend.
//   - When the env var is missing we throw a SERVICE_UNAVAILABLE so
//     callers can 503 cleanly.
import Anthropic from '@anthropic-ai/sdk';

import { env } from './env.js';
import { getRedis } from './redis.js';

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    const err = new Error('ANTHROPIC_API_KEY is not configured.');
    (err as Error & { code?: string }).code = 'NO_KEY';
    throw err;
  }
  if (_client) return _client;
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

export function isAnthropicConfigured(): boolean {
  return !!env.ANTHROPIC_API_KEY;
}

const DAILY_TOKEN_LIMIT_PER_ORG = 200_000;

async function consumeDailyTokens(orgId: string, tokens: number): Promise<boolean> {
  const redis = getRedis();
  const day = new Date().toISOString().slice(0, 10);
  const key = `aitokens:${orgId}:${day}`;
  const used = await redis.incrby(key, tokens);
  if (used === tokens) {
    await redis.expire(key, 60 * 60 * 26);
  }
  return used <= DAILY_TOKEN_LIMIT_PER_ORG;
}

interface CompleteArgs {
  organizationId: string;
  systemPrompt: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
  temperature?: number;
  cacheSystem?: boolean;
}

export async function complete(args: CompleteArgs): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  // Pre-charge the budget pessimistically (estimate input length / 4 chars
  // per token, plus the maxTokens we're requesting). Final accounting on
  // the response is best-effort.
  const estIn = Math.ceil(args.systemPrompt.length / 4)
    + args.messages.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0);
  const estOut = args.maxTokens ?? 1024;
  const ok = await consumeDailyTokens(args.organizationId, estIn + estOut);
  if (!ok) {
    const err = new Error('Daily AI token budget exceeded for this organization.');
    (err as Error & { code?: string }).code = 'TOKEN_BUDGET_EXCEEDED';
    throw err;
  }

  const c = client();
  // Cache the system prompt when it's > ~1KB and the caller asks for it.
  const systemBlocks =
    args.cacheSystem && args.systemPrompt.length > 1024
      ? [
          {
            type: 'text' as const,
            text: args.systemPrompt,
            cache_control: { type: 'ephemeral' as const },
          },
        ]
      : args.systemPrompt;

  const res = await c.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: args.maxTokens ?? 1024,
    temperature: args.temperature ?? 0.4,
    system: systemBlocks as never,
    messages: args.messages,
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return {
    text,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  };
}
