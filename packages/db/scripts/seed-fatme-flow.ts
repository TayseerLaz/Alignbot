// Fatme Ismail — FULL deterministic tappable-button intake flow.
//
// welcome (voice) → safety check (buttons) → 5 intake questions (typed, one at a
// time) → thanks → main menu (buttons: free consult / drawing / urgent call /
// "تواصل") → the chosen path → drawing (send a photo) → handoff to Fatima.
// The AI distress pre-check (safety.screenText) diverts any free-text answer that
// signals a crisis. Runs verbatim, no LLM per reply (cheap). Idempotent.
//
//   set -a; . ./.env.production; set +a; \
//   pnpm --filter @aligned/db exec tsx --conditions=source scripts/seed-fatme-flow.ts
import { PrismaClient } from '@prisma/client';

const SLUG = 'fatme-ismail';

// Levantine fallback persona — only used if the scripted flow ever errors and the
// LLM path takes over. Keeps identity + tone on-brand in that rare case.
const FALLBACK_PERSONA = `إنتِ "فريق فاطمة" — مساعِدة بترحّبي بالأشخاص الجدد على واتساب نيابةً عن فاطمة إسماعيل. احكي باللهجة اللبنانية/الشامية بدفا وهدوء. إنتِ مش فاطمة ولا معالِجة نفسية. إذا حدا عبّر عن ضيق شديد أو أذية لحالو، طمّنو بدفا وذكّرو بخطوط الدعم (بلبنان Embrace 1564) وسلّمو لفاطمة. جاوبي بس عن فاطمة وخدمتها.`;

const flow = {
  enabled: true,
  channel: 'whatsapp',
  entry: 's0_welcome',
  // AI distress pre-check on every free-text answer → diverts to the crisis node.
  safety: { node: 'crisis', screenText: true },
  // Play fatme's voice note at the welcome (entry).
  greetingVoiceOnEntry: true,
  nodes: {
    // ---- WELCOME (3 bubbles, voice plays at entry) ----
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

    // ---- SAFETY CHECK (buttons) ----
    safety_check: {
      text: `قبل ما نكمل سوا 🤍 بدي إطمئن عليكِ — كيفك هلأ؟`,
      buttons: [
        { title: 'أنا بأمان، بكمل', next: 'q_name' },
        { title: 'بحاجة مساعدة فورية', next: 'crisis' },
      ],
      waitFor: 'button',
    },
    // CRISIS — also the AI-distress diversion target. Never runs the drawing.
    crisis: {
      text: `واضح إنك عم تمرّي بشي تقيل، وأنا هون معك 🤍 خليني وصّلك بفاطمة شخصياً هلّق.`,
      auto: true,
      next: 'crisis_resources',
    },
    crisis_resources: {
      text: `وإذا حسّيتي إنك بحاجة دعم فوري: بلبنان في خط دعم نفسي اسمو Embrace على الرقم 1564، بيشتغل كل يوم من الـ ١٢ الظهر لـ ٢ بعد نص الليل. إذا مش بلبنان، فيكِ تزوري findahelpline.com. وإذا الوضع خطر عليكِ هلق، تواصلي فوراً مع الطوارئ المحلية عندك. أنا هون كمان، بس لكل حدا وظيفتو 🤍`,
      action: 'handoff',
    },

    // ---- INTAKE QUESTIONS (typed, one at a time) ----
    q_name: { text: `شو اسمك الكريم؟`, waitFor: 'text', next: 'q_origin' },
    q_origin: { text: `أهلين فيكِ 🌷 من وين إنتِ؟`, waitFor: 'text', next: 'q_age' },
    q_age: {
      text: `وقدّيش عمرك؟ (وإذا ما بتحبي تحكي عمرك، ولا يهمّك 🌷)`,
      waitFor: 'text',
      next: 'q_how_found',
    },
    q_how_found: { text: `وشو وصّلك لصفحة فاطمة؟`, waitFor: 'text', next: 'q_email' },
    q_email: {
      text: `وإذا بتحبي، اتركيلي إيميلك 💌 لنبقى عالتواصل ونبعتلك كل جديد.`,
      waitFor: 'text',
      next: 'thanks',
    },

    // ---- THANKS + MAIN MENU (buttons) ----
    thanks: {
      text: `شكراً كتير إنك شاركتيني هالشي 🌷 بقدّر ثقتك كتير.`,
      auto: true,
      next: 'main_menu',
    },
    main_menu: {
      text: `هيدي خياراتك، اختاري يلي بيناسبك 🤍

• استشارة مجانية — مكالمة تعارف ٤٥ دقيقة
• رسم — مساحة هدوء وتواصل مع الذات
• مكالمة عاجلة — دعم سريع (مدفوعة)

وإذا حابة نبقى عالتواصل بس، اكتبيلي: تواصل`,
      buttons: [
        { title: 'استشارة مجانية', next: 'free_consult' },
        { title: 'رسم', next: 'draw_intro' },
        { title: 'مكالمة عاجلة', next: 'urgent_call' },
      ],
      keywords: [
        { match: 'تواصل', next: 'just_connecting' },
        { match: 'connect', next: 'just_connecting' },
      ],
      waitFor: 'button',
    },

    // ---- 1) FREE CONSULTATION ----
    free_consult: {
      text: `أهلاً فيكِ 🤍 هيدي مكالمة تعارف مجانية لمدة ٤٥ دقيقة، منحكي فيها مين إنتِ هلأ ووين حاسة إنك محتاجة ترافق. إذا حابة تكمّلي، خبريني الوقت المناسب إلك وابعتلك رابط الحجز.`,
      waitFor: 'text',
      next: 'free_consult_done',
    },
    free_consult_done: {
      text: `يسلمو 🤍 فاطمة رح تتواصل معك وتبعتلك رابط الحجز بأقرب وقت.`,
      action: 'handoff',
    },

    // ---- 2) DRAWING ----
    draw_intro: {
      text: `حضرتلك هيدي المساحة لحتى تعرفي كيف تتواصلي مع ذاتك بهدوء وحُب. إختاري يلي بتحسي إنك بحاجة اله هلأ.`,
      buttons: [
        { title: 'تفريغ مشاعر', next: 'draw_release' },
        { title: 'اتواصل مع ذاتي', next: 'draw_connect' },
      ],
      waitFor: 'button',
    },
    draw_release: {
      voiceKey: null as string | null, // injected below (fatme's recording)
      text: `بعرف أحياناً بتكون الأمور موترة وبتكوني مليانة مشاعر مش واضحة. إسمعي هيدا التسجيل واتبعي خطواتك. كوني بمكان آمن، وبس تسمعيه وتطبقيه، إبعتيلي الرسمة كصورة 🤍`,
      waitFor: 'image',
      next: 'draw_receipt',
      repromptText: `خدي وقتك 💛 بس تخلّصي الرسمة، إبعتيها هون.`,
    },
    draw_connect: {
      voiceKey: null as string | null, // injected below
      text: `كتير مذهلة هالخطوة، يعني أنتِ بلشتي تعرفي إنو نحنا الوعاء للمشاعر وقادرين نرتقي بذاتنا. هيدا تسجيل صوتي لقلبك مباشرة، بس تسمعيه وتطبقيه إبعتيلي الرسمة كصورة 🤍`,
      waitFor: 'image',
      next: 'draw_receipt',
      repromptText: `خدي وقتك 💛 بس تخلّصي الرسمة، إبعتيها هون.`,
    },
    draw_receipt: {
      text: `وصلتني رسمتك 🤍 شكراً إنك وثقتي فيّ وبذاتك. فاطمة رح تشوف رسمتك وتتواصل معك مباشرة بأقرب وقت. هلأ اشربي مي واتمشي شوي إذا بتقدري. منشوفك عخير 🌸`,
      action: 'handoff',
    },

    // ---- 3) URGENT CALL (paid) ----
    urgent_call: {
      text: `هيدا الخيار موجود للدعم السريع لما يكون الموضوع وصل عند حده وما قادرة تتعاملي مع مشاعرك. رح يكون لقاء من ساعة لساعة ونص حسب الإحتياج، منفرّغ من خلال الفن ونتعمق بالقصة حتى تلاقي حلّك. سعر الخدمة السريعة: 127$. إذا بدك تاخدي الخطوة الجاي، خبريني ولشوف أقرب موعد وابعتلك رابط الدفع.`,
      waitFor: 'text',
      next: 'urgent_call_done',
    },
    urgent_call_done: {
      text: `تمام 🤍 فاطمة رح تتواصل معك بأقرب وقت وتبعتلك رابط الدفع والموعد.`,
      action: 'handoff',
    },

    // ---- 4) JUST CONNECTING ----
    just_connecting: {
      text: `هلأ صارت معلوماتك معنا، منتشرف فيكي، وبس يكون في نشاط أو حدث رح تكوني أول العارفين. شكراً جزيلاً، منبعتلك سلام ومحبة 🤍`,
      action: 'end',
    },
  },
} as {
  enabled: boolean;
  channel: string;
  entry: string;
  safety: { node: string; screenText: boolean };
  greetingVoiceOnEntry: boolean;
  nodes: Record<string, { voiceKey?: string | null; [k: string]: unknown }>;
};

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.findUnique({ where: { slug: SLUG }, select: { id: true } });
    if (!org) throw new Error(`org '${SLUG}' not found`);

    const cfg = await prisma.botConfig.findUnique({
      where: { organizationId: org.id },
      select: { id: true, deployedAt: true, greetingVoiceStorageKey: true },
    });
    const voiceKey = cfg?.greetingVoiceStorageKey?.trim() || null;
    console.log(`[seed-fatme] before: greetingVoice=${voiceKey ? 'set' : 'MISSING'}, deployed=${!!cfg?.deployedAt}`);
    if (!voiceKey) {
      console.warn('[seed-fatme] ⚠ no greetingVoiceStorageKey — NO voice will play at the welcome OR the drawing step. Upload it in the AI bot builder (greeting voice) + save, then re-run.');
    }
    // fatme's one recording plays at the welcome (via greetingVoiceOnEntry) AND at
    // the drawing step (inject into both draw nodes).
    flow.nodes.draw_release!.voiceKey = voiceKey;
    flow.nodes.draw_connect!.voiceKey = voiceKey;

    const data = {
      scriptedFlow: flow as never,
      greeting: null, // the scripted flow is the opener
      languages: 'ar,en',
      personality: 'friendly',
      adminSystemPromptAppend: FALLBACK_PERSONA,
      deployedAt: cfg?.deployedAt ?? new Date(),
    };
    if (!cfg) {
      await prisma.botConfig.create({ data: { organizationId: org.id, ...data } });
      console.log('[seed-fatme] created BotConfig + scriptedFlow (buttons) + deployed');
    } else {
      await prisma.botConfig.update({ where: { organizationId: org.id }, data });
      console.log('[seed-fatme] updated → deterministic tappable-button flow' + (cfg.deployedAt ? '' : ' + deployed'));
    }

    const biz = await prisma.businessInfo.findFirst({ where: { organizationId: org.id }, select: { id: true } });
    if (biz) await prisma.businessInfo.update({ where: { id: biz.id }, data: { legalName: 'فاطمة إسماعيل' } });
    else await prisma.businessInfo.create({ data: { organizationId: org.id, legalName: 'فاطمة إسماعيل' } });

    console.log(`[seed-fatme] done — ${Object.keys(flow.nodes).length} nodes, entry=${flow.entry}, safety=${flow.safety.node}. fatme is now a TAPPABLE-BUTTON flow.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
