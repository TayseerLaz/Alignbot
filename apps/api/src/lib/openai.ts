// Thin wrapper around the OpenAI SDK so route + worker code stays
// short and so we centralise token-cap policy here.
//
// Notes:
//   - OpenAI auto-caches identical prompt prefixes >1024 tokens, so the
//     long system prompt (KB blob) doesn't need an explicit cache flag.
//   - Per-org daily token budget is enforced in Redis to bound spend.
//   - When the env var is missing we throw a SERVICE_UNAVAILABLE so
//     callers can 503 cleanly.
import OpenAI from 'openai';

import { env } from './env.js';
import { getRedis } from './redis.js';

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!env.OPENAI_API_KEY) {
    const err = new Error('OPENAI_API_KEY is not configured.');
    (err as Error & { code?: string }).code = 'NO_KEY';
    throw err;
  }
  if (_client) return _client;
  _client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return _client;
}

export function isOpenAIConfigured(): boolean {
  return !!env.OPENAI_API_KEY;
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
  const res = await c.chat.completions.create({
    model: env.OPENAI_MODEL,
    max_tokens: args.maxTokens ?? 1024,
    temperature: args.temperature ?? 0.4,
    messages: [
      { role: 'system', content: args.systemPrompt },
      ...args.messages,
    ],
  });

  const text = (res.choices[0]?.message.content ?? '').trim();

  return {
    text,
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
  };
}

// Strict JSON-mode completion. The LLM is asked to return a single JSON
// object. Used by the booking extractor fallback so we don't depend on
// the conversational LLM remembering to emit our [BOOKING: {...}] marker.
export async function completeJson<T = unknown>(args: CompleteArgs): Promise<T> {
  const estIn = Math.ceil(args.systemPrompt.length / 4)
    + args.messages.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0);
  const estOut = args.maxTokens ?? 400;
  const ok = await consumeDailyTokens(args.organizationId, estIn + estOut);
  if (!ok) {
    const err = new Error('Daily AI token budget exceeded for this organization.');
    (err as Error & { code?: string }).code = 'TOKEN_BUDGET_EXCEEDED';
    throw err;
  }

  const c = client();
  const res = await c.chat.completions.create({
    model: env.OPENAI_MODEL,
    max_tokens: args.maxTokens ?? 400,
    temperature: args.temperature ?? 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: args.systemPrompt },
      ...args.messages,
    ],
  });

  const text = (res.choices[0]?.message.content ?? '').trim();
  return JSON.parse(text) as T;
}
