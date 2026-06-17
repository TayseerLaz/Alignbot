// Shared cart/order flow for non-WhatsApp channels (Messenger/Instagram).
//
// Mirrors the WhatsApp cart logic (whatsapp.routes) but is self-contained and
// reuses the battle-tested cart-parser (parseAddedItems — synonym/list-format
// aware) so the WhatsApp hot path is NOT touched. Cart rows are per-thread, so
// everything keys off threadId + a generic customerId (PSID for Messenger).
import { parseAddedItems } from './cart-parser.js';
import { withRlsBypass } from './db.js';

export interface ShopFormLite {
  currency: string;
  deliveryFeeMinor?: number | null;
  freeDeliveryAboveMinor?: number | null;
  fields?: { key: string; label: string; type: string; required: boolean }[];
}

export interface CatalogProductLite {
  id: string;
  sku: string;
  name: string;
  priceMinor: number | null;
}

function deliveryFor(subtotalMinor: number, shopForm: ShopFormLite): number {
  const base = shopForm.deliveryFeeMinor ?? 0;
  if (shopForm.freeDeliveryAboveMinor != null && subtotalMinor >= shopForm.freeDeliveryAboveMinor) {
    return 0;
  }
  return base;
}

/** The active draft cart for a thread, shaped for buildBotResponse.cartState. */
export async function loadDraftCartState(
  orgId: string,
  threadId: string,
): Promise<
  | {
      items: { name: string; quantity: number; unitPriceMinor: number; sku: string | null }[];
      subtotalMinor: number;
      currency: string;
      capturedFields?: Record<string, string>;
    }
  | null
> {
  return withRlsBypass(async (tx) => {
    const draft = await tx.cart.findFirst({
      where: { organizationId: orgId, threadId, status: 'draft' },
      include: { items: true },
    });
    if (!draft || draft.items.length === 0) return null;
    const capturedFields: Record<string, string> = {};
    for (const f of (draft.fields as { key?: string; value?: string }[] | null) ?? []) {
      if (f?.key && f.value) capturedFields[f.key] = String(f.value);
    }
    return {
      items: draft.items.map((it) => ({
        name: it.name,
        quantity: it.quantity,
        unitPriceMinor: it.unitPriceMinor,
        sku: it.sku,
      })),
      subtotalMinor: draft.subtotalMinor,
      currency: draft.currency,
      capturedFields: Object.keys(capturedFields).length > 0 ? capturedFields : undefined,
    };
  });
}

/** Parse the bot reply's adds and upsert them into the thread's draft cart. */
export async function syncDraftFromReply(args: {
  orgId: string;
  threadId: string;
  customerId: string;
  reply: string;
  userMessage: string;
  previousBotReply: string;
  products: CatalogProductLite[];
  shopForm: ShopFormLite;
}): Promise<void> {
  const parsed = parseAddedItems(
    args.reply,
    args.products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, priceMinor: p.priceMinor })),
    { userMessage: args.userMessage, previousBotReply: args.previousBotReply },
  );
  if (parsed.length === 0) return;

  await withRlsBypass(async (tx) => {
    let draft = await tx.cart.findFirst({
      where: { organizationId: args.orgId, threadId: args.threadId, status: 'draft' },
      include: { items: true },
    });
    if (!draft) {
      draft = await tx.cart.create({
        data: {
          organizationId: args.orgId,
          threadId: args.threadId,
          customerPhone: args.customerId,
          status: 'draft',
          currency: args.shopForm.currency,
          fields: [] as never,
        },
        include: { items: true },
      });
    }
    for (const p of parsed) {
      const existing = draft.items.find((it) => it.sku === p.sku);
      if (existing) {
        await tx.cartItem.update({
          where: { id: existing.id },
          data: {
            quantity: p.quantity,
            unitPriceMinor: p.unitPriceMinor,
            lineTotalMinor: p.quantity * p.unitPriceMinor,
          },
        });
      } else {
        await tx.cartItem.create({
          data: {
            organizationId: args.orgId,
            cartId: draft.id,
            productId: p.productId,
            sku: p.sku,
            name: p.name,
            quantity: p.quantity,
            unitPriceMinor: p.unitPriceMinor,
            lineTotalMinor: p.quantity * p.unitPriceMinor,
          },
        });
      }
    }
    const refreshed = await tx.cartItem.findMany({ where: { cartId: draft.id } });
    const subtotalMinor = refreshed.reduce((s, it) => s + it.lineTotalMinor, 0);
    const deliveryMinor = deliveryFor(subtotalMinor, args.shopForm);
    await tx.cart.update({
      where: { id: draft.id },
      data: {
        subtotalMinor,
        deliveryMinor,
        totalMinor: subtotalMinor + deliveryMinor,
        itemsCount: refreshed.reduce((s, it) => s + it.quantity, 0),
      },
    });
  });
}

/**
 * Promote the draft cart (or the marker payload if no draft) to a real order
 * ('new'). Returns receipt info, or null if there was nothing to capture.
 */
export async function captureCart(args: {
  orgId: string;
  threadId: string;
  customerId: string;
  customerName: string | null;
  cartMarkerPayload: {
    items?: { sku?: string; name?: string; quantity?: number; unitPriceMinor?: number; notes?: string }[];
    fields?: Record<string, unknown>;
  };
  shopForm: ShopFormLite;
  products: CatalogProductLite[];
}): Promise<{ id: string; itemsCount: number; totalMinor: number; currency: string } | null> {
  return withRlsBypass(async (tx) => {
    const draft = await tx.cart.findFirst({
      where: { organizationId: args.orgId, threadId: args.threadId, status: 'draft' },
      include: { items: true },
    });
    const bySku = new Map(args.products.map((p) => [p.sku.toLowerCase(), p]));
    const lineItems: {
      productId: string | null;
      sku: string | null;
      name: string;
      quantity: number;
      unitPriceMinor: number;
    }[] = [];
    if (draft && draft.items.length > 0) {
      for (const it of draft.items) {
        lineItems.push({
          productId: it.productId,
          sku: it.sku,
          name: it.name,
          quantity: it.quantity,
          unitPriceMinor: it.unitPriceMinor,
        });
      }
    } else {
      for (const it of args.cartMarkerPayload.items ?? []) {
        const sku = (it.sku ?? '').toString().trim();
        const matched = sku ? bySku.get(sku.toLowerCase()) : undefined;
        const name = (it.name ?? matched?.name ?? '').toString().trim();
        if (!name) continue;
        lineItems.push({
          productId: matched?.id ?? null,
          sku: matched?.sku ?? (sku || null),
          name,
          quantity: Math.max(1, Math.floor(Number(it.quantity ?? 1))),
          unitPriceMinor: Math.max(0, Math.floor(Number(it.unitPriceMinor ?? matched?.priceMinor ?? 0))),
        });
      }
    }
    if (lineItems.length === 0) return null;

    const subtotalMinor = lineItems.reduce((s, it) => s + it.quantity * it.unitPriceMinor, 0);
    const deliveryMinor = deliveryFor(subtotalMinor, args.shopForm);
    const totalMinor = subtotalMinor + deliveryMinor;
    const itemsCount = lineItems.reduce((s, it) => s + it.quantity, 0);
    const fieldRows = (args.shopForm.fields ?? []).map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      required: f.required,
      value: (args.cartMarkerPayload.fields ?? {})[f.key] ?? null,
    }));

    let cartId: string;
    if (draft) {
      await tx.cart.update({
        where: { id: draft.id },
        data: {
          status: 'new',
          customerName: args.customerName,
          fields: fieldRows as never,
          subtotalMinor,
          deliveryMinor,
          totalMinor,
          itemsCount,
          currency: args.shopForm.currency,
        },
      });
      cartId = draft.id;
      // Re-sync items when capturing from a marker fallback into an existing
      // (item-less) draft.
      if (draft.items.length === 0) {
        await tx.cartItem.createMany({
          data: lineItems.map((it) => ({
            organizationId: args.orgId,
            cartId: draft.id,
            productId: it.productId,
            sku: it.sku,
            name: it.name,
            quantity: it.quantity,
            unitPriceMinor: it.unitPriceMinor,
            lineTotalMinor: it.quantity * it.unitPriceMinor,
          })),
        });
      }
    } else {
      const created = await tx.cart.create({
        data: {
          organizationId: args.orgId,
          threadId: args.threadId,
          customerPhone: args.customerId,
          customerName: args.customerName,
          fields: fieldRows as never,
          subtotalMinor,
          deliveryMinor,
          totalMinor,
          itemsCount,
          currency: args.shopForm.currency,
          status: 'new',
          items: {
            createMany: {
              data: lineItems.map((it) => ({
                organizationId: args.orgId,
                productId: it.productId,
                sku: it.sku,
                name: it.name,
                quantity: it.quantity,
                unitPriceMinor: it.unitPriceMinor,
                lineTotalMinor: it.quantity * it.unitPriceMinor,
              })),
            },
          },
        },
      });
      cartId = created.id;
    }
    return { id: cartId, itemsCount, totalMinor, currency: args.shopForm.currency };
  });
}
