// Worker-side Anthropic client. Same shape as apps/api/src/lib/anthropic.ts
// — duplicated rather than imported because the worker is a separate
// pnpm workspace and we don't want to depend on the api package.
import Anthropic from '@anthropic-ai/sdk';

import { env } from './env.js';

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured.');
  }
  if (_client) return _client;
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

export function isAnthropicConfigured(): boolean {
  return !!env.ANTHROPIC_API_KEY;
}

export async function workerComplete(args: {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const c = client();
  const res = await c.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: args.maxTokens ?? 2048,
    temperature: args.temperature ?? 0.3,
    system: args.systemPrompt,
    messages: [{ role: 'user', content: args.userPrompt }],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
}
