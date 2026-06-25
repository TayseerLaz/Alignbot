import { z } from 'zod';

import { OrgRole, UserStatus } from '../enums/index.js';
import { emailSchema, uuidSchema } from './common.js';

export const memberSchema = z.object({
  membershipId: uuidSchema,
  userId: uuidSchema,
  email: emailSchema,
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  role: z.nativeEnum(OrgRole),
  skills: z.array(z.string()).default([]),
  status: z.nativeEnum(UserStatus),
  isActive: z.boolean(),
  // Protected/owner membership — role/deactivate/remove are blocked for it.
  protected: z.boolean().default(false),
  lastLoginAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Member = z.infer<typeof memberSchema>;

export const updateMemberRoleBodySchema = z.object({
  role: z.nativeEnum(OrgRole),
});
export type UpdateMemberRoleBody = z.infer<typeof updateMemberRoleBodySchema>;

export const updateMemberSkillsBodySchema = z.object({
  skills: z.array(
    z.string().trim().toLowerCase().max(40).regex(/^[a-z0-9_-]+$/i, 'Use letters, numbers, _ or -.'),
  ),
});
export type UpdateMemberSkillsBody = z.infer<typeof updateMemberSkillsBodySchema>;

export const updateProfileBodySchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  avatarUrl: z.string().url().nullable().optional(),
});
export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>;

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(12)
    .max(128)
    .refine((s) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s), 'Password too weak.'),
});
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
