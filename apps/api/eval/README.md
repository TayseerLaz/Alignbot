# Bot eval harness (Phase 0 slice)

Drives the **real** bot engine against per-tenant golden sets and scores replies on
three axes:

| Axis | What it checks | Gate? |
|---|---|---|
| **Retrieval hit-rate** | Were the expected catalog SKUs surfaced to the model? (`candidateProductIds`) | gates `--retrieval-only` |
| **Deterministic** | No critical hallucination · reply language matches · no markdown/marker leak | **required gate** |
| **Binary LLM judge** | Does the reply meet the plain-English pass criteria? (fixed strong model, pass/fail) | advisory |

This is the Phase-0 slice from `docs/ai-upgrade-plan.md` (WS3). It is the safety net the
P0 changes (reranking retrieval, grounding gate) ship behind. Multi-turn simulation and
the CI-workflow wiring come in Phase 2.

## Layout

```
eval/
  types.ts        golden-scenario + result types
  scorers.ts      PURE scoring (unit-tested in test/eval-scorers.test.ts)
  judge.ts        binary LLM judge (Anthropic Sonnet; abstains if no key)
  runner.ts       CLI orchestrator
  golden/
    aseer-time.json   real Kuwaiti-dialect scenarios (grounded in live SKUs)
```

## Run

From `apps/api`, with an env that has `DATABASE_URL` + the AI keys. Use the `source`
condition so tsx imports the TypeScript, not stale `dist`:

```bash
cd apps/api
set -a; . ../../.env.production; set +a          # or a staging env

# Cheap: retrieval hit-rate only (compileOnly — embeddings, no generation, no judge)
./node_modules/.bin/tsx --conditions=source eval/runner.ts --org aseer-time --retrieval-only

# Full: generation + deterministic checks + judge
./node_modules/.bin/tsx --conditions=source eval/runner.ts --org aseer-time

# Skip the judge (deterministic gate only)
./node_modules/.bin/tsx --conditions=source eval/runner.ts --org aseer-time --no-judge
```

Flags: `--org <slug>` · `--retrieval-only` · `--no-judge` · `--threshold <0..1>` (default 0.8) · `--json`.

Exit code is **non-zero** when the pass rate is below `--threshold`, so the command can gate
CI or a pre-deploy check. `--retrieval-only` gates on hit-rate; the full run gates on the
overall pass rate (deterministic AND judge).

## Adding scenarios

Seed `golden/<org-slug>.json` from real conversations — mine `MessageProvenance` for sampled
and flagged replies so the set tracks live traffic. Each scenario:

```jsonc
{
  "key": "sizes_shi_thani",          // unique id
  "dialect": "kuwaiti",              // for slicing results
  "prompt": "شي ثاني كم حجم عندكم؟",  // the customer message
  "expectation": "States all sizes with prices, not just one.",  // judged verbatim
  "expectLanguage": "ar",            // deterministic language check
  "expectCitesSku": ["MENU-340","MENU-341","MENU-342"],  // retrieval targets
  "mustNotHallucinate": true          // default true
}
```

## Notes

- The judge uses a **fixed** strong model (`ANTHROPIC_MODEL`) regardless of the tenant's plan —
  it should be at least as capable as the model under test. Binary pass/fail only (never 1–5).
- Pure scorers have no DB/network deps and are covered by `test/eval-scorers.test.ts`.
- Before trusting the judge as a gate, **calibrate it** (Phase 2): human-label ~50 scenarios,
  few-shot the judge from them, and confirm Cohen's κ > 0.7. Until then the deterministic
  checks are the required gate and the judge is advisory.
