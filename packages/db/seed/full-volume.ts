// Full Volume tenant seed — a high-protein sandwich shop.
// Run with: pnpm --filter @aligned/db exec tsx ./seed/full-volume.ts
//
// Idempotent: safe to re-run. Creates the org + admin user, the full
// menu (categories + products with macros), business info (hours +
// cart/shop form), locations, contact channels, FAQs, policies, a bot
// persona, and a read-API key (secret printed once on first run).
//
// Source of truth for the menu: full-volume-menu.html.
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';

const prisma = new PrismaClient();

const SLUG = 'full-volume';
const NAME = 'Full Volume';
const ADMIN_EMAIL = 'admin@fullvolume.example';
const PASSWORD = 'FullVolume123!';
const CURRENCY = 'USD';

// USD → minor units (cents).
const usd = (dollars: number): number => Math.round(dollars * 100);

interface CategorySpec {
  slug: string;
  name: string;
  description: string;
  sortOrder: number;
}

const CATEGORIES: CategorySpec[] = [
  { slug: 'build-your-own', name: 'Build Your Own', description: 'Pick your bread, protein, veggies and sauce.', sortOrder: 1 },
  { slug: 'signature-drops', name: 'Signature Drops', description: 'Our fan-favourite sandwiches.', sortOrder: 2 },
  { slug: 'high-protein-series', name: 'High Protein Series', description: 'Max-gains sandwiches and wraps.', sortOrder: 3 },
  { slug: 'protein-desserts', name: 'Protein Desserts', description: 'Guilt-free indulgence.', sortOrder: 4 },
  { slug: 'sides', name: 'Sides', description: 'Complete the set.', sortOrder: 5 },
  { slug: 'drinks', name: 'Drinks', description: 'Shakes, juices and soft drinks.', sortOrder: 6 },
];

interface ProductSpec {
  sku: string;
  slug: string;
  name: string;
  category: string; // category slug
  shortDescription: string;
  description?: string;
  price: number; // USD major
  compareAt?: number;
  calories?: number;
  proteinG?: number;
  tag?: string;
  // Optional size variants: [name, optionValue, price]
  variants?: { name: string; size: string; price: number }[];
}

const PRODUCTS: ProductSpec[] = [
  // ---- Build Your Own -----------------------------------------------------
  {
    sku: 'FV-BYO-SANDWICH',
    slug: 'build-your-own-sandwich',
    name: 'Build Your Own Sandwich',
    category: 'build-your-own',
    shortDescription: 'Your bread + protein + unlimited veggies + a signature sauce.',
    description: [
      'Build it exactly how you like it.',
      '',
      'BREAD: White Italian, Whole Wheat, Multigrain, Brioche Bun, or Protein Wrap.',
      'PROTEIN: Grilled Chicken, Roast Beef, Turkey Breast, Smoked Turkey, Tuna Mix, Pulled Beef, Falafel, or Halloumi.',
      'UNLIMITED VEGGIES: Lettuce, Tomato, Cucumber, Pickles, Jalapeños, Onion, Red Onion, Bell Pepper, Cabbage, Corn, Mushrooms, Olives.',
      'SAUCE: Garlic Aioli, Ranch, Honey Mustard, BBQ, Sweet Chili, Chipotle, Greek Yogurt, or Light Mayo.',
      '',
      'Premium protein (double / halloumi / pulled beef) +$2.',
    ].join('\n'),
    price: 6.99,
    variants: [
      { name: 'Regular', size: 'regular', price: 6.99 },
      { name: 'Large', size: 'large', price: 10.99 },
    ],
  },
  {
    sku: 'FV-BYO-PREMIUM-PROTEIN',
    slug: 'premium-protein-upgrade',
    name: 'Premium Protein Upgrade',
    category: 'build-your-own',
    shortDescription: 'Upgrade add-on — double protein, halloumi or pulled beef.',
    price: 2.0,
  },

  // ---- Signature Drops ----------------------------------------------------
  {
    sku: 'FV-SIG-HEADLINER',
    slug: 'the-headliner',
    name: 'The Headliner',
    category: 'signature-drops',
    shortDescription: 'Pulled Beef · Mozzarella · Jalapeños · BBQ Sauce',
    price: 11.99,
    calories: 910,
    proteinG: 55,
    tag: 'Fan favourite',
  },
  {
    sku: 'FV-SIG-FV-CHICKEN',
    slug: 'full-volume-chicken',
    name: 'Full Volume Chicken',
    category: 'signature-drops',
    shortDescription: 'Grilled Chicken · Cheddar · Lettuce · Tomato · Honey Mustard',
    price: 8.99,
    calories: 620,
    proteinG: 48,
  },
  {
    sku: 'FV-SIG-BACKSTAGE-BEEF',
    slug: 'the-backstage-beef',
    name: 'The Backstage Beef',
    category: 'signature-drops',
    shortDescription: 'Roast Beef · Swiss · Caramelized Onion · Mushrooms · BBQ Sauce',
    price: 10.99,
    calories: 790,
    proteinG: 52,
  },
  {
    sku: 'FV-SIG-GUITAR-HERO',
    slug: 'the-guitar-hero',
    name: 'The Guitar Hero',
    category: 'signature-drops',
    shortDescription: 'Crispy Chicken · Coleslaw · Pickles · Spicy Mayo',
    price: 9.99,
    calories: 880,
    proteinG: 46,
  },

  // ---- High Protein Series ------------------------------------------------
  {
    sku: 'FV-HP-MUSCLE-MAKER',
    slug: 'muscle-maker',
    name: 'Muscle Maker',
    category: 'high-protein-series',
    shortDescription: 'Double Grilled Chicken · Lettuce · Tomato · Greek Yogurt Sauce',
    price: 9.99,
    calories: 450,
    proteinG: 65,
    tag: 'Max gains',
  },
  {
    sku: 'FV-HP-POWERHOUSE-TURKEY',
    slug: 'powerhouse-turkey',
    name: 'Powerhouse Turkey',
    category: 'high-protein-series',
    shortDescription: 'Turkey Breast · Mixed Greens · Mustard · Pickles',
    price: 7.49,
    calories: 340,
    proteinG: 42,
  },
  {
    sku: 'FV-HP-LEAN-MACHINE',
    slug: 'lean-machine',
    name: 'Lean Machine',
    category: 'high-protein-series',
    shortDescription: 'Tuna · Lettuce · Cucumber · Light Yogurt Dressing',
    price: 8.49,
    calories: 410,
    proteinG: 38,
  },
  {
    sku: 'FV-HP-BULK-MODE-WRAP',
    slug: 'bulk-mode-wrap',
    name: 'Bulk Mode Wrap',
    category: 'high-protein-series',
    shortDescription: 'Chicken Breast · Egg Whites · Mixed Greens · Yogurt Sauce',
    price: 8.99,
    calories: 370,
    proteinG: 50,
  },

  // ---- Protein Desserts ---------------------------------------------------
  {
    sku: 'FV-DES-BROWNIE',
    slug: 'protein-brownie',
    name: 'Protein Brownie',
    category: 'protein-desserts',
    shortDescription: 'Fudgy protein brownie.',
    price: 3.99,
    calories: 220,
    proteinG: 18,
  },
  {
    sku: 'FV-DES-COOKIE',
    slug: 'protein-cookie',
    name: 'Protein Cookie',
    category: 'protein-desserts',
    shortDescription: 'Soft-baked protein cookie.',
    price: 2.99,
    calories: 180,
    proteinG: 15,
  },
  {
    sku: 'FV-DES-CHEESECAKE-CUP',
    slug: 'protein-cheesecake-cup',
    name: 'Protein Cheesecake Cup',
    category: 'protein-desserts',
    shortDescription: 'Creamy protein cheesecake cup.',
    price: 4.99,
    calories: 260,
    proteinG: 22,
  },
  {
    sku: 'FV-DES-YOGURT-BERRY-BOWL',
    slug: 'greek-yogurt-berry-bowl',
    name: 'Greek Yogurt Berry Bowl',
    category: 'protein-desserts',
    shortDescription: 'Greek yogurt with fresh berries.',
    price: 4.49,
    calories: 190,
    proteinG: 20,
  },
  {
    sku: 'FV-DES-PB-PROTEIN-CUP',
    slug: 'pb-protein-cup',
    name: 'PB Protein Cup',
    category: 'protein-desserts',
    shortDescription: 'Peanut butter protein cup.',
    price: 3.99,
    calories: 230,
    proteinG: 16,
  },

  // ---- Sides --------------------------------------------------------------
  { sku: 'FV-SIDE-BAKED-FRIES', slug: 'baked-fries', name: 'Baked Fries', category: 'sides', shortDescription: 'Crispy oven-baked fries.', price: 2.99, calories: 280 },
  { sku: 'FV-SIDE-SWEET-POTATO-FRIES', slug: 'sweet-potato-fries', name: 'Sweet Potato Fries', category: 'sides', shortDescription: 'Sweet potato fries.', price: 3.49, calories: 320 },
  { sku: 'FV-SIDE-ONION-RINGS', slug: 'onion-rings', name: 'Onion Rings', category: 'sides', shortDescription: 'Golden onion rings.', price: 3.99, calories: 390 },
  { sku: 'FV-SIDE-SIDE-SALAD', slug: 'side-salad', name: 'Side Salad', category: 'sides', shortDescription: 'Fresh mixed side salad.', price: 2.99, calories: 90 },
  { sku: 'FV-SIDE-PROTEIN-COLESLAW', slug: 'protein-coleslaw', name: 'Protein Coleslaw', category: 'sides', shortDescription: 'Greek-yogurt protein coleslaw.', price: 2.49, calories: 120, proteinG: 8 },

  // ---- Drinks -------------------------------------------------------------
  { sku: 'FV-DRINK-PEPSI', slug: 'pepsi', name: 'Pepsi', category: 'drinks', shortDescription: 'Chilled Pepsi.', price: 1.99, calories: 150 },
  { sku: 'FV-DRINK-DIET-PEPSI', slug: 'diet-pepsi', name: 'Diet Pepsi', category: 'drinks', shortDescription: 'Zero-calorie Diet Pepsi.', price: 1.99, calories: 0 },
  { sku: 'FV-DRINK-WATER', slug: 'water', name: 'Water', category: 'drinks', shortDescription: 'Bottled water.', price: 0.99, calories: 0 },
  { sku: 'FV-DRINK-OJ', slug: 'fresh-orange-juice', name: 'Fresh Orange Juice', category: 'drinks', shortDescription: 'Freshly squeezed orange juice.', price: 2.99, calories: 120 },
  { sku: 'FV-DRINK-PROTEIN-SHAKE', slug: 'protein-shake', name: 'Protein Shake', category: 'drinks', shortDescription: 'House protein shake.', price: 4.99, calories: 250, proteinG: 30 },
];

const FAQS: { question: string; answer: string; tags: string[] }[] = [
  {
    question: 'What are your opening hours?',
    answer: 'We are open every day from 10:00 AM to 11:00 PM.',
    tags: ['hours', 'open'],
  },
  {
    question: 'How much protein can I get in a sandwich?',
    answer:
      'Our High Protein Series goes up to 65g of protein (the Muscle Maker). Most signature sandwiches land between 46g and 55g, and you can add a premium/double protein to any build for +$2.',
    tags: ['protein', 'macros', 'nutrition'],
  },
  {
    question: 'Can I build my own sandwich?',
    answer:
      'Yes! Pick a bread (White Italian, Whole Wheat, Multigrain, Brioche, or Protein Wrap), a protein, unlimited veggies, and a signature sauce. Regular is $6.99 and Large is $10.99.',
    tags: ['build', 'customize', 'menu'],
  },
  {
    question: 'Do you have vegetarian options?',
    answer:
      'Absolutely — choose Falafel or Halloumi as your protein, load up on unlimited veggies, and pick any sauce. The Side Salad, fries, and protein desserts are vegetarian too.',
    tags: ['vegetarian', 'veggie', 'falafel', 'halloumi'],
  },
  {
    question: 'Do you deliver?',
    answer:
      'Yes, we offer delivery. A $2.99 delivery fee applies, and delivery is free on orders over $25. You can also choose pickup at no extra charge.',
    tags: ['delivery', 'pickup'],
  },
  {
    question: 'Are the calorie and protein counts accurate?',
    answer:
      'The macros shown are approximate and can vary slightly with your choice of bread, sauce, and add-ons. Use them as a close guide rather than an exact figure.',
    tags: ['calories', 'macros', 'nutrition'],
  },
];

const POLICIES: { kind: string; title: string; content: string }[] = [
  {
    kind: 'allergens',
    title: 'Allergen & Nutrition Notice',
    content:
      'Our food is prepared in a kitchen that handles gluten, dairy, eggs, fish, soy, and nuts, so cross-contact is possible. Calorie and protein values are approximate and may vary by build. If you have a food allergy, please let our team know before ordering.',
  },
  {
    kind: 'returns',
    title: 'Order & Refund Policy',
    content:
      "If something is wrong with your order, contact us within 30 minutes of pickup/delivery and we'll make it right with a replacement or refund. Custom-built sandwiches can't be refunded once prepared unless there's a preparation error on our side.",
  },
];

async function main() {
  console.warn('[full-volume] seeding tenant…');
  await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);

  // ---- Org + admin user + membership ------------------------------------
  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const org = await prisma.organization.upsert({
    where: { slug: SLUG },
    update: { name: NAME },
    create: { slug: SLUG, name: NAME },
  });
  const user = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { passwordHash, status: 'active', emailVerifiedAt: new Date() },
    create: {
      email: ADMIN_EMAIL,
      passwordHash,
      firstName: 'Full Volume',
      lastName: 'Admin',
      status: 'active',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.membership.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    update: { role: 'admin', isActive: true },
    create: { organizationId: org.id, userId: user.id, role: 'admin' },
  });

  // ---- Categories --------------------------------------------------------
  const categoryIdBySlug = new Map<string, string>();
  for (const c of CATEGORIES) {
    const row = await prisma.category.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug: c.slug } },
      update: { name: c.name, description: c.description, sortOrder: c.sortOrder, isActive: true },
      create: {
        organizationId: org.id,
        name: c.name,
        slug: c.slug,
        description: c.description,
        sortOrder: c.sortOrder,
      },
    });
    categoryIdBySlug.set(c.slug, row.id);
  }

  // ---- Products (+ variants) ---------------------------------------------
  for (const p of PRODUCTS) {
    const attributes: Record<string, unknown> = {};
    if (p.calories !== undefined) attributes.calories = p.calories;
    if (p.proteinG !== undefined) attributes.protein_g = p.proteinG;
    if (p.tag) attributes.tag = p.tag;

    const product = await prisma.product.upsert({
      where: { organizationId_sku: { organizationId: org.id, sku: p.sku } },
      update: {
        name: p.name,
        slug: p.slug,
        categoryId: categoryIdBySlug.get(p.category) ?? null,
        shortDescription: p.shortDescription,
        description: p.description ?? null,
        priceMinor: usd(p.price),
        compareAtMinor: p.compareAt ? usd(p.compareAt) : null,
        currency: CURRENCY,
        isAvailable: true,
        attributes: Object.keys(attributes).length ? attributes : undefined,
      },
      create: {
        organizationId: org.id,
        categoryId: categoryIdBySlug.get(p.category) ?? null,
        sku: p.sku,
        name: p.name,
        slug: p.slug,
        shortDescription: p.shortDescription,
        description: p.description ?? null,
        priceMinor: usd(p.price),
        compareAtMinor: p.compareAt ? usd(p.compareAt) : null,
        currency: CURRENCY,
        isAvailable: true,
        attributes: Object.keys(attributes).length ? attributes : undefined,
      },
    });

    if (p.variants) {
      for (const [i, v] of p.variants.entries()) {
        const vSku = `${p.sku}-${v.size.toUpperCase()}`;
        await prisma.productVariant.upsert({
          where: { organizationId_sku: { organizationId: org.id, sku: vSku } },
          update: {
            name: v.name,
            options: { size: v.size },
            priceMinor: usd(v.price),
            isAvailable: true,
            sortOrder: i,
          },
          create: {
            organizationId: org.id,
            productId: product.id,
            sku: vSku,
            name: v.name,
            options: { size: v.size },
            priceMinor: usd(v.price),
            sortOrder: i,
          },
        });
      }
    }
  }

  // ---- Business info (hours + about + cart/shop form) --------------------
  const dayHours = [{ open: '10:00', close: '23:00' }];
  const operatingHours = {
    monday: dayHours,
    tuesday: dayHours,
    wednesday: dayHours,
    thursday: dayHours,
    friday: dayHours,
    saturday: dayHours,
    sunday: dayHours,
  };
  const shopForm = {
    enabled: true,
    title: 'Place your order',
    intentKeywords: ['order', 'buy', 'delivery', 'menu', 'want', 'get', 'sandwich', 'combo'],
    fields: [
      { key: 'name', label: 'Your name', type: 'text', required: true },
      { key: 'phone', label: 'Phone number', type: 'text', required: true },
      { key: 'fulfillment', label: 'Pickup or delivery?', type: 'select', required: true, options: ['Pickup', 'Delivery'] },
      { key: 'address', label: 'Delivery address (if delivery)', type: 'long_text', required: false },
      { key: 'notes', label: 'Any notes for the kitchen?', type: 'long_text', required: false },
    ],
    minOrderMinor: null,
    deliveryFeeMinor: usd(2.99),
    freeDeliveryAboveMinor: usd(25),
    confirmationMessage:
      "🔥 Order locked in! Your Full Volume order #{{cart_id_short}} totals {{total}}. We'll have it ready shortly — sandwiches that hit different.",
    menuUrl: null,
    deliveryAreas: [],
  };
  const about =
    'Full Volume is a high-protein sandwich shop built for people who want bold flavour without compromising their macros. Build your own, grab a signature drop, or load up from our High Protein Series — every order is fresh, customizable, and packed with protein.';

  await prisma.businessInfo.upsert({
    where: { organizationId: org.id },
    update: {
      legalName: 'Full Volume',
      tagline: 'Sandwiches That Hit Different',
      about,
      operatingHours,
      timezone: 'America/New_York',
      currency: CURRENCY,
      shopForm,
    },
    create: {
      organizationId: org.id,
      legalName: 'Full Volume',
      tagline: 'Sandwiches That Hit Different',
      about,
      operatingHours,
      timezone: 'America/New_York',
      currency: CURRENCY,
      shopForm,
    },
  });

  // ---- Location ----------------------------------------------------------
  const existingLocation = await prisma.location.findFirst({
    where: { organizationId: org.id, name: 'Full Volume — Flagship' },
  });
  if (!existingLocation) {
    await prisma.location.create({
      data: {
        organizationId: org.id,
        name: 'Full Volume — Flagship',
        addressLine1: '101 Protein Ave',
        city: 'New York',
        region: 'NY',
        postalCode: '10001',
        country: 'US',
        phone: '+1 (212) 555-0199',
        email: 'hello@fullvolume.example',
        isPrimary: true,
        sortOrder: 0,
      },
    });
  }

  // ---- Contact channels --------------------------------------------------
  const channels = [
    { kind: 'phone', label: 'Main line', value: '+1 (212) 555-0199', isPrimary: true, sortOrder: 0 },
    { kind: 'email', label: 'General', value: 'hello@fullvolume.example', isPrimary: false, sortOrder: 1 },
    { kind: 'instagram', label: 'Instagram', value: '@fullvolumeeats', isPrimary: false, sortOrder: 2 },
  ];
  for (const ch of channels) {
    const existing = await prisma.contactChannel.findFirst({
      where: { organizationId: org.id, kind: ch.kind, value: ch.value },
    });
    if (!existing) {
      await prisma.contactChannel.create({ data: { organizationId: org.id, ...ch } });
    }
  }

  // ---- FAQs --------------------------------------------------------------
  for (const [i, f] of FAQS.entries()) {
    const existing = await prisma.fAQ.findFirst({
      where: { organizationId: org.id, question: f.question },
    });
    if (existing) {
      await prisma.fAQ.update({
        where: { id: existing.id },
        data: { answer: f.answer, tags: f.tags, sortOrder: i, isPublished: true, visibility: 'public' },
      });
    } else {
      await prisma.fAQ.create({
        data: {
          organizationId: org.id,
          question: f.question,
          answer: f.answer,
          tags: f.tags,
          sortOrder: i,
          visibility: 'public',
          isPublished: true,
        },
      });
    }
  }

  // ---- Policies ----------------------------------------------------------
  for (const [i, pol] of POLICIES.entries()) {
    await prisma.policy.upsert({
      where: { organizationId_kind: { organizationId: org.id, kind: pol.kind } },
      update: { title: pol.title, content: pol.content, sortOrder: i, isPublished: true },
      create: {
        organizationId: org.id,
        kind: pol.kind,
        title: pol.title,
        content: pol.content,
        sortOrder: i,
        isPublished: true,
      },
    });
  }

  // ---- Bot persona (not deployed — no WhatsApp channel yet) --------------
  await prisma.botConfig.upsert({
    where: { organizationId: org.id },
    update: {},
    create: {
      organizationId: org.id,
      personality: 'casual',
      customPersonality:
        'Bold, energetic and hype — like a friendly gym buddy who loves food. Keeps it punchy, talks up protein and flavour, and helps customers build the perfect sandwich.',
      greeting:
        "Welcome to Full Volume 🔥 Sandwiches that hit different. Want to build your own, see our signature drops, or go max-protein? I've got you.",
      languages: 'en',
    },
  });

  // ---- Read-API key (printed once) --------------------------------------
  const existingKey = await prisma.apiKey.findFirst({
    where: { organizationId: org.id, name: 'Full Volume bot key' },
  });
  let secret: string | null = null;
  if (!existingKey) {
    secret = `ak_live_${randomBytes(24).toString('base64url')}`;
    await prisma.apiKey.create({
      data: {
        organizationId: org.id,
        name: 'Full Volume bot key',
        prefix: secret.slice(0, 16),
        keyHash: createHash('sha256').update(secret).digest('hex'),
        scopes: ['read:catalog', 'read:business-info', 'read:faqs'],
        createdById: user.id,
      },
    });
  }

  console.warn(`[full-volume] ✔ org "${org.slug}" — admin ${ADMIN_EMAIL} / ${PASSWORD}`);
  console.warn(`[full-volume] ✔ ${CATEGORIES.length} categories, ${PRODUCTS.length} products, ${FAQS.length} FAQs, ${POLICIES.length} policies`);
  if (secret) console.warn(`[full-volume] api key (save now): ${secret}`);
  else console.warn('[full-volume] api key already issued previously (not re-printed).');
}

main()
  .catch((err) => {
    console.error('[full-volume] failed', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
