// Envelope encryption for secrets at rest (AES-256-GCM).
//
// WhatsApp access tokens + app secrets were stored in plaintext — a DB read
// (SQL injection, a leaked pg_dump, an insider) exposed the ability to
// send/receive WhatsApp as the client and forge signed inbound webhooks.
// This transparently encrypts those columns via a Prisma client extension.
//
// SAFE-BY-DEFAULT: when SECRET_ENCRYPTION_KEY is unset the helpers are
// pass-throughs and the extension is NOT applied at all — behaviour is
// byte-identical to before. Set the key (+ run the backfill) to activate.
//
// Format: `enc:v1:<base64 iv>:<base64 tag>:<base64 ciphertext>`.
// decrypt() passes plaintext through unchanged, so encrypted and not-yet-
// backfilled plaintext rows coexist safely during/after rollout.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

const PREFIX = 'enc:v1:';

function getKey(): Buffer | null {
  const raw = process.env.SECRET_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('SECRET_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64).');
  }
  return key;
}

export function secretCryptoEnabled(): boolean {
  return getKey() !== null;
}

export function encryptSecret<T extends string | null | undefined>(plain: T): T {
  if (plain == null) return plain;
  const key = getKey();
  if (!key) return plain; // inert
  if ((plain as string).startsWith(PREFIX)) return plain; // already encrypted
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain as string, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (PREFIX +
    [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')) as T;
}

export function decryptSecret<T extends string | null | undefined>(value: T): T {
  if (value == null) return value;
  if (!(value as string).startsWith(PREFIX)) return value; // plaintext passthrough
  const key = getKey();
  if (!key) return value;
  try {
    const [, , ivB64, tagB64, ctB64] = (value as string).split(':');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64!, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
    const out = Buffer.concat([
      decipher.update(Buffer.from(ctB64!, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return out as T;
  } catch (err) {
    // Never crash a request on a decrypt failure — log loudly and return the
    // stored value (a wrong token then fails at Meta, surfaced in logs).
    console.error('[secret-crypto] decrypt failed', err);
    return value;
  }
}

// Per-model field lists to crypt. Scoped to the highest-value secrets first.
const SECRET_FIELDS = ['accessToken', 'appSecret'] as const;

function encryptArgs(args: unknown): void {
  const a = args as Record<string, unknown> | null;
  if (!a) return;
  for (const slot of ['data', 'create', 'update'] as const) {
    const d = a[slot];
    if (!d) continue;
    const objs = Array.isArray(d) ? d : [d];
    for (const o of objs as Record<string, unknown>[]) {
      for (const f of SECRET_FIELDS) {
        const v = o[f];
        if (typeof v === 'string') o[f] = encryptSecret(v);
        else if (v && typeof v === 'object' && typeof (v as { set?: unknown }).set === 'string') {
          (v as { set: string }).set = encryptSecret((v as { set: string }).set);
        }
      }
    }
  }
}

function decryptResult<R>(result: R): R {
  const apply = (o: unknown) => {
    if (o && typeof o === 'object') {
      const rec = o as Record<string, unknown>;
      for (const f of SECRET_FIELDS) {
        if (typeof rec[f] === 'string') rec[f] = decryptSecret(rec[f] as string);
      }
    }
  };
  if (Array.isArray(result)) result.forEach(apply);
  else apply(result);
  return result;
}

/**
 * Wrap a PrismaClient so `whatsapp_channels.accessToken` + `.appSecret` are
 * transparently encrypted on write and decrypted on read. Returns the client
 * UNCHANGED when no key is configured (inert) — so it's safe to call always.
 */
export function withSecretCrypto(client: PrismaClient): PrismaClient {
  if (!secretCryptoEnabled()) return client;
  return client.$extends({
    query: {
      whatsAppChannel: {
        async $allOperations({ args, query }) {
          encryptArgs(args);
          return decryptResult(await query(args));
        },
      },
    },
  }) as unknown as PrismaClient;
}
