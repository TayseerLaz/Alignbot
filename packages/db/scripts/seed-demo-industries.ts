// Demo tenants for the hader.ai industry section's Web-chat (Clinics / Education /
// B2B — the categories we had no real tenant for). Each gets a persona (BotConfig),
// business info, a small catalog, and FAQs so the public /public/demo-chat endpoint
// can route to them. Idempotent: safe to re-run.
//
// Run:  pnpm --filter @aligned/db exec tsx --conditions=source packages/db/scripts/seed-demo-industries.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface Svc { name: string; slug: string; desc: string; minutes: number; priceMinor: number }
interface Prod { sku: string; name: string; slug: string; desc: string; priceMinor: number }
interface Demo {
  slug: string;
  name: string;
  legalName: string;
  tagline: string;
  about: string;
  greeting: string;
  persona: string;
  services?: Svc[];
  products?: Prod[];
  faqs: Array<{ q: string; a: string }>;
}

const DEMOS: Demo[] = [
  {
    slug: 'demo-clinic',
    name: 'Cedar Health Clinic',
    legalName: 'Cedar Health Clinic',
    tagline: 'Friendly, modern healthcare in the heart of the city.',
    about: 'Cedar Health Clinic is a family clinic offering general consultations, dental care, dermatology, physiotherapy and lab tests. Open Monday to Saturday, 9 AM – 6 PM. Walk-ins welcome; appointments recommended.',
    greeting: 'Hello and welcome to Cedar Health Clinic 🌿 How can I help — booking an appointment, our services, or opening hours?',
    persona:
      'You are the warm, reassuring virtual receptionist for Cedar Health Clinic. Help patients understand our services and prices, our hours (Mon–Sat, 9 AM–6 PM), and book appointments (collect the service, preferred day/time, name and phone). You may say we accept most major insurance and take walk-ins. NEVER give medical advice, a diagnosis, or medication guidance — for anything clinical, warmly say a doctor will advise at the visit and offer to book one. Keep replies short and caring.',
    services: [
      { name: 'General Consultation', slug: 'general-consultation', desc: 'See a GP for any concern. About 30 minutes.', minutes: 30, priceMinor: 3000 },
      { name: 'Dental Cleaning', slug: 'dental-cleaning', desc: 'Professional scaling & polishing. About 45 minutes.', minutes: 45, priceMinor: 5000 },
      { name: 'Skin Check-up', slug: 'skin-checkup', desc: 'Dermatology review of skin concerns.', minutes: 30, priceMinor: 4000 },
      { name: 'Physiotherapy Session', slug: 'physiotherapy-session', desc: 'One-on-one physio, per 60-minute session.', minutes: 60, priceMinor: 4500 },
      { name: 'Blood Test Panel', slug: 'blood-test-panel', desc: 'Standard lab panel with results in 24h.', minutes: 15, priceMinor: 6000 },
      { name: 'Vaccination', slug: 'vaccination', desc: 'Routine adult & child vaccinations.', minutes: 15, priceMinor: 2500 },
    ],
    faqs: [
      { q: 'What are your opening hours?', a: 'We are open Monday to Saturday, 9 AM to 6 PM, and closed on Sundays.' },
      { q: 'Do you accept insurance?', a: 'Yes, we accept most major insurance providers. Bring your card and we will handle the paperwork.' },
      { q: 'How do I book an appointment?', a: 'Just tell me the service, your preferred day and time, your name and a phone number, and I will reserve it for you.' },
      { q: 'Do you take walk-ins?', a: 'Yes, walk-ins are welcome during opening hours, though booking ahead means little to no wait.' },
      { q: 'Where are you located?', a: 'We are in the city centre with parking available. I can share the exact map pin when you book.' },
    ],
  },
  {
    slug: 'demo-school',
    name: 'Bright Minds Academy',
    legalName: 'Bright Minds Academy',
    tagline: 'Courses, tutoring and camps that make learning click.',
    about: 'Bright Minds Academy offers language courses, tutoring, exam prep, kids coding and summer camps for ages 6–18. In-person and online. New terms start every month.',
    greeting: 'Hi there! 👋 Welcome to Bright Minds Academy. Looking into a course, tutoring, or our summer camp?',
    persona:
      'You are the friendly admissions assistant for Bright Minds Academy. Help parents and students explore our courses and fees, age groups (6–18), whether classes are in-person or online, and when terms start (a new term every month). When someone is interested, collect the student’s name, age, the course, and a contact number so an advisor can follow up. Be encouraging and concise. Do not promise specific exam scores.',
    services: [
      { name: 'English Course', slug: 'english-course', desc: 'Beginner to advanced, per 8-week term.', minutes: 60, priceMinor: 12000 },
      { name: 'Math Tutoring', slug: 'math-tutoring', desc: 'One-on-one, per session.', minutes: 60, priceMinor: 2500 },
      { name: 'Kids Coding Bootcamp', slug: 'kids-coding-bootcamp', desc: 'Scratch & Python for ages 8–14, per course.', minutes: 90, priceMinor: 20000 },
      { name: 'IELTS Prep', slug: 'ielts-prep', desc: 'Intensive exam preparation course.', minutes: 90, priceMinor: 18000 },
      { name: 'Summer Camp', slug: 'summer-camp', desc: 'Fun + learning, per week, ages 6–12.', minutes: 300, priceMinor: 15000 },
      { name: 'Private Tutoring', slug: 'private-tutoring', desc: 'Any subject, per hour.', minutes: 60, priceMinor: 3000 },
    ],
    faqs: [
      { q: 'How do I enroll?', a: 'Tell me the course, the student’s name and age, and a phone number — an advisor will confirm your place and next start date.' },
      { q: 'What ages do you teach?', a: 'We teach ages 6 to 18, with courses grouped by level and age.' },
      { q: 'Do you offer online classes?', a: 'Yes — most courses are available both in-person and live online.' },
      { q: 'When does the next term start?', a: 'A new term starts every month. Tell me the course and I’ll give you the nearest start date.' },
      { q: 'What are the fees?', a: 'Fees vary by course — for example the English course is $120 per term and private tutoring is $30 per hour. Ask about any course for its price.' },
    ],
  },
  {
    slug: 'demo-b2b',
    name: 'Cedar Supply Co.',
    legalName: 'Cedar Supply Co.',
    tagline: 'Wholesale packaging, cleaning and office supplies — delivered.',
    about: 'Cedar Supply Co. is a B2B wholesaler of packaging, cleaning and office supplies for businesses. Minimum order $150. Volume discounts available. Delivery across the region in 2–4 business days.',
    greeting: 'Welcome to Cedar Supply Co. 📦 Looking for a quote, a product, or our order terms?',
    persona:
      'You are a professional B2B sales rep for Cedar Supply Co., a wholesale supplier. Help business buyers find products and prices, explain our minimum order ($150), volume discounts, payment terms (Net-30 for approved accounts), and delivery (2–4 business days). Qualify the lead: ask what they need, quantities, and their company + contact so we can send a formal quote. Be efficient and businesslike.',
    products: [
      { sku: 'PKG-KRAFT', name: 'Kraft Packaging Boxes', slug: 'kraft-packaging-boxes', desc: 'Sturdy kraft mailer boxes. Priced per unit, MOQ 500.', priceMinor: 40 },
      { sku: 'CLN-PALLET', name: 'Cleaning Supplies Pallet', slug: 'cleaning-supplies-pallet', desc: 'Mixed cleaning pallet: detergents, wipes, sprays.', priceMinor: 12000 },
      { sku: 'PPR-A4', name: 'A4 Office Paper (Case)', slug: 'a4-office-paper-case', desc: 'Case of 5 reams, 80 gsm.', priceMinor: 2800 },
      { sku: 'GLV-CARTON', name: 'Disposable Gloves (Carton)', slug: 'disposable-gloves-carton', desc: 'Nitrile gloves, carton of 1,000.', priceMinor: 4500 },
      { sku: 'BAG-ROLL', name: 'Industrial Trash Bags (Roll)', slug: 'industrial-trash-bags-roll', desc: 'Heavy-duty, roll of 200.', priceMinor: 1800 },
      { sku: 'SAN-5L', name: 'Hand Sanitizer 5L', slug: 'hand-sanitizer-5l', desc: '70% alcohol gel, 5-litre refill.', priceMinor: 2200 },
    ],
    faqs: [
      { q: 'What is your minimum order?', a: 'Our minimum order is $150. Volume discounts kick in on larger quantities.' },
      { q: 'How do I get a quote?', a: 'Tell me the products and quantities plus your company name and a contact, and I’ll prepare a formal quote for you.' },
      { q: 'What are your payment terms?', a: 'We offer Net-30 for approved business accounts, and card or transfer for first orders.' },
      { q: 'Do you deliver?', a: 'Yes — we deliver across the region within 2 to 4 business days.' },
      { q: 'Do you offer volume discounts?', a: 'Absolutely. Share your target quantities and I’ll include tiered pricing in your quote.' },
    ],
  },
];

async function seedOne(spec: Demo): Promise<void> {
  await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);

  const org = await prisma.organization.upsert({
    where: { slug: spec.slug },
    update: { name: spec.name },
    create: { slug: spec.slug, name: spec.name },
  });

  await prisma.businessInfo.upsert({
    where: { organizationId: org.id },
    update: { legalName: spec.legalName, tagline: spec.tagline, about: spec.about, currency: 'USD' },
    create: { organizationId: org.id, legalName: spec.legalName, tagline: spec.tagline, about: spec.about, currency: 'USD' },
  });

  await prisma.botConfig.upsert({
    where: { organizationId: org.id },
    update: { adminSystemPromptAppend: spec.persona, languages: 'en,ar', greeting: spec.greeting, deployedAt: new Date() },
    create: { organizationId: org.id, adminSystemPromptAppend: spec.persona, languages: 'en,ar', greeting: spec.greeting, deployedAt: new Date() },
  });

  for (const s of spec.services ?? []) {
    await prisma.service.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug: s.slug } },
      update: { name: s.name, shortDescription: s.desc, durationMinutes: s.minutes, basePriceMinor: s.priceMinor, currency: 'USD', priceUnit: 'flat', isAvailable: true },
      create: { organizationId: org.id, name: s.name, slug: s.slug, shortDescription: s.desc, durationMinutes: s.minutes, basePriceMinor: s.priceMinor, currency: 'USD', priceUnit: 'flat', isAvailable: true },
    });
  }
  for (const p of spec.products ?? []) {
    await prisma.product.upsert({
      where: { organizationId_sku: { organizationId: org.id, sku: p.sku } },
      update: { name: p.name, slug: p.slug, shortDescription: p.desc, priceMinor: p.priceMinor, currency: 'USD', isAvailable: true },
      create: { organizationId: org.id, sku: p.sku, name: p.name, slug: p.slug, shortDescription: p.desc, priceMinor: p.priceMinor, currency: 'USD', isAvailable: true },
    });
  }
  for (const f of spec.faqs) {
    const existing = await prisma.fAQ.findFirst({ where: { organizationId: org.id, question: f.q } });
    if (!existing) {
      await prisma.fAQ.create({
        data: { organizationId: org.id, question: f.q, answer: f.a, visibility: 'public', isPublished: true },
      });
    } else {
      await prisma.fAQ.update({ where: { id: existing.id }, data: { answer: f.a, isPublished: true } });
    }
  }

  const svc = spec.services?.length ?? 0;
  const prod = spec.products?.length ?? 0;
  console.warn(`[demo] ✔ ${spec.slug} — ${spec.legalName} · ${svc} services, ${prod} products, ${spec.faqs.length} FAQs`);
}

async function main() {
  console.warn('[demo] seeding demo industry tenants…');
  for (const spec of DEMOS) await seedOne(spec);
  console.warn('[demo] done. The /public/demo-chat endpoint now serves clinics / education / b2b.');
}

main()
  .catch((err) => {
    console.error('[demo] failed', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
