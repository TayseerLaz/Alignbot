// Inbox consistency: never lose a chat.
//
// A WhatsAppMessage with thread_id = NULL is "orphaned" — it was sent/received
// but isn't linked to any conversation, so it never shows in the inbox. We hit
// this because several outbound senders (drip sequences, broadcasts) historically
// did `whatsAppMessage.create({...})` WITHOUT a threadId.
//
// This module provides:
//   1. recordOutboundTemplate() — the safe way to persist an outbound template:
//      upserts the customer's thread and links the message. Used by the
//      sequence + broadcast senders so no NEW orphan is ever created.
//   2. repairOrphanedMessages() — a self-healing sweep that re-links any
//      orphaned message to its thread (by org + phone), then recomputes that
//      thread's counts + preview. Run periodically by startInboxConsistencyTick
//      so even a future bug can't permanently lose a chat.

import { prisma, withRlsBypass } from './db.js';

const TICK_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes
const REPAIR_BATCH = 500;

let stopped = false;
let timer: ReturnType<typeof setTimeout> | null = null;

// Persist an outbound template message AND guarantee it's linked to the
// customer's inbox thread (upserting the thread if needed). Best-effort:
// failures are logged, never thrown, so a persistence hiccup can't break the
// send loop — and the repair sweep below is the backstop.
export async function recordOutboundTemplate(args: {
  organizationId: string;
  toNumber: string;
  metaMessageId: string | null;
  templateName: string;
}): Promise<void> {
  const phone = (args.toNumber ?? '').replace(/[^0-9]/g, '');
  if (!phone) return;
  const preview = `📨 Template · ${args.templateName}`.slice(0, 200);
  try {
    await withRlsBypass(async (tx) => {
      const thread = await tx.whatsAppThread.upsert({
        where: {
          organizationId_customerPhone: { organizationId: args.organizationId, customerPhone: phone },
        },
        create: {
          organizationId: args.organizationId,
          customerPhone: phone,
          status: 'open',
          lastMessageAt: new Date(),
          lastMessagePreview: preview,
          inboundCount: 0,
          outboundCount: 1,
          searchText: preview,
        },
        update: {
          lastMessageAt: new Date(),
          lastMessagePreview: preview,
          outboundCount: { increment: 1 },
        },
        select: { id: true },
      });
      await tx.whatsAppMessage.create({
        data: {
          threadId: thread.id,
          organizationId: args.organizationId,
          direction: 'outbound',
          metaMessageId: args.metaMessageId,
          toNumber: phone,
          messageType: 'template',
          body: args.templateName,
          metaStatus: 'sent',
          metaStatusAt: new Date(),
        },
      });
    });
  } catch (err) {
    console.error('[inbox-consistency] recordOutboundTemplate failed', err);
  }
}

// Re-link orphaned messages (thread_id IS NULL) to their thread, creating the
// thread if it doesn't exist yet, then recompute the touched threads' counts +
// preview so the inbox reflects reality. Returns a small report. Idempotent and
// safe to run from multiple replicas (only targets thread_id IS NULL rows).
export async function repairOrphanedMessages(
  limit = REPAIR_BATCH,
): Promise<{ scanned: number; relinked: number; unattributable: number; threads: number }> {
  return withRlsBypass(async (tx) => {
    const orphans = await tx.whatsAppMessage.findMany({
      where: { threadId: null },
      select: { id: true, organizationId: true, direction: true, fromNumber: true, toNumber: true },
      take: limit,
    });
    if (orphans.length === 0) {
      return { scanned: 0, relinked: 0, unattributable: 0, threads: 0 };
    }

    let relinked = 0;
    let unattributable = 0;
    const touched = new Set<string>();

    for (const m of orphans) {
      const raw = (m.direction === 'inbound' ? m.fromNumber : m.toNumber) ?? '';
      const phone = raw.replace(/[^0-9]/g, '');
      if (!phone) {
        // No phone to attribute the message to — leave it; surfaced in the
        // count so we can investigate rather than silently drop it.
        unattributable++;
        continue;
      }
      const thread = await tx.whatsAppThread.upsert({
        where: { organizationId_customerPhone: { organizationId: m.organizationId, customerPhone: phone } },
        create: {
          organizationId: m.organizationId,
          customerPhone: phone,
          status: 'open',
          lastMessageAt: new Date(),
          lastMessagePreview: null,
          inboundCount: 0,
          outboundCount: 0,
          searchText: phone,
        },
        update: {},
        select: { id: true },
      });
      await tx.whatsAppMessage.update({ where: { id: m.id }, data: { threadId: thread.id } });
      relinked++;
      touched.add(thread.id);
    }

    // Recompute counts + last-message for every thread we touched so the
    // denormalised inbox fields match the actual message rows.
    for (const threadId of touched) {
      const [inbound, outbound, last] = await Promise.all([
        tx.whatsAppMessage.count({ where: { threadId, direction: 'inbound' } }),
        tx.whatsAppMessage.count({ where: { threadId, direction: 'outbound' } }),
        tx.whatsAppMessage.findFirst({
          where: { threadId },
          orderBy: { receivedAt: 'desc' },
          select: { receivedAt: true, body: true, messageType: true },
        }),
      ]);
      await tx.whatsAppThread.update({
        where: { id: threadId },
        data: {
          inboundCount: inbound,
          outboundCount: outbound,
          ...(last
            ? {
                lastMessageAt: last.receivedAt,
                lastMessagePreview: (last.body ?? `[${last.messageType ?? 'media'}]`).slice(0, 200),
              }
            : {}),
        },
      });
    }

    return { scanned: orphans.length, relinked, unattributable, threads: touched.size };
  });
}

// Read-only health snapshot — how many orphaned messages exist right now.
// Cheap; safe to expose to /aligned-admin or log on a schedule.
export async function inboxHealthSnapshot(): Promise<{ orphanedMessages: number }> {
  const orphanedMessages = await prisma.whatsAppMessage.count({ where: { threadId: null } });
  return { orphanedMessages };
}

export function startInboxConsistencyTick(): { name: string; close: () => Promise<void> } {
  const run = async () => {
    if (stopped) return;
    try {
      const r = await repairOrphanedMessages();
      if (r.relinked > 0 || r.unattributable > 0) {
        console.log(
          `[inbox-consistency] re-linked ${r.relinked} orphaned message(s) into ${r.threads} thread(s)` +
            (r.unattributable > 0 ? `; ${r.unattributable} unattributable (no phone)` : ''),
        );
      }
    } catch (err) {
      console.error('[inbox-consistency] tick error', err);
    }
    if (!stopped) timer = setTimeout(run, TICK_INTERVAL_MS);
  };
  // First run 2 minutes after boot — also repairs any pre-existing orphans.
  timer = setTimeout(run, 2 * 60 * 1000);
  return {
    name: 'inbox-consistency',
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
