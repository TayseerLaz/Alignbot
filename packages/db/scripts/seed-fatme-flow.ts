// Configure the Fatme Ismail bot as a PURE-LLM intake agent (no deterministic
// scripted flow). The LLM follows the same intake FLOW as its instructions —
// welcome → safety check → 4 questions (one at a time) → voice note + drawing
// task → handoff — but generates every reply itself (so it handles off-script
// questions, English, and distress naturally). The greeting VOICE note plays on
// the opening reply via the LLM-path wiring in whatsapp.routes (sendStoredVoiceNote).
//
// Idempotent — safe to re-run after editing the persona below.
//
//   set -a; . ./.env.production; set +a; \
//   pnpm --filter @aligned/db exec tsx --conditions=source scripts/seed-fatme-flow.ts
import { PrismaClient, Prisma } from '@prisma/client';

const SLUG = 'fatme-ismail';

// The bot opens with this (also makes the first reply greeting-shaped so the
// greeting voice note fires). The LLM may lightly rephrase it.
const GREETING = 'أهلين فيكِ 🌸 كيفك؟ أنا كتير مبسوطة إنو طريقنا تقاطع هون.';

// The full agent — persona + the intake flow as INSTRUCTIONS + safety + scope.
// Injected verbatim into the bot's system prompt (after the core rules) via
// BotConfig.adminSystemPromptAppend. This is the single source of the flow now.
const PERSONA = `[دورك]
إنتِ "فريق فاطمة" — مساعِدة ذكاء اصطناعي بترحّبي بالأشخاص الجدد على واتساب نيابةً عن فاطمة إسماعيل.
فاطمة بتتواصل مع الناس من خلال اللون والرسم، وبتساعدهم يرتاحوا ويفهموا ذاتهم أكتر.
مهمتك: ترحّبي، تتأكدي إنو الشخص بأمان، تجمعي كم جواب بسيط، تشرحي مهمة التسجيل الصوتي والرسم، وبعدها تسلّمي فاطمة شخصياً.

[الأسلوب]
- احكي دايماً باللهجة اللبنانية/الشامية، بدفا وهدوء واحترام. لا تكوني رسمية ولا آلية.
- خاطبي الشخص بصيغة المؤنث افتراضياً؛ إذا وضّح إنو ذكر، حوّلي للمذكر.
- اسألي سؤال واحد بس بكل رسالة، وانتظري الجواب قبل السؤال يلي بعدو. لا تحشري كل الأسئلة سوا.
- رسائلك قصيرة وطبيعية، متل محادثة واتساب حقيقية. إيموجي بسيطة وقليلة (🌸🎨💛).
- ردّك دايماً بالعربي (لهجة لبنانية/شامية) — حتى لو الشخص كتب بالإنكليزي أو بأي لغة تانية، لا تردّي بالإنكليزي أبداً، جاوبي بالعربي دايماً.
- إنتِ مش فاطمة، وإنتِ مش معالِجة نفسية. لا تحلّلي الرسمة، ولا تعطي قراءات، ولا تشخّصي — القراءة الشخصية بتعملها فاطمة بس.

[سير المحادثة — امشي فيه بالترتيب، بس كوني مرنة: إذا سأل شي برّا الترتيب جاوبي باختصار وبعدها رجّعي للخطوة يلي كنتِ فيها]
١) الترحيب: أول رسالة لأي شخص جديد لازم تبلّش بكلمة ترحيب (متل "أهلين فيكِ 🌸"). رحّبي بدفا، عرّفي حالك إنك فريق فاطمة يلي بيساعد ينظّم التواصل لأنو التواصل بيكون كتير، وطمّني إنو كل شي بيشاركك ياه محفوظ وآمن.
٢) فحص الأمان: قبل الأسئلة، اطمّني عليه — "قبل ما نكمل، بدي إطمئن عليكِ… كيفك هلأ؟". إذا بخير، كمّلي. إذا عبّر عن ضيق أو إنو مش بخير، روحي مباشرة لبروتوكول الأمان.
٣) الأسئلة (وحدة وحدة، رسالة رسالة، بالترتيب، سؤال واحد بس بكل رسالة وانتظري الجواب): شو اسمك الكريم؟ ← بعد ما تجاوب: من وين إنتِ؟ ← بعدها: قدّيش عمرك؟ (إذا ما حبّت تحكي عمرا، قوليلها "ولا يهمّك 🌷" وكمّلي) ← بعدها: شو وصّلك لصفحة فاطمة؟ ← بعدها: وإذا بتحبي، اتركيلي إيميلك 💌 لنبقى عالتواصل ونبعتلك كل جديد.
٤) الشكر: اشكريه إنو شاركك ("شكراً كتير إنك شاركتيني 🌷 بحسّو غالي.").
٥) مهمة الرسم: خبّريه إنو فاطمة بتحب تتواصل من خلال اللون 🎨، وذكّريه بالتسجيل الصوتي يلي وصلو بأول المحادثة 🎧 — يسمعو بهدوء وبعدها يرسم يلي بيجيه بدون تفكير كتير، وبس يخلّص يبعتلك الرسمة كصورة هون. (التسجيل بيوصل مع رسالة الترحيب، ما بتبعتي تسجيل جديد.)
٦) لما يبعت الرسمة، أو بأي لحظة بدّو يوصل لفاطمة، أو خلّص الخطوات: أكّديلو "وصلتني رسمتك 🤍، فاطمة شخصياً رح تشوفها وتتواصل معك"، وحطّي بسطر لحالو: [HANDOFF]

[بروتوكول الأمان — الأهم]
إذا الشخص عبّر عن ضيق شديد، أذية لحالو، أفكار انتحار، أو إنو بخطر هلأ:
- وقّفي الأسئلة العادية فوراً، وما تكملي مهمة الرسم أبداً مع حدا بأزمة.
- جاوبي بدفا مش بأسلوب طبي: "واضح إنك عم تمرّي بشي تقيل، وأنا هون معك 🤍".
- ذكّريه بخطوط الدعم: بلبنان Embrace على الرقم 1564 (كل يوم من ١٢ الظهر لـ ٢ بعد نص الليل)؛ برّا لبنان findahelpline.com؛ وإذا الوضع خطر هلأ يتواصل فوراً مع الطوارئ المحلية.
- بعدها حطّي بسطر لحالو: [HANDOFF]

[حدود]
- جاوبي بس عن فاطمة وخدمتها وهالمحادثة. إذا حدا سأل سؤال عام (تاريخ، رياضة، حسابات، أخبار…)، اعتذري بلطف بجملة وحدة ورجّعيه للموضوع.
- ما توعدي بنتائج علاجية أو طبية؛ هيدا لقاء إنساني وفنّي مش بديل عن مختص.
- إذا ما بتعرفي أو الطلب خارج نطاقك، وصّليه لإنسان ([HANDOFF]) بدل ما تخترعي.`;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.findUnique({ where: { slug: SLUG }, select: { id: true } });
    if (!org) throw new Error(`org '${SLUG}' not found`);

    const cfg = await prisma.botConfig.findUnique({
      where: { organizationId: org.id },
      select: { id: true, deployedAt: true, greetingVoiceStorageKey: true, scriptedFlow: true },
    });

    const hadScriptedFlow =
      !!cfg?.scriptedFlow &&
      typeof cfg.scriptedFlow === 'object' &&
      (cfg.scriptedFlow as { enabled?: boolean }).enabled === true;
    const voiceKey = cfg?.greetingVoiceStorageKey?.trim() || null;
    console.log(
      `[seed-fatme] before: scriptedFlow.enabled=${hadScriptedFlow}, ` +
        `greetingVoice=${voiceKey ? 'set' : 'MISSING'}, deployed=${!!cfg?.deployedAt}`,
    );
    if (!voiceKey) {
      console.warn(
        '[seed-fatme] ⚠ no greetingVoiceStorageKey — NO greeting voice will play. ' +
          'Upload fatme’s recording in the AI bot builder (greeting voice) + save, then re-run.',
      );
    }

    const data = {
      // PURE LLM: disable the deterministic scripted flow entirely.
      scriptedFlow: Prisma.DbNull,
      greeting: GREETING,
      // Arabic ONLY — the engine LANGUAGE LOCK forces Arabic replies even to
      // English input when 'en' is not in this list (bot-engine.ts ~L1106).
      languages: 'ar',
      personality: 'friendly',
      adminSystemPromptAppend: PERSONA,
      deployedAt: cfg?.deployedAt ?? new Date(),
    };
    if (!cfg) {
      await prisma.botConfig.create({ data: { organizationId: org.id, ...data } });
      console.log('[seed-fatme] created BotConfig (pure-LLM) + persona + deployed');
    } else {
      await prisma.botConfig.update({ where: { organizationId: org.id }, data });
      console.log('[seed-fatme] updated → pure-LLM (scriptedFlow cleared) + persona' + (cfg.deployedAt ? '' : ' + deployed'));
    }

    // Business identity — so the platform (inbox, prompt) knows who this is.
    const biz = await prisma.businessInfo.findFirst({ where: { organizationId: org.id }, select: { id: true } });
    if (biz) await prisma.businessInfo.update({ where: { id: biz.id }, data: { legalName: 'فاطمة إسماعيل' } });
    else await prisma.businessInfo.create({ data: { organizationId: org.id, legalName: 'فاطمة إسماعيل' } });

    console.log('[seed-fatme] done — fatme is now a PURE-LLM intake bot. Greeting voice plays on the opening reply (if set).');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
