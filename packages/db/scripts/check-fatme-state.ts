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
      select: { id: true, disabledFeatures: true, aiPlan: true },
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
        adminSystemPromptAppend: true,
        scriptedFlow: true,
        languages: true,
        version: true,
        updatedAt: true,
      },
    });
    const flow = (cfg?.scriptedFlow as Record<string, unknown> | null) ?? null;
    const flowEnabled = !!flow && (flow as { enabled?: boolean }).enabled === true;
    const persona = cfg?.adminSystemPromptAppend ?? '';
    const isPureLlmFatme = persona.includes('فريق فاطمة') && !flowEnabled;

    const channels = await prisma.whatsAppChannel.findMany({
      where: { organizationId: org.id },
      select: { label: true, isPrimary: true, isActive: true, botEnabled: true, phoneNumberId: true },
    });

    console.log('\n=========== FATME STATE (pure-LLM intake) ===========');
    console.log('org.disabledFeatures      :', JSON.stringify(org.disabledFeatures));
    console.log('  → AI disabled?          :', (org.disabledFeatures ?? []).includes('ai') ? 'YES (bot will not reply)' : 'no');
    const planModel: Record<string, string> = { basic: 'Groq Llama 3.3 70B / gpt-4o-mini', middle: 'OpenAI gpt-4o', max: 'Claude Sonnet', ultra: 'Claude Sonnet + Haiku aux' };
    console.log('aiPlan (MODEL)            :', org.aiPlan, `→ ${planModel[org.aiPlan] ?? '?'}`, org.aiPlan === 'basic' ? '  ⚠ weak for nuanced Arabic — consider max (Sonnet)' : '');
    console.log('botConfig.version         :', cfg?.version, '  updatedAt:', cfg?.updatedAt?.toISOString());
    console.log('deployedAt                :', cfg?.deployedAt ? cfg.deployedAt.toISOString() : 'NULL (bot skip: not deployed)');
    console.log('languages                 :', cfg?.languages);
    console.log('greeting (text)           :', cfg?.greeting ? `SET (${cfg.greeting.slice(0, 30)}…)` : 'empty');
    console.log('---- VOICE (plays on opening reply) ----');
    console.log('greetingVoiceStorageKey   :', cfg?.greetingVoiceStorageKey || '❌ MISSING — NO greeting voice can play. Upload it in the bot builder + save.');
    console.log('---- MODE ----');
    console.log('scriptedFlow enabled?     :', flowEnabled, flowEnabled ? '⚠ still a DETERMINISTIC flow — should be null for pure-LLM' : '(cleared → LLM path runs ✅)');
    console.log('persona (adminAppend) set :', persona ? `yes (${persona.length} chars)` : '❌ NO — the pure-LLM seed has NOT been applied');
    console.log('is pure-LLM fatme?        :', isPureLlmFatme ? '✅ yes (persona set + no scripted flow)' : '❌ NO — re-run seed-fatme-flow.ts');
    console.log('---- CHANNEL(S) ----');
    for (const ch of channels) {
      console.log(
        `  ${ch.isPrimary ? '★' : ' '} label=${ch.label ?? '(none)'} active=${ch.isActive} botEnabled=${ch.botEnabled} ` +
          `phoneNumberId=${ch.phoneNumberId ? 'set' : 'MISSING'}`,
      );
      if (!ch.botEnabled) console.log('    ⚠ botEnabled=false on this number → bot skip: bot disabled on this number');
    }
    console.log('===================================\n');
    console.log('READ: greetingVoiceStorageKey MISSING → no voice plays. Upload it in the bot builder + SAVE, then re-run the seed.');
    console.log('READ: "is pure-LLM fatme?" NO → the seed hasn’t run (or the api wasn’t redeployed). scriptedFlow enabled=true → still deterministic.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
