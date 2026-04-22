import { z } from 'zod';

import { OrgStatus } from '../enums/index.js';
import { slugSchema, uuidSchema } from './common.js';

export const organizationSchema = z.object({
  id: uuidSchema,
  slug: slugSchema,
  name: z.string(),
  status: z.nativeEnum(OrgStatus),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Organization = z.infer<typeof organizationSchema>;

export const updateOrganizationBodySchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
});
export type UpdateOrganizationBody = z.infer<typeof updateOrganizationBodySchema>;

// Aligned-admin-only ops
export const adminListOrgsQuerySchema = z.object({
  q: z.string().optional(),
  status: z.nativeEnum(OrgStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export const adminUpdateOrgBodySchema = z.object({
  status: z.nativeEnum(OrgStatus).optional(),
  name: z.string().trim().min(2).max(120).optional(),
});
