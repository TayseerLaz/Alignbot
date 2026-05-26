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

// Groq is the only backend used for chat completions. Groq's /openai/v1
// endpoint is OpenAI-API-compatible so the same SDK works with just a
// baseURL + apiKey swap. Transcription stays on the OpenAI client below
// (gpt-4o-transcribe is materially better than Groq's Whisper for Arabic
// dialects + code-switched audio, which is most of our customer base).
//
// We deliberately do NOT fall back to OpenAI for chat. The earlier silent
// fallback hid a misconfig (GROQ_API_KEY missing) and the bot was running
// on gpt-4o-mini at 22-26s/turn instead of llama-3.3-70b at 3-8s/turn.
// If Groq is down, swap the key for an OpenAI-shaped key + base URL
// pointing at another OpenAI-compatible host (Together, Fireworks, etc.).
let _groqClient: OpenAI | null = null;
function groqClient(): OpenAI {
  if (!env.GROQ_API_KEY) {
    const err = new Error(
      'GROQ_API_KEY is not configured. Chat completions require Groq — ' +
        'add the key to .env / .env.production and restart. (Transcription ' +
        'still uses OPENAI_API_KEY; that key is separate.)',
    );
    (err as Error & { code?: string }).code = 'NO_KEY';
    throw err;
  }
  if (_groqClient) return _groqClient;
  _groqClient = new OpenAI({
    apiKey: env.GROQ_API_KEY,
    baseURL: env.GROQ_BASE_URL,
  });
  return _groqClient;
}

// Returns the client + model + a label for chat completions. Always Groq.
// Each call site stays provider-agnostic; provenance + logs include the
// label so an operator can see which provider/model actually ran.
function chatClientAndModel(): { client: OpenAI; model: string; provider: 'openai' | 'groq' } {
  return { client: groqClient(), model: env.GROQ_MODEL, provider: 'groq' };
}

export function isOpenAIConfigured(): boolean {
  return !!env.OPENAI_API_KEY;
}

// Phase 12 — surface the active chat provider + model so the provenance
// row + logs reflect what actually ran (not just env.OPENAI_MODEL).
export function activeChatProvider(): { provider: 'openai' | 'groq'; model: string } {
  const { provider, model } = chatClientAndModel();
  return { provider, model };
}

export const DAILY_TOKEN_LIMIT_PER_ORG = 200_000;

// gpt-4o-mini price points (USD per 1M tokens), used to estimate cost.
// We don't track input/output split per call; assume a 70/30 mix which
// is conservative-ish for our prompts (long system prompt + short reply).
export const PRICE_INPUT_PER_M = 0.15;
export const PRICE_OUTPUT_PER_M = 0.60;
export const PRICE_BLENDED_PER_M = 0.7 * PRICE_INPUT_PER_M + 0.3 * PRICE_OUTPUT_PER_M;

export function estimateCostUsd(tokens: number): number {
  return (tokens / 1_000_000) * PRICE_BLENDED_PER_M;
}

// ALIGNED admins get unlimited daily tokens. Same predicate the
// billing cap check uses — single source of truth.
async function isUnlimitedOrg(orgId: string): Promise<boolean> {
  const { isOrgUnlimited } = await import('./billing.js');
  return isOrgUnlimited(orgId);
}

async function consumeDailyTokens(orgId: string, tokens: number): Promise<boolean> {
  const redis = getRedis();
  const day = new Date().toISOString().slice(0, 10);
  const key = `aitokens:${orgId}:${day}`;
  // We still bump the counter for unlimited orgs so we can show their
  // usage / cost in the dashboard — we just don't enforce the cap.
  const used = await redis.incrby(key, tokens);
  if (used === tokens) {
    await redis.expire(key, 60 * 60 * 26);
  }
  if (await isUnlimitedOrg(orgId)) return true;
  return used <= DAILY_TOKEN_LIMIT_PER_ORG;
}

// Read-only helper for the dashboard widget. Returns today's running
// total (in tokens) for the given org. Never throws — falls back to 0.
export async function readDailyTokenUsage(orgId: string): Promise<{
  used: number;
  limit: number;
  unlimited: boolean;
  percentUsed: number;
  estCostUsd: number;
}> {
  const redis = getRedis();
  const day = new Date().toISOString().slice(0, 10);
  const key = `aitokens:${orgId}:${day}`;
  const raw = await redis.get(key);
  const used = raw ? Number(raw) : 0;
  const unlimited = await isUnlimitedOrg(orgId);
  const limit = DAILY_TOKEN_LIMIT_PER_ORG;
  const percentUsed = unlimited ? 0 : Math.min(100, Math.round((used / limit) * 100));
  return {
    used,
    limit,
    unlimited,
    percentUsed,
    estCostUsd: estimateCostUsd(used),
  };
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

  const { client: c, model } = chatClientAndModel();
  const res = await c.chat.completions.create({
    model,
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

// Speech-to-text. Used to transcribe inbound WhatsApp voice notes so
// the AI chatbot can understand and reply to them.
//
// Default model is `gpt-4o-transcribe` (OpenAI's best transcription
// model — materially better than the original whisper-1 on Arabic
// dialects + code-switched audio). Operators can switch the model via
// the OPENAI_TRANSCRIBE_MODEL env var without a code push if needed.
//
// API supports up to 25 MB per file in mp3 / mp4 / mpeg / mpga / m4a /
// wav / webm / ogg / flac. WhatsApp voice notes arrive as audio/ogg
// with Opus — well inside the supported set.
//
// Cost rough-cut: ~$0.006 / minute on gpt-4o-transcribe. We pre-charge
// ~600 "tokens" (≈ 1 chatbot-reply equivalent) against the daily org
// budget so a flood of long voice notes still trips the cap.
export interface TranscribeArgs {
  organizationId: string;
  bytes: Buffer;
  filename: string;
  mimeType?: string;
}

export type TranscribeProvider = 'openai' | 'groq';

export async function transcribeAudio(args: TranscribeArgs & { provider?: TranscribeProvider }): Promise<{
  text: string;
  // Detected language (ISO code). gpt-4o-transcribe doesn't return this
  // — only whisper-1 with response_format='verbose_json' did. Kept on
  // the return type so callers can stay forward-compatible; downstream
  // code never relied on it being non-null. Currently always null on
  // gpt-4o-transcribe, populated only when the env var is set to
  // 'whisper-1'.
  language: string | null;
  // Which provider actually ran the transcription — recorded in logs +
  // provenance so we can monitor the routing decision in production.
  provider: TranscribeProvider;
}> {
  const ok = await consumeDailyTokens(args.organizationId, 600);
  if (!ok) {
    const err = new Error('Daily AI token budget exceeded — voice transcription paused.');
    (err as Error & { code?: string }).code = 'TOKEN_BUDGET_EXCEEDED';
    throw err;
  }

  const provider: TranscribeProvider = args.provider === 'groq' && env.GROQ_API_KEY ? 'groq' : 'openai';

  if (provider === 'groq') {
    // Groq's Whisper Large v3 (Turbo by default) runs at ~10× OpenAI's
    // speed on the same audio. Good on English + reasonable on European
    // languages; weaker on Gulf/Levant Arabic dialect than OpenAI's
    // gpt-4o-transcribe. Callers route by language signal — Arabic gets
    // OpenAI, English/French/Spanish gets Groq.
    const groq = groqClient();
    const blob = new Blob([new Uint8Array(args.bytes)], { type: args.mimeType ?? 'audio/ogg' });
    const file = new File([blob], args.filename, { type: args.mimeType ?? 'audio/ogg' });
    const res = (await groq.audio.transcriptions.create({
      file,
      model: env.GROQ_WHISPER_MODEL,
      response_format: 'json',
      prompt: 'Customer-service voice note. English / French / Spanish.',
    })) as { text?: string; language?: string };
    return {
      text: (res.text ?? '').trim(),
      language: res.language ?? null,
      provider: 'groq',
    };
  }

  const c = client();
  const blob = new Blob([new Uint8Array(args.bytes)], { type: args.mimeType ?? 'audio/ogg' });
  const file = new File([blob], args.filename, { type: args.mimeType ?? 'audio/ogg' });
  const model = env.OPENAI_TRANSCRIBE_MODEL;
  // gpt-4o-transcribe + gpt-4o-mini-transcribe ONLY support
  // response_format = 'json' or 'text'. verbose_json is whisper-1-only.
  // We pick json regardless so the caller gets a uniform { text } shape;
  // language is no longer returned upstream on the gpt-4o models.
  const isWhisper = model === 'whisper-1';
  // The `prompt` hint biases the model to preserve dialectal Arabic
  // vocabulary rather than round-tripping it to MSA. Same hint works
  // for both whisper-1 and gpt-4o-transcribe. English / French /
  // Spanish transcripts are unaffected.
  const res = (await c.audio.transcriptions.create({
    file,
    model,
    response_format: isWhisper ? 'verbose_json' : 'json',
    prompt:
      'Customer-service voice note. Possible Arabic dialects include Lebanese / Levantine: شو، كيفك، بدي، عم. Egyptian: إزيك، عايز، فين. Gulf: شلونك، أبغى. Also English, French, Spanish.',
  })) as { text?: string; language?: string };
  return {
    text: (res.text ?? '').trim(),
    language: res.language ?? null,
    provider: 'openai',
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

  const { client: c, model } = chatClientAndModel();
  const res = await c.chat.completions.create({
    model,
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
