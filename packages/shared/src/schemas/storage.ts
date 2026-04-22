import { z } from 'zod';

import { AssetKind } from '../enums/catalog.js';
import { uuidSchema } from './common.js';

// Image MIME allowlist for product images. Other kinds widen the list.
export const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024; // 25 MB
export const MAX_CSV_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

export const presignUploadBodySchema = z.object({
  kind: z.nativeEnum(AssetKind),
  contentType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/),
  byteSize: z.number().int().positive().max(MAX_CSV_UPLOAD_BYTES),
  filename: z.string().min(1).max(200).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});
export type PresignUploadBody = z.infer<typeof presignUploadBodySchema>;

export const presignUploadResponseSchema = z.object({
  assetId: uuidSchema,
  storageKey: z.string(),
  // PUT this URL with the same Content-Type header to complete the upload.
  uploadUrl: z.string().url(),
  // Public read URL (or via signed GET endpoint if bucket is private).
  publicUrl: z.string().url().nullable(),
  expiresInSeconds: z.number().int().positive(),
});

export const finalizeUploadBodySchema = z.object({
  assetId: uuidSchema,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type FinalizeUploadBody = z.infer<typeof finalizeUploadBodySchema>;

export const assetSchema = z.object({
  id: uuidSchema,
  kind: z.nativeEnum(AssetKind),
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  url: z.string().url().nullable(),
  createdAt: z.string().datetime(),
});
export type AssetDto = z.infer<typeof assetSchema>;
