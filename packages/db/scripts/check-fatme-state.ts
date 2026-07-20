// Read-only diagnostic for the fatme-ismail bot. Prints everything needed to
// explain "no voice note" / "wrong welcome" / "not replying" in one shot.
// SAFE — reads only, writes nothing.
//
//   set -a; . ./.env.production; set +a; \
//   pnpm --filter @aligned/db exec tsx --conditions=source scripts/check-fatme-state.ts
import { PrismaClient } from '@prisma/client';

const SLUG = 'fatme-ismail';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.findUnique({
      where: { slug: SLUG },
      select: { id: true, disabledFeatures: true },
    });
    if (!org) {
      console.log(`NO ORG with slug '${SLUG}'`);
      return;
    }

    const cfg = await prisma.botConfig.findUnique({
      where: { organizationId: org.id },
      select: {
        deployedAt: true,
        greeting: true,
        greetingVoiceStorageKey: true,
        greetingImageStorageKey: true,
        scriptedFlow: true,
        version: true,
        updatedAt: true,
      },
    });
    const flow = (cfg?.scriptedFlow as Record<string, unknown> | null) ?? null;
    const nodes = (flow?.nodes as Record<string, { text?: string; voiceKey?: string | null }>) ?? {};
    const nodeIds = Object.keys(nodes);
    const isNewFlow = nodeIds.includes('s0_welcome') && nodeIds.includes('safety_check');

    const channels = await prisma.whatsAppChannel.findMany({
      where: { organizationId: org.id },
      select: { label: true, isPrimary: true, isActive: true, botEnabled: true, phoneNumberId: true },
    });

    console.log('\n=========== FATME STATE ===========');
    console.log('org.disabledFeatures      :', JSON.stringify(org.disabledFeatures));
    console.log('  → AI disabled?          :', (org.disabledFeatures ?? []).includes('ai') ? 'YES (bot will not reply)' : 'no');
    console.log('botConfig.version         :', cfg?.version, '  updatedAt:', cfg?.updatedAt?.toISOString());
    console.log('deployedAt                :', cfg?.deployedAt ? cfg.deployedAt.toISOString() : 'NULL (bot skip: not deployed)');
    console.log('greeting (text)           :', cfg?.greeting ? `SET (${cfg.greeting.slice(0, 30)}…)` : 'empty');
    console.log('---- VOICE ----');
    console.log('greetingVoiceStorageKey   :', cfg?.greetingVoiceStorageKey || '❌ MISSING — NO voice can ever play. Re-upload in the bot builder greeting voice slot.');
    console.log('s6_audio.voiceKey (in flow):', nodes.s6_audio?.voiceKey || 'none (seed injects greetingVoiceStorageKey here)');
    console.log('---- FLOW ----');
    console.log('scriptedFlow present       :', !!flow);
    console.log('scriptedFlow.enabled       :', flow?.enabled);
    console.log('scriptedFlow.entry         :', flow?.entry);
    console.log('greetingVoiceOnEntry       :', flow?.greetingVoiceOnEntry);
    console.log('node count                 :', nodeIds.length, `[${nodeIds.join(', ')}]`);
    console.log('is the NEW flow?           :', isNewFlow ? '✅ yes (has s0_welcome + safety_check)' : '❌ NO — the new seed has NOT been applied');
    console.log('entry node text            :', (nodes[String(flow?.entry)]?.text ?? '(none)').slice(0, 70));
    console.log('---- CHANNEL(S) ----');
    for (const ch of channels) {
      console.log(
        `  ${ch.isPrimary ? '★' : ' '} label=${ch.label ?? '(none)'} active=${ch.isActive} botEnabled=${ch.botEnabled} ` +
          `phoneNumberId=${ch.phoneNumberId ? 'set' : 'MISSING'}`,
      );
      if (!ch.botEnabled) console.log('    ⚠ botEnabled=false on this number → bot skip: bot disabled on this number');
    }
    console.log('===================================\n');
    console.log('READ: if greetingVoiceStorageKey is MISSING → that is why no voice plays (upload it + re-run seed-fatme-flow).');
    console.log('READ: if "is the NEW flow?" is NO → the seed hasn’t run. If YES but only 1 bubble sends live → the API wasn’t redeployed.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
