// One-off / repeatable backfill: ensure every active WhatsApp channel's WABA
// has our per-org callback registered as the override, so inbound actually
// flows. Fixes the "verified green but empty inbox" trap (no subscribed app on
// the WABA → Meta delivers nothing). Idempotent — skips channels already
// pointing at the right callback.
//
//   cd /opt/aligned/app && set -a; . ./.env.production; set +a
//   pnpm --filter @aligned/api exec tsx --conditions=source infra/scripts/wa-backfill-subscribe.ts
import { prisma } from '@aligned/db';

const apiBase = (process.env.API_PUBLIC_URL || 'https://api.hader.ai').replace(/\/$/, '');

async function main() {
  const channels = await prisma.whatsAppChannel.findMany({
    where: { isActive: true },
    select: {
      id: true,
      organizationId: true,
      wabaId: true,
      accessToken: true,
      webhookVerifyToken: true,
      displayPhoneNumber: true,
      appSecret: true,
    },
  });
  console.log(`Checking ${channels.length} active WhatsApp channel(s)…`);

  for (const ch of channels) {
    const label = ch.displayPhoneNumber ?? ch.id;
    const token = ch.accessToken as string | null;
    if (!token || !ch.wabaId) {
      console.log(`SKIP   ${label} — missing token or WABA id`);
      continue;
    }
    const callbackUrl = `${apiBase}/api/v1/whatsapp/webhook/${ch.organizationId}`;

    // Already pointing at the right callback?
    try {
      const r = await fetch(`https://graph.facebook.com/v20.0/${ch.wabaId}/subscribed_apps`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = (await r.json()) as { data?: Array<{ override_callback_uri?: string }> };
      const already =
        Array.isArray(j?.data) && j.data.some((a) => a?.override_callback_uri === callbackUrl);
      if (already) {
        console.log(`OK     ${label} — already subscribed`);
        continue;
      }
    } catch (e) {
      console.log(`CHECK-ERR ${label} — ${e instanceof Error ? e.message : e}`);
    }

    // Subscribe (overwrites any stale override).
    try {
      const params = new URLSearchParams({
        override_callback_uri: callbackUrl,
        verify_token: ch.webhookVerifyToken,
      });
      const r = await fetch(`https://graph.facebook.com/v20.0/${ch.wabaId}/subscribed_apps`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });
      const t = await r.text();
      const ok = r.ok && /"success":\s*true/.test(t);
      const warn = ch.appSecret ? '' : '  [WARN: no app secret — inbound will be rejected with 403]';
      console.log(`${ok ? 'FIXED ' : 'FAIL  '} ${label} -> ${callbackUrl}${ok ? '' : ` :: ${t.slice(0, 200)}`}${warn}`);
    } catch (e) {
      console.log(`SUB-ERR ${label} — ${e instanceof Error ? e.message : e}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
