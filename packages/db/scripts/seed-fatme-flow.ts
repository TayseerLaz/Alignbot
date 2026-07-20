// Seed / update the Fatme Ismail deterministic scripted flow.
//
// Sets BotConfig.scriptedFlow (the guided, verbatim intake the bot runs
// bubble-by-bubble, bypassing the LLM) + the AI distress pre-check + ensures the
// bot is deployed. Also sets the business identity + a Levantine fallback persona
// (used only if the scripted flow ever errors and falls through to the LLM).
// Idempotent — safe to re-run whenever wording is refined (edit the nodes below
// + re-run). Re-running OVERWRITES any bot-builder wording edits made on prod.
//
//   set -a; . ./.env.production; set +a; \
//   pnpm --filter @aligned/db exec tsx --conditions=source scripts/seed-fatme-flow.ts
import { PrismaClient } from '@prisma/client';

const SLUG = 'fatme-ismail';

// ---------------------------------------------------------------------------
// The flow. Structure mirrors the spec's state machine S0 → S8 + a safety
// branch. Notes on the engine primitives used:
//   • auto:true          → send this bubble, then IMMEDIATELY continue to `next`
//                          without waiting (this is how one trigger emits a
//                          natural burst of separate WhatsApp bubbles).
//   • waitFor:'text'     → ask, then wait for the customer's typed answer.
//   • waitFor:'image'    → wait for the drawing (a photo); repromptText re-anchors
//                          gently WITHOUT resending the voice note / long text.
//   • voiceKey           → a voice note sent BEFORE the node's text. Injected at
//                          runtime below from BotConfig.greetingVoiceStorageKey
//                          (fatme's uploaded intro audio) onto the S6 node.
//   • action:'handoff'   → flip the thread to a human (status=pending) + end.
//   • safety.screenText  → every free-text inbound is screened for acute distress
//                          (fast LLM + keyword backstop) BEFORE the intake runs;
//                          a positive diverts to the safety node + handoff.
// The whole thing is feminine-addressed by default (per the source).
// ---------------------------------------------------------------------------
const flow = {
  enabled: true,
  channel: 'whatsapp',
  entry: 's0_welcome',
  safety: { node: 'safety', screenText: true },
  // Play fatme's voice note at the WELCOME (entry) too — not only at S6. Same
  // recording (BotConfig.greetingVoiceStorageKey) plays in both spots.
  greetingVoiceOnEntry: true,
  nodes: {
    // ----- S0_WELCOME — first contact (3 bubbles, sent as a burst) -----
    s0_welcome: {
      text: `أهلين فيكِ 🌸 كيفك؟ أنا كتير مبسوطة إنو طريقنا تقاطع هون.`,
      auto: true,
      next: 's0_team',
    },
    s0_team: {
      text: `فاطمة بتحب تتواصل مع الناس بشكل مباشر، بس أوقات التواصل بيكون كتير، عشان هيك أنا (فريقها) بساعد نظّم الأمور. رح إسألك كم سؤال بسيط، وبعدها فاطمة شخصياً بتكمّل معك 💛`,
      auto: true,
      next: 's0_safe',
    },
    s0_safe: {
      text: `وكل يلي بتشاركيني ياه محفوظ وآمن، لأنو قداسة هالحوار واللقاء بتعني لفاطمة كتير.`,
      auto: true,
      next: 'safety_check',
    },

    // ----- SAFETY CHECK — right after the opening, before the questions -----
    // Two tap-buttons. "بحاجة مساعدة فورية" → the crisis node (resources + handoff);
    // "أنا بأمان، بكمل" → start the intake. (The AI distress screen still runs on
    // every free-text turn as a backstop.) Buttons only — a typed reply just
    // re-shows them, so a negated phrase like "مش بأمان" can never be misread as
    // "proceed"; real distress is caught by the AI screen instead.
    safety_check: {
      text: `قبل ما نكمل سوا 🤍 بدي إطمئن عليكِ — كيفك هلأ؟`,
      buttons: [
        { title: 'بحاجة مساعدة فورية', next: 'safety' },
        { title: 'أنا بأمان، بكمل', next: 's1_origin' },
      ],
      waitFor: 'button',
    },

    // ----- S1 → S4 — one question per message, wait for each answer -----
    s1_origin: {
      text: `خبريني عنك شوي… من وين إنتِ؟`,
      waitFor: 'text',
      next: 's2_age',
    },
    s2_age: {
      text: `وقدّيش عمرك؟`,
      waitFor: 'text',
      next: 's3_how_found',
    },
    s3_how_found: {
      text: `وشو وصّلك لصفحة فاطمة؟`,
      waitFor: 'text',
      next: 's4_what_caught',
    },
    s4_what_caught: {
      text: `وشو أكتر شي لفتك؟`,
      waitFor: 'text',
      next: 's5_thanks',
    },

    // ----- S5_THANKS — acknowledge, then flow into the audio task -----
    s5_thanks: {
      text: `شكراً كتير إنك شاركتيني هالشي 🌷 بحسّو غالي.`,
      auto: true,
      next: 's6_intro',
    },

    // ----- S6_AUDIO_TASK — intro bubble, then [voice note] + draw prompt -----
    s6_intro: {
      text: `فاطمة دايماً بتحب تتواصل مع الناس من خلال اللون 🎨 عشان هيك حضّرتلك تسجيل صوتي صغير…`,
      auto: true,
      next: 's6_audio',
    },
    s6_audio: {
      // voiceKey injected at runtime from greetingVoiceStorageKey (fatme's audio).
      voiceKey: null as string | null,
      text: `إسمعيه بهدوء… وبعدها إرسمي يلي بيجيكي، بدون تفكير كتير. وبس تخلّصي، إبعتيلي الرسمة كصورة هون 💫`,
      waitFor: 'image',
      next: 's8_received',
      repromptText: `خدي وقتك 💛 بس تخلّصي الرسمة، إبعتيها هون.`,
    },

    // ----- S8_DRAWING_RECEIVED — confirm + set expectation, then handoff -----
    s8_received: {
      text: `وصلتني رسمتك 🤍 شكراً إنك وثّقتي فينا.`,
      auto: true,
      next: 's8_expect',
    },
    s8_expect: {
      text: `هلق فاطمة شخصياً رح تشوف رسمتك، وتحكيكي، وتشاركك شو شافت فيها… وتعطيكي تفاصيل ممكن تساعدك ترتاحي وتفهمي ذاتك أكتر.`,
      auto: true,
      next: 's8_wait',
    },
    s8_wait: {
      text: `إستنّيها شوي، رح توصلك 🌸`,
      action: 'handoff', // → status=pending, Fatima takes over; flow ends
    },

    // ----- SAFETY — distress diversion (never runs the drawing on someone in crisis) -----
    safety: {
      text: `واضح إنك عم تمرّي بشي تقيل، وأنا هون معك 🤍 خليني وصّلك بفاطمة شخصياً هلّق.`,
      auto: true,
      next: 'safety_resources',
    },
    safety_resources: {
      text: `وإذا حسّيتي إنك بحاجة دعم فوري: بلبنان في خط دعم نفسي اسمو Embrace على الرقم 1564، بيشتغل كل يوم من الـ ١٢ الظهر لـ ٢ بعد نص الليل. إذا مش بلبنان، فيكِ تزوري findahelpline.com لتلاقي أقرب خط دعم بمنطقتك. وإذا الوضع خطر عليكِ هلق، تواصلي فوراً مع الطوارئ المحلية عندك. أنا هون كمان، بس لكل حدا وظيفتو 🤍`,
      action: 'handoff',
    },
  },
} as {
  enabled: boolean;
  channel: string;
  entry: string;
  safety: { node: string; screenText: boolean };
  greetingVoiceOnEntry?: boolean;
  nodes: Record<string, { voiceKey?: string | null; [k: string]: unknown }>;
};

// Levantine fallback persona — ONLY used if the scripted flow errors and the
// LLM path takes over. Keeps identity + tone + safety on-brand in that rare case.
const FALLBACK_PERSONA = `أنت "فريق فاطمة" — مساعد ذكاء اصطناعي بيرحّب بالأشخاص الجدد على واتساب نيابةً عن فاطمة إسماعيل.
فاطمة بتتواصل مع الناس من خلال اللون والرسم، وبتساعدهم يرتاحوا ويفهموا ذاتهم أكتر.
- تكلّم دايماً باللهجة اللبنانية/الشامية، بدفا وهدوء واحترام. لا تكون رسمي أو آلي.
- خاطب الشخص بصيغة المؤنث افتراضياً؛ إذا وضّح إنو ذكر، حوّل للمذكر.
- إنت مش فاطمة، وإنت مش معالج نفسي. لا تحلل الرسمة، ولا تعطي قراءات، ولا تشخّص — القراءة الشخصية بتعملها فاطمة بس.
- كل يلي بيشاركك ياه الشخص محفوظ وآمن.
- إذا حدا عبّر عن ضيق شديد أو أذية لحالو: لا تكمل الأسئلة العادية — طمّنو بدفا، ذكّرو إنو في خطوط دعم (بلبنان Embrace 1564، أو findahelpline.com)، وسلّمو لفاطمة شخصياً فوراً.
- ما توعد بنتائج علاجية أو طبية؛ هيدا لقاء إنساني وفنّي مش بديل عن مختص.
- إذا ما بتعرف الجواب أو الطلب خارج نطاقك، سلّم لإنسان بدل ما تخترع.`;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.findUnique({ where: { slug: SLUG }, select: { id: true } });
    if (!org) throw new Error(`org '${SLUG}' not found`);

    const cfg = await prisma.botConfig.findUnique({
      where: { organizationId: org.id },
      // Read current opener state for an auditable deploy log, and pull the
      // greeting VOICE key — fatme's uploaded intro audio — to place at S6.
      select: {
        id: true,
        deployedAt: true,
        greeting: true,
        greetingVoiceStorageKey: true,
        scriptedFlow: true,
      },
    });

    const wasFlowEnabled =
      !!cfg?.scriptedFlow &&
      typeof cfg.scriptedFlow === 'object' &&
      (cfg.scriptedFlow as { enabled?: boolean }).enabled === true;
    const hadGreeting = !!(cfg?.greeting && cfg.greeting.trim());
    const voiceKey = cfg?.greetingVoiceStorageKey?.trim() || null;
    console.log(
      `[seed-fatme-flow] before: scriptedFlow.enabled=${wasFlowEnabled}, ` +
        `greeting=${hadGreeting ? 'set' : 'empty'}, ` +
        `greetingVoice=${voiceKey ? 'set' : 'MISSING'}, deployed=${!!cfg?.deployedAt}`,
    );

    // Place fatme's uploaded voice note on the S6 audio node. It ALSO plays at
    // the welcome via greetingVoiceOnEntry (set on the flow above), so the same
    // recording is sent at both the greeting AND the S6 drawing task.
    flow.nodes.s6_audio!.voiceKey = voiceKey;
    if (!voiceKey) {
      console.warn(
        '[seed-fatme-flow] ⚠ no greetingVoiceStorageKey set — NO voice note will play at the greeting OR at S6. ' +
          'Upload fatme’s recording in the AI bot builder (greeting voice), then re-run this seed.',
      );
    }

    if (!cfg) {
      await prisma.botConfig.create({
        data: {
          organizationId: org.id,
          scriptedFlow: flow as never,
          greeting: null, // the scripted flow is the opener
          languages: 'ar,en',
          personality: 'friendly',
          adminSystemPromptAppend: FALLBACK_PERSONA,
          deployedAt: new Date(),
        },
      });
      console.log('[seed-fatme-flow] created BotConfig + scriptedFlow (enabled) + persona + deployed');
    } else {
      await prisma.botConfig.update({
        where: { organizationId: org.id },
        data: {
          scriptedFlow: flow as never,
          greeting: null, // clear the plain greeting — the workflow is the opener
          languages: 'ar,en',
          adminSystemPromptAppend: FALLBACK_PERSONA,
          deployedAt: cfg.deployedAt ?? new Date(), // ensure deployed
        },
      });
      console.log(
        '[seed-fatme-flow] updated scriptedFlow (enabled) + persona' +
          (hadGreeting ? ' + cleared greeting' : '') +
          (cfg.deployedAt ? '' : ' + deployed'),
      );
    }

    // Business identity — so the platform (inbox, LLM fallback) knows who this is.
    const biz = await prisma.businessInfo.findFirst({
      where: { organizationId: org.id },
      select: { id: true },
    });
    if (biz) {
      await prisma.businessInfo.update({ where: { id: biz.id }, data: { legalName: 'فاطمة إسماعيل' } });
    } else {
      await prisma.businessInfo.create({
        data: { organizationId: org.id, legalName: 'فاطمة إسماعيل' },
      });
    }
    console.log('[seed-fatme-flow] business identity set (legalName=فاطمة إسماعيل)');

    console.log(
      `[seed-fatme-flow] nodes: ${Object.keys(flow.nodes).length}, entry: ${flow.entry}, ` +
        `safety: ${flow.safety.node} (screenText=${flow.safety.screenText})`,
    );
    console.log('[seed-fatme-flow] done — the S0→S8 workflow is the opener (greeting off), distress pre-check on.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
