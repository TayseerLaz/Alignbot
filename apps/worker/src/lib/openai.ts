// Worker-side OpenAI client. Same shape as apps/api/src/lib/openai.ts
// — duplicated rather than imported because the worker is a separate
// pnpm workspace and we don't want to depend on the api package.
import OpenAI from 'openai';

import { env } from './env.js';

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }
  if (_client) return _client;
  _client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return _client;
}

export function isOpenAIConfigured(): boolean {
  return !!env.OPENAI_API_KEY;
}

export async function workerComplete(args: {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const c = client();
  const res = await c.chat.completions.create({
    model: env.OPENAI_MODEL,
    max_tokens: args.maxTokens ?? 2048,
    temperature: args.temperature ?? 0.3,
    messages: [
      { role: 'system', content: args.systemPrompt },
      { role: 'user', content: args.userPrompt },
    ],
  });
  const text = (res.choices[0]?.message.content ?? '').trim();
  return {
    text,
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
  };
}
