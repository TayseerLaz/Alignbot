// Read-only diagnostic: finds every row in every table where "yoga" and
// related wellness/massage keywords appear, so the operator can decide
// what to delete. Does NOT mutate anything.
//
// Run on the server:
//   pnpm --filter @aligned/db exec tsx ./seed/yoga-contamination-report.ts
//
// Auto-runs in deploy.yml. Output appears in the GitHub Actions log.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const KEYWORDS = [
  'yoga',
  'vinyasa',
  'mindful',
  'meditat',
  'massage',
  'wellness',
  'essential oil',
  'chakra',
  'pilates',
  'cork yoga',
  'yoga mat',
];

// Builds a SQL ILIKE OR-clause for an array of keywords against a column.
function ilikeAny(column: string, keywords: string[]): string {
  return keywords.map((k) => `${column} ILIKE '%${k.replace(/'/g, "''")}%'`).join(' OR ');
}

async function header(title: string): Promise<void> {
  console.log(`\n${'═'.repeat(76)}`);
  console.log(`${title}`);
  console.log('═'.repeat(76));
}

async function main(): Promise<void> {
  await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
  console.log('\n┌─────────────────────────────────────────────────────────────────────┐');
  console.log('│  YOGA CONTAMINATION REPORT (read-only — no rows modified)           │');
  console.log('└─────────────────────────────────────────────────────────────────────┘');

  // 1. Knowledge base entries
  await header('1. knowledge_base_entries — Q/A pairs the bot grounds replies on');
  const kbWhere = `(${ilikeAny('k.question', KEYWORDS)}) OR (${ilikeAny('k.answer', KEYWORDS)})`;
  const kb = (await prisma.$queryRawUnsafe(`
    SELECT o.name AS org, k.id::text AS id, k.kind, k.source_type AS source, k.approved,
           LEFT(k.question, 140) AS question, LEFT(k.answer, 220) AS answer,
           k.created_at
    FROM knowledge_base_entries k
    JOIN organizations o ON o.id = k.organization_id
    WHERE ${kbWhere}
    ORDER BY o.name, k.created_at DESC
    LIMIT 200
  `)) as Array<Record<string, unknown>>;
  console.log(`Found ${kb.length} rows.`);
  for (const r of kb) {
    console.log(
      `  [${r.org}] ${r.kind}/${r.source} approved=${r.approved} | Q: ${r.question}`,
    );
    console.log(`    A: ${r.answer}`);
  }

  // 2. Products + Services (live + soft-deleted)
  await header('2. products / services — catalog rows with matching names');
  const prodWhere = ilikeAny('p.name', KEYWORDS);
  const products = (await prisma.$queryRawUnsafe(`
    SELECT o.name AS org, p.sku, p.name, p.deleted_at, p.is_available
    FROM products p
    JOIN organizations o ON o.id = p.organization_id
    WHERE ${prodWhere}
    ORDER BY o.name, p.name
  `)) as Array<Record<string, unknown>>;
  console.log(`products: ${products.length} rows.`);
  for (const r of products) {
    const state = r.deleted_at
      ? 'SOFT-DELETED'
      : r.is_available
        ? 'LIVE'
        : 'UNAVAILABLE';
    console.log(`  [${r.org}] (${state}) sku=${r.sku} name="${r.name}"`);
  }

  const svcWhere = ilikeAny('s.name', KEYWORDS);
  const services = (await prisma.$queryRawUnsafe(`
    SELECT o.name AS org, s.name, s.deleted_at, s.is_available
    FROM services s
    JOIN organizations o ON o.id = s.organization_id
    WHERE ${svcWhere}
    ORDER BY o.name, s.name
  `)) as Array<Record<string, unknown>>;
  console.log(`services: ${services.length} rows.`);
  for (const r of services) {
    const state = r.deleted_at
      ? 'SOFT-DELETED'
      : r.is_available
        ? 'LIVE'
        : 'UNAVAILABLE';
    console.log(`  [${r.org}] (${state}) name="${r.name}"`);
  }

  // 3. bot_configs — text fields the bot uses as grounding
  await header('3. bot_configs — greeting / custom_personality / conversation_flow / response_templates');
  const botConfigs = (await prisma.$queryRawUnsafe(`
    SELECT o.name AS org, bc.id::text AS id,
           bc.greeting,
           LEFT(COALESCE(bc.custom_personality, ''), 300) AS personality_preview,
           COALESCE(bc.conversation_flow::text, '') AS conversation_flow,
           COALESCE(bc.response_templates::text, '') AS response_templates
    FROM bot_configs bc
    JOIN organizations o ON o.id = bc.organization_id
  `)) as Array<Record<string, unknown>>;
  let botHits = 0;
  for (const r of botConfigs) {
    const blob = `${r.greeting ?? ''}\n${r.personality_preview ?? ''}\n${r.conversation_flow ?? ''}\n${r.response_templates ?? ''}`.toLowerCase();
    const matched = KEYWORDS.filter((k) => blob.includes(k.toLowerCase()));
    if (matched.length === 0) continue;
    botHits++;
    console.log(`  [${r.org}] bot_config id=${r.id} — matched: ${matched.join(', ')}`);
    if (r.greeting) console.log(`    greeting: ${r.greeting}`);
    if (r.personality_preview)
      console.log(`    custom_personality (first 300 chars): ${r.personality_preview}`);
    const cfText = r.conversation_flow as string;
    if (cfText && KEYWORDS.some((k) => cfText.toLowerCase().includes(k.toLowerCase()))) {
      console.log(`    conversation_flow (truncated 400): ${cfText.slice(0, 400)}…`);
    }
    const rtText = r.response_templates as string;
    if (rtText && KEYWORDS.some((k) => rtText.toLowerCase().includes(k.toLowerCase()))) {
      console.log(`    response_templates (truncated 400): ${rtText.slice(0, 400)}…`);
    }
  }
  console.log(`bot_configs with matches: ${botHits}.`);

  // 4. bot_conversation_flow_options — recommender candidates
  await header('4. bot_conversation_flow_options — recommender candidates');
  const flowOpts = (await prisma.$queryRawUnsafe(`
    SELECT o.name AS org, cfo.id::text AS id, cfo.name, cfo.description, cfo.is_selected,
           LEFT(cfo.flow::text, 2000) AS flow_preview
    FROM bot_conversation_flow_options cfo
    JOIN organizations o ON o.id = cfo.organization_id
    WHERE cfo.name ILIKE ANY (ARRAY[${KEYWORDS.map((k) => `'%${k.replace(/'/g, "''")}%'`).join(',')}])
       OR cfo.description ILIKE ANY (ARRAY[${KEYWORDS.map((k) => `'%${k.replace(/'/g, "''")}%'`).join(',')}])
       OR cfo.flow::text ILIKE ANY (ARRAY[${KEYWORDS.map((k) => `'%${k.replace(/'/g, "''")}%'`).join(',')}])
  `)) as Array<Record<string, unknown>>;
  console.log(`Found ${flowOpts.length} rows.`);
  for (const r of flowOpts) {
    console.log(
      `  [${r.org}] selected=${r.is_selected} id=${r.id} name="${r.name}" desc="${r.description}"`,
    );
    const fp = r.flow_preview as string;
    if (fp) console.log(`    flow (truncated 400): ${fp.slice(0, 400)}…`);
  }

  // 5. business_info — about / tagline free text
  await header('5. business_info — tagline / about');
  const biz = (await prisma.$queryRawUnsafe(`
    SELECT o.name AS org, bi.tagline, LEFT(COALESCE(bi.about, ''), 400) AS about_preview
    FROM business_info bi
    JOIN organizations o ON o.id = bi.organization_id
    WHERE ${ilikeAny('COALESCE(bi.tagline, \'\')', KEYWORDS)}
       OR ${ilikeAny('COALESCE(bi.about, \'\')', KEYWORDS)}
  `)) as Array<Record<string, unknown>>;
  console.log(`Found ${biz.length} rows.`);
  for (const r of biz) {
    console.log(`  [${r.org}] tagline="${r.tagline ?? '—'}"`);
    if (r.about_preview) console.log(`    about: ${r.about_preview}`);
  }

  // 6. FAQ + Policy
  await header('6. faqs / policies');
  const faqs = (await prisma.$queryRawUnsafe(`
    SELECT o.name AS org, LEFT(f.question, 140) AS question, LEFT(f.answer, 220) AS answer,
           f.is_published, f.visibility
    FROM faqs f
    JOIN organizations o ON o.id = f.organization_id
    WHERE ${ilikeAny('f.question', KEYWORDS)} OR ${ilikeAny('f.answer', KEYWORDS)}
  `)) as Array<Record<string, unknown>>;
  console.log(`faqs: ${faqs.length} rows.`);
  for (const r of faqs) {
    console.log(
      `  [${r.org}] published=${r.is_published} visibility=${r.visibility} Q: ${r.question}`,
    );
    console.log(`    A: ${r.answer}`);
  }
  const policies = (await prisma.$queryRawUnsafe(`
    SELECT o.name AS org, p.title, LEFT(p.content, 220) AS content
    FROM policies p
    JOIN organizations o ON o.id = p.organization_id
    WHERE ${ilikeAny('p.title', KEYWORDS)} OR ${ilikeAny('p.content', KEYWORDS)}
  `)) as Array<Record<string, unknown>>;
  console.log(`policies: ${policies.length} rows.`);
  for (const r of policies) {
    console.log(`  [${r.org}] title="${r.title}"`);
    console.log(`    content: ${r.content}`);
  }

  // 7. crawl_jobs — where did the crawler point at?
  await header('7. crawl_jobs — historical "Analyse my website" targets');
  const crawls = (await prisma.$queryRawUnsafe(`
    SELECT o.name AS org, cj.id::text AS id, cj.root_url, cj.status,
           cj.pages_crawled, cj.pages_failed,
           cj.created_at, cj.finished_at
    FROM crawl_jobs cj
    JOIN organizations o ON o.id = cj.organization_id
    ORDER BY cj.created_at DESC
    LIMIT 30
  `)) as Array<Record<string, unknown>>;
  console.log(`Last ${crawls.length} crawl jobs across all orgs:`);
  for (const r of crawls) {
    console.log(
      `  [${r.org}] ${r.status} pages=${r.pages_crawled} url=${r.root_url} at=${r.created_at}`,
    );
  }

  // 8. Test scenarios — they're stored prompts and might contain keywords
  await header('8. bot_test_scenarios — test prompts the operator generated');
  const scens = (await prisma.$queryRawUnsafe(`
    SELECT o.name AS org, s.key, LEFT(s.prompt, 140) AS prompt, LEFT(s.expectation, 200) AS expectation
    FROM bot_test_scenarios s
    JOIN organizations o ON o.id = s.organization_id
    WHERE ${ilikeAny('s.prompt', KEYWORDS)} OR ${ilikeAny('s.expectation', KEYWORDS)}
  `)) as Array<Record<string, unknown>>;
  console.log(`Found ${scens.length} rows.`);
  for (const r of scens) {
    console.log(`  [${r.org}] ${r.key}: ${r.prompt}`);
    console.log(`    expectation: ${r.expectation}`);
  }

  // 9. Bot test runs — what the bot has said before
  await header('9. bot_test_runs — historical bot responses');
  const runs = (await prisma.$queryRawUnsafe(`
    SELECT o.name AS org, r.scenario_key, LEFT(r.bot_response, 240) AS response, r.created_at
    FROM bot_test_runs r
    JOIN organizations o ON o.id = r.organization_id
    WHERE ${ilikeAny('r.bot_response', KEYWORDS)}
    ORDER BY r.created_at DESC
    LIMIT 30
  `)) as Array<Record<string, unknown>>;
  console.log(`Found ${runs.length} rows (capped at 30 most recent).`);
  for (const r of runs) {
    console.log(`  [${r.org}] ${r.scenario_key} at=${r.created_at}`);
    console.log(`    response: ${r.response}`);
  }

  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('REPORT END.');
  console.log('═════════════════════════════════════════════════════════════════════');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('\n[yoga-report] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
