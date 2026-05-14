import { z } from 'zod';

import { slugSchema, uuidSchema } from './common.js';

export const categorySchema = z.object({
  id: uuidSchema,
  parentId: uuidSchema.nullable(),
  name: z.string(),
  slug: slugSchema,
  description: z.string().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  // Optional product / service counts — populated by GET /categories
  // so the listing page can show "N products / M services" per row
  // without a follow-up request. Detail endpoints don't have to set
  // these.
  productCount: z.number().int().nonnegative().optional(),
  serviceCount: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Category = z.infer<typeof categorySchema>;

export const categoryTreeNodeSchema: z.ZodType<Category & { children: unknown[] }> = z.lazy(() =>
  categorySchema.extend({ children: z.array(categoryTreeNodeSchema) }),
);

export const createCategoryBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema.optional(),
  parentId: uuidSchema.nullable().optional(),
  description: z.string().max(2000).optional(),
  sortOrder: z.number().int().optional(),
});
export type CreateCategoryBody = z.infer<typeof createCategoryBodySchema>;

export const updateCategoryBodySchema = createCategoryBodySchema.partial().extend({
  isActive: z.boolean().optional(),
});
export type UpdateCategoryBody = z.infer<typeof updateCategoryBodySchema>;

export const reorderCategoriesBodySchema = z.object({
  order: z.array(z.object({ id: uuidSchema, sortOrder: z.number().int() })).min(1),
});
export type ReorderCategoriesBody = z.infer<typeof reorderCategoriesBodySchema>;
