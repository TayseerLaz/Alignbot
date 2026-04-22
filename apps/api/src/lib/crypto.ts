import { createHash, randomBytes } from 'node:crypto';

import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 12;

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, BCRYPT_ROUNDS);
export const verifyPassword = (plain: string, hash: string): Promise<boolean> => bcrypt.compare(plain, hash);

/** Generate an opaque, URL-safe token. Default 32 bytes ≈ 43 chars base64url. */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 a token for at-rest storage (so DB leak alone doesn't grant tokens). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
