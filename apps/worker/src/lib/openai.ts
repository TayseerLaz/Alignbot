// Worker-side chat-completion client. Mirrors the API: chat goes to Groq
// (fast LPU inference), transcription would stay on OpenAI if the worker
// ever needed it (the only worker chat path right now is crawl analysis).
//
// The OpenAI SDK works against Groq's /openai/v1 endpoint with just a
// baseURL + apiKey swap — same client class, same call signature.
import OpenAI from 'openai';

import { env } from './env.js';

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!env.GROQ_API_KEY) {
    throw new Error(
      'GROQ_API_KEY is not configured. Worker chat completions (crawl ' +
        'analysis) require Groq — add the key to .env / .env.production ' +
        'and restart.',
    );
  }
  if (_client) return _client;
  _client = new OpenAI({ apiKey: env.GROQ_API_KEY, baseURL: env.GROQ_BASE_URL });
  return _client;
}

// True when either Groq is keyed (preferred) — keeps `isOpenAIConfigured()`
// callers (crawl.ts gates its AI step on this) working unchanged. We keep
// the historical name to avoid touching every call site.
export function isOpenAIConfigured(): boolean {
  return !!env.GROQ_API_KEY;
}

export async function workerComplete(args: {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const c = client();
  const res = await c.chat.completions.create({
    model: env.GROQ_MODEL,
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
