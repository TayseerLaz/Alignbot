// Eval harness — CLI runner.
//
// Drives the REAL bot engine against a golden set and scores each reply on
// three axes: retrieval hit-rate (were the expected SKUs surfaced?),
// deterministic checks (hallucination / language / formatting — the REQUIRED
// gate), and a binary LLM judge (advisory). Prints a report and exits non-zero
// when the pass rate drops below --threshold, so it can gate CI / a deploy.
//
// Run from apps/api (needs the source condition so it imports TS, not stale dist):
//   set -a; . ../../.env.production; set +a   # or your staging env
//   ./node_modules/.bin/tsx --conditions=source eval/runner.ts --org aseer-time
//
// Flags:
//   --org <slug>        which org + golden set (default: aseer-time)
//   --retrieval-only    compileOnly: score retrieval hit-rate only, no LLM
//                       generation and no judge (cheap — embeddings only)
//   --no-judge          run generation + deterministic checks, skip the judge
//   --threshold <0..1>  min overall pass rate before exit 0 (default 0.8)
//   --json              emit the raw EvalSummary as JSON

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prisma } from '@aligned/db';

import { buildBotResponse, gatherBotData } from '../src/lib/bot-engine.js';
import { scanReply, type ScanCandidates } from '../src/lib/provenance-scanner.js';

import { judgeReply } from './judge.js';
import { scoreDeterministic, scoreRetrieval, stripInternalMarkers } from './scorers.js';
import type { EvalSummary, GoldenScenario, ScenarioResult } from './types.js';

function formatMoney(minor: number | null, currency: string | null): string {
  if (minor == null) return '';
  const threeDp = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'].includes(currency ?? '');
  const major = minor / (threeDp ? 1000 : 100);
  return ` · ${major.toFixed(threeDp ? 3 : 2)} ${currency ?? ''}`.trimEnd();
}

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// Build the scanner's candidate bundle from gatherBotData output (mirrors the
// kb the whatsapp route hands validateReply/recordProvenance).
function toScanCandidates(data: Awaited<ReturnType<typeof gatherBotData>>): ScanCandidates {
  return {
    products: data.products.map((p) => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      priceMinor: p.priceMinor ?? null,
      currency: p.currency ?? null,
    })),
    services: data.services.map((s) => ({
      id: s.id,
      name: s.name,
      basePriceMinor: s.basePriceMinor ?? null,
      currency: s.currency ?? null,
    })),
    faqs: data.faqs.map((f) => ({ id: f.id, question: f.question, answer: f.answer })),
    policies: data.policies.map((p) => ({ kind: p.kind, title: p.title, content: p.content })),
    biz: data.biz
      ? {
          legalName: data.biz.legalName ?? null,
          websiteUrl: data.biz.websiteUrl ?? null,
          operatingHours: (data.biz as { operatingHours?: unknown }).operatingHours ?? null,
          currency: data.biz.currency ?? 'USD',
          menuUrl: data.shopForm?.menuUrl ?? null,
        }
      : null,
    config: { greeting: data.config?.greeting ?? null },
    customer: null,
  };
}

async function main() {
  const slug = arg('org') ?? 'aseer-time';
  const retrievalOnly = flag('retrieval-only');
  const noJudge = flag('no-judge');
  const threshold = Number(arg('threshold') ?? '0.8');

  const org = await prisma.organization.findFirst({ where: { slug }, select: { id: true } });
  if (!org) {
    console.error(`No org with slug "${slug}".`);
    process.exit(2);
  }

  const golden = JSON.parse(
    readFileSync(join(HERE, 'golden', `${slug}.json`), 'utf8'),
  ) as GoldenScenario[];

  const results: ScenarioResult[] = [];

  for (const sc of golden) {
    const data = await prisma.$transaction((tx) => gatherBotData(tx as never, org.id));
    const skuById = new Map(data.products.map((p) => [p.id, p.sku]));

    const res = await buildBotResponse({
      organizationId: org.id,
      userMessage: sc.prompt,
      history: sc.history ?? [],
      data,
      replyMode: 'text',
      customerSpokeAudio: false,
      customerName: null,
      cartState: null,
      channelLabel: 'WhatsApp',
      compileOnly: retrievalOnly,
    } as never);

    const candidateSkus = (res.inputs.candidateProductIds ?? [])
      .map((id: string) => skuById.get(id))
      .filter((s): s is string => Boolean(s));

    const retrieval = scoreRetrieval(candidateSkus, sc.expectCitesSku);

    // Score the CUSTOMER-FACING reply (markers stripped, as the send-path does),
    // not the engine's raw output.
    const customerReply = stripInternalMarkers(res.text);

    let deterministic = { passed: true, failures: [] as string[] };
    let judge;
    if (!retrievalOnly) {
      const scan = scanReply(res.text, toScanCandidates(data));
      deterministic = scoreDeterministic(customerReply, scan.hallucinations, sc);
      if (!noJudge) {
        // Give the judge ground-truth facts for the products actually surfaced,
        // so it can verify a quoted price instead of abstaining.
        // Give the judge EVERY product the model saw (the packed candidate set,
        // already bounded) — capping it drops the very siblings a scenario tests
        // and makes the judge wrongly call a real product "not in the catalog".
        const facts = (res.inputs.candidateProductIds ?? [])
          .map((id: string) => data.products.find((p) => p.id === id))
          .filter(Boolean)
          .map((p) => `- ${p!.name}${formatMoney(p!.priceMinor ?? null, p!.currency ?? null)}`)
          .join('\n');
        judge = (await judgeReply(sc, customerReply, facts || undefined)) ?? undefined;
      }
    }

    results.push({
      key: sc.key,
      dialect: sc.dialect,
      reply: customerReply,
      candidateSkus,
      retrieval,
      deterministic,
      judge,
      model: res.inputs.model,
    });
  }

  const retrievalScored = results.filter((r) => r.retrieval.expected > 0);
  const judgeScored = results.filter((r) => r.judge);
  const summary: EvalSummary = {
    org: slug,
    total: results.length,
    retrievalScored: retrievalScored.length,
    retrievalHits: retrievalScored.filter((r) => r.retrieval.hit).length,
    deterministicPass: results.filter((r) => r.deterministic.passed).length,
    judgeScored: judgeScored.length,
    judgePass: judgeScored.filter((r) => r.judge!.pass).length,
    overallPass: results.filter((r) => r.deterministic.passed && (!r.judge || r.judge.pass)).length,
    results,
  };

  if (flag('json')) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printReport(summary, retrievalOnly);
  }

  await prisma.$disconnect();

  // Gate: retrieval-only gates on hit-rate; full run gates on overall pass rate.
  const rate = retrievalOnly
    ? summary.retrievalScored === 0
      ? 1
      : summary.retrievalHits / summary.retrievalScored
    : summary.total === 0
      ? 1
      : summary.overallPass / summary.total;
  process.exit(rate + 1e-9 >= threshold ? 0 : 1);
}

function pct(n: number, d: number): string {
  return d === 0 ? '  n/a' : `${Math.round((100 * n) / d)}%`.padStart(5);
}

function printReport(s: EvalSummary, retrievalOnly: boolean) {
  console.log(`\n=== eval: ${s.org} ${retrievalOnly ? '(retrieval-only)' : ''} ===\n`);
  for (const r of s.results) {
    const marks: string[] = [];
    marks.push(
      r.retrieval.expected === 0 ? 'ret —' : r.retrieval.hit ? 'ret ✓' : `ret ✗(${r.retrieval.missing.join(',')})`,
    );
    if (!retrievalOnly) {
      marks.push(r.deterministic.passed ? 'det ✓' : `det ✗(${r.deterministic.failures.join('; ')})`);
      if (r.judge) marks.push(r.judge.pass ? 'judge ✓' : `judge ✗(${r.judge.critique})`);
    }
    console.log(`  ${r.key.padEnd(30)} ${marks.join('  ')}`);
  }
  console.log('');
  console.log(`  retrieval hit-rate : ${pct(s.retrievalHits, s.retrievalScored)}  (${s.retrievalHits}/${s.retrievalScored})`);
  if (!retrievalOnly) {
    console.log(`  deterministic pass : ${pct(s.deterministicPass, s.total)}  (${s.deterministicPass}/${s.total})`);
    console.log(`  judge pass         : ${pct(s.judgePass, s.judgeScored)}  (${s.judgePass}/${s.judgeScored})`);
    console.log(`  OVERALL pass       : ${pct(s.overallPass, s.total)}  (${s.overallPass}/${s.total})`);
  }
  console.log('');
}

void main().catch((err) => {
  console.error(err);
  process.exit(2);
});
