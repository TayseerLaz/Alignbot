// Worker-side chat-completion client. Primary path goes to Groq
// (llama-3.3-70b-versatile, LPU inference) and falls back to OpenAI
// gpt-4o-mini ONLY when Groq returns 429 — the daily-token-cap case
// that hit prod on 2026-06-01 and silently zeroed every crawl's
// extraction. Reintroducing OpenAI was an explicit user decision
// after we previously removed it; see chat 2026-06-01.
//
// Why not always-OpenAI: Groq is ~30x faster on the same model class
// at our scale and the bot's prompt is tuned to llama-3.3-70b.
// Why not fail-on-429: the operator-visible symptom (empty crawl
// review panel) is much worse than a slightly more expensive call
// served by gpt-4o-mini for the next ~1h while the Groq bucket rolls.
//
// The OpenAI SDK works against Groq's /openai/v1 endpoint with just a
// baseURL + apiKey swap — same client class, same call signature,
// so the fallback retries the EXACT request shape (response_format,
// max_tokens, temperature, messages) against a different host.
import OpenAI from 'openai';

import { env } from './env.js';

let _groqClient: OpenAI | null = null;
let _openaiClient: OpenAI | null = null;

function groqClient(): OpenAI {
  if (!env.GROQ_API_KEY) {
    throw new Error(
      'GROQ_API_KEY is not configured. Worker chat completions (crawl ' +
        'analysis) require Groq — add the key to .env / .env.production ' +
        'and restart.',
    );
  }
  if (_groqClient) return _groqClient;
  _groqClient = new OpenAI({ apiKey: env.GROQ_API_KEY, baseURL: env.GROQ_BASE_URL });
  return _groqClient;
}

function openaiClient(): OpenAI | null {
  if (!env.OPENAI_API_KEY) return null;
  if (_openaiClient) return _openaiClient;
  // No baseURL override → SDK points at api.openai.com (the default).
  _openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return _openaiClient;
}

// True when ANY chat-completion provider is reachable. Crawl analysis
// gates on this; today either Groq alone, OpenAI alone, or both is
// enough to satisfy callers. We keep the historical export name so
// we don't have to touch every call site.
export function isOpenAIConfigured(): boolean {
  return !!env.GROQ_API_KEY || !!env.OPENAI_API_KEY;
}

// Treat HTTP 429 from EITHER provider as "rate-limited, try the
// other." The OpenAI SDK surfaces this on `err.status`; some lower-
// level transports populate `err.statusCode` instead, and some thin
// proxies put it in `err.response.status`. Cover all three.
function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  if (e.status === 429 || e.statusCode === 429) return true;
  const r = e.response as Record<string, unknown> | undefined;
  if (r && r.status === 429) return true;
  // OpenAI SDK's named subclass — check by constructor name so we
  // don't have to import the type just for instanceof.
  const ctorName = (e.constructor as { name?: string } | undefined)?.name;
  if (ctorName === 'RateLimitError') return true;
  return false;
}

export interface WorkerCompleteResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  // Which provider actually served this request. Operators can grep
  // logs / aggregate this in metrics later to spot fallback rates
  // climbing — a leading indicator that Groq's quota needs to grow.
  provider: 'groq' | 'openai';
}

export async function workerComplete(args: {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  // When true, the model is asked to return STRICT JSON (no prose, no
  // code fences). Used by the crawl-analyze step so we don't have to
  // guess at fence markers in the output. Both Groq and gpt-4o-mini
  // support response_format: json_object natively, so the fallback
  // path is feature-equivalent.
  jsonMode?: boolean;
}): Promise<WorkerCompleteResult> {
  const payload = {
    max_tokens: args.maxTokens ?? 2048,
    temperature: args.temperature ?? 0.3,
    ...(args.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
    messages: [
      { role: 'system' as const, content: args.systemPrompt },
      { role: 'user' as const, content: args.userPrompt },
    ],
  };

  // -------- Primary: Groq -------------------------------------------------
  if (env.GROQ_API_KEY) {
    try {
      const res = await groqClient().chat.completions.create({
        ...payload,
        model: env.GROQ_MODEL,
      });
      const text = (res.choices[0]?.message.content ?? '').trim();
      return {
        text,
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
        provider: 'groq',
      };
    } catch (err) {
      if (!isRateLimitError(err)) throw err;
      // Fall through to OpenAI. Log the fact so operators see why
      // their crawl is more expensive today than yesterday.
      const fallback = openaiClient();
      if (!fallback) {
        // No fallback configured → propagate the original 429 so the
        // caller's try/catch surfaces it the same way it always has.
        throw err;
      }
      console.warn(
        '[workerComplete] Groq 429; falling back to OpenAI',
        env.OPENAI_MODEL,
      );
    }
  }

  // -------- Fallback (or sole provider): OpenAI ---------------------------
  const openai = openaiClient();
  if (!openai) {
    throw new Error(
      'Neither GROQ_API_KEY nor OPENAI_API_KEY is configured — worker chat ' +
        'completions need at least one provider keyed.',
    );
  }
  const res = await openai.chat.completions.create({
    ...payload,
    model: env.OPENAI_MODEL,
  });
  const text = (res.choices[0]?.message.content ?? '').trim();
  return {
    text,
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
    provider: 'openai',
  };
}
