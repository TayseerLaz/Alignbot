// Seed / update the Fatme Ismail deterministic scripted flow.
//
// Sets BotConfig.scriptedFlow (the guided button-driven intake the bot runs
// verbatim, bypassing the LLM) + ensures the bot is deployed. Idempotent — safe
// to re-run whenever the wording is refined (edit the nodes below + re-run).
//
//   set -a; . ./.env.production; set +a; \
//   pnpm --filter @aligned/db exec tsx --conditions=source scripts/seed-fatme-flow.ts
import { PrismaClient } from '@prisma/client';

const SLUG = 'fatme-ismail';

// NOTE: voiceAssetId / bookingUrl are null placeholders — filled once Fatme
// provides the audio files + booking link.
const flow = {
  enabled: true,
  channel: 'whatsapp',
  entry: 'welcome',
  nodes: {
    // Entry — intro voice (once uploaded) then the exact welcome text, which
    // asks the four questions. Their free-text answer advances to the safety check.
    welcome: {
      voiceAssetId: null as string | null,
      text: `با كيفك؟ أنا كتير سعيدة انو طريقنا تقاطع بهالمكان، أنا بحب اتواصل مع الأشخاص بشكل مباشر، بس الإتصالات بتكون كتيرة أوقات، عشان هيك عندي فريق يساعدني نظم التواصل، والفريق (يلي هوي أنا ال AI) بيسألك كم سؤال، و برجع أنا شخصياً بكمل معك.
كلامك معي، محفوظ و آمن، لأنو قداسة هالحوار و اللقاء كتير بتعنيلي.
خبريني عنك، من وين أنت؟ قديه عمرك؟ و شو وصلك لصفحتي؟
و شو أكثر شي لفتك؟

بعدين بس تجاوب، رح قلّها، شكرا كتير شاركتيني،
فاطمة دايما بتحب تتواصل مع الأشخاص من خلال اللون، عشان هيك حضرتلك تسجيل صوتي، بتسمعيه و بترسمي، و بس ترسمي و تبعتي الرسمة رح تحكيكي شخصيا، و تشاركك شو شافت بالرسمة، و تعطيكي تفاصيل ممكن تساعدك ترتاحي و تفهمي ذاتك أكثر`,
      waitFor: 'text',
      next: 'safety',
    },
    // Safety check — happens exactly once (state advances past it).
    safety: {
      text: `شكراً كتير شاركتيني 🤍

قبل ما نكمل سوا، بدي إتأكد إنك بأمان هلأ. خبريني كيفك هلأ؟`,
      buttons: [
        { title: 'بحاجة مساعدة فورية', next: 'urgent_help' },
        { title: 'أنا بأمان، بكمل', next: 'main_menu' },
      ],
      waitFor: 'button',
    },
    // Crisis referral — a dead end (no menu, no payment, no drawing).
    urgent_help: {
      text: `سمعتك، ووصولك لهون شجاعة مش ضعف.
إذا كنتِ بلبنان، اتصلي بخط الدعم النفسي "Embrace" على 1564 — يومياً من 12 ظهراً لغاية 2 بعد نص الليل.
إذا مش بلبنان، دوّري عن خط الدعم النفسي بمنطقتك، أو زوري findahelpline.com يلي بيوصلك لأقرب خط دعم بدولتك.
إذا الوضع خطر عليكِ هلأ، تواصلي فوراً مع الطوارئ المحلية عندك.
أنا هون كمان، بس لكل حدا وظيفته، ما تترددي تطلبي المساعدة من الأشخاص المكلفين فيها. 🤍`,
      action: 'end',
    },
    // Main menu — 3 tap-buttons; the 4th option ("Just connecting") is a typed
    // keyword so it fits WhatsApp's 3-button limit.
    main_menu: {
      text: `تمام 🤍 هيدي خياراتك، اختاري يلي بيناسبك:

• استشارة مجانية — مكالمة تعارف ٤٥ دقيقة
• رسم — مساحة هدوء و تواصل مع الذات
• مكالمة عاجلة — دعم سريع (مدفوعة)

وإذا بس حابة نبقى عالتواصل، اكتبيلي: تواصل`,
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
    // 1) Free consultation.
    free_consult: {
      text: `أهلاً فيكِ 🤍
هيدي مكالمة تعارف مجانية، لمدة ٤٥ دقيقة، منحكي فيها مين إنتِ هلأ، وعن وضعك الحالي ووين حاسة إنك محتاجة ترافق.
هيدي مساحة نتعرف فيها عبعض ونشوف إذا الطريق يلي عم اشتغل فيه هوي الطريق المناسب إلك.
إذا حابة تكمّلي، خبريني الوقت المناسب إلك وابعتلك رابط الحجز.`,
      waitFor: 'text',
      next: 'free_consult_done',
    },
    free_consult_done: {
      text: `يسلمو 🤍 فاطمة رح تتواصل معك و تبعتلك رابط الحجز بأقرب وقت.`,
      action: 'handoff',
    },
    // 2) Draw.
    draw_intro: {
      text: `حضرتلك هيدي المساحة هون، لحتى مهدّلك الطريق لتعرفي كيف تتواصلي مع ذاتك بهدوء وحُب.
إختاري يلي بتحسي انك بحاجة اله هلأ.`,
      buttons: [
        { title: 'تفريغ مشاعر', next: 'draw_release' },
        { title: 'اتواصل مع ذاتي', next: 'draw_connect' },
      ],
      waitFor: 'button',
    },
    draw_release: {
      voiceAssetId: null as string | null,
      text: `بعرف أحياناً بتكون الأمور موترة، وبتكوني مليانة مشاعر مش واضحة. إسمعي هيدا التسجيل، واتبعي خطواتك، وبتمنى فعلاً يساعدك. أهم شي، تكوني عنجد أنتِ جاهزة تستقبلي المساعدة.
كوني بمكان آمن، واستقبليه، بس تسمعيه وتطبقيه، رح اتشرف بإستقبال رسمتك (بس فاطمة شخصيا رح تشوف الرسمة و تتواصل معك مباشرة).
ببعتلك سلام وحب. 🤍`,
      waitFor: 'image',
      next: 'draw_receipt',
    },
    draw_connect: {
      voiceAssetId: null as string | null,
      text: `كتير مذهلة هالخطوة، بس توصلي لهيدي المرحلة، يعني أنتِ بلشتي تعرفي انو نحنا الوعاء للمشاعر، ونحنا قادرين نرتقي بذاتنا.
هيدا تسجيل صوتي، لقلبك مباشرة، بس تسمعيه وتطبقيه، رح اتشرف بإستقبال رسمتك.
ببعتلك كتير سلام وإرتقاء. 🤍`,
      waitFor: 'image',
      next: 'draw_receipt',
    },
    // Unified receipt after any drawing is sent.
    draw_receipt: {
      text: `وصلتني رسمتك.
شكراً إنك وثقتي فيّ و بذاتك.
فاطمة رح تكون معك بأقرب وقت، و رح تتواصل معك مباشرة. هلأ اشربي مي، و اتمشي شوي اذا بتقدري، و تحركي. منشوفك عخير.. 🤍`,
      action: 'handoff',
    },
    // 3) Just connecting.
    just_connecting: {
      text: `هلأ صارت معلوماتك معنا، منتشرف فيكي، وبس يكون في نشاط أو حدث رح تكوني أول العارفين.
شكراً جزيلاً، منبعتلك سلام و محبة 🤍`,
      action: 'end',
    },
    // 4) Urgent call (paid).
    urgent_call: {
      text: `هيدا الخيار موجود للدعم السريع لما بتكون عندك مشكلة سريعة وبدك تحلّيها، أو الموضوع وصل عند حده، وما قادرة تتعاملي مع مشاعرك.
رح يكون لقاء لمدة ساعة لساعة و نص، بحسب الإحتياج، و رح نكون عم نفرغ من خلال الفن، و عم نتواصل مع القصة و نتعمق فيها حتى تقدري تلاقي حلّك.
وهيدي الخدمة غير مجانية. سعر الخدمة السريعة: 127$
إذا بدك تاخدي الخطوة الجاي، خبريني و لشوف أقرب موعد وابعتلك رابط الدفع.`,
      waitFor: 'text',
      next: 'urgent_call_done',
    },
    urgent_call_done: {
      text: `تمام 🤍 فاطمة رح تتواصل معك بأقرب وقت و تبعتلك رابط الدفع و الموعد.`,
      action: 'handoff',
    },
  },
};

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.findUnique({ where: { slug: SLUG }, select: { id: true } });
    if (!org) throw new Error(`org '${SLUG}' not found`);

    const cfg = await prisma.botConfig.findUnique({
      where: { organizationId: org.id },
      select: { id: true, deployedAt: true },
    });
    if (!cfg) {
      await prisma.botConfig.create({
        data: { organizationId: org.id, scriptedFlow: flow as never, deployedAt: new Date() },
      });
      console.log('[seed-fatme-flow] created BotConfig + scriptedFlow + deployed');
    } else {
      await prisma.botConfig.update({
        where: { organizationId: org.id },
        data: {
          scriptedFlow: flow as never,
          deployedAt: cfg.deployedAt ?? new Date(), // ensure deployed so the bot runs
        },
      });
      console.log('[seed-fatme-flow] updated scriptedFlow' + (cfg.deployedAt ? '' : ' + deployed'));
    }
    console.log(`[seed-fatme-flow] nodes: ${Object.keys(flow.nodes).length}, entry: ${flow.entry}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
