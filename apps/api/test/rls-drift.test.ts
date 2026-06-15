// Security gate: every tenant-scoped table (one carrying an `organization_id`
// column) MUST have Row-Level Security ENABLED + FORCED and at least one
// policy. rls.sql is not cleanly idempotent and can halt mid-file, so a new
// tenant table can silently ship WITHOUT a policy → cross-tenant data leak.
// This test fails the build if any org-scoped table is missing RLS, so the
// scariest class of bug (silent tenant leakage) can never merge.
import { describe, expect, it } from 'vitest';

import { prisma } from './setup.js';

// Tables that legitimately carry organization_id but are NOT tenant-isolated
// by RLS (none today, but keep an explicit allowlist so exceptions are
// reviewed in code, never silent).
const RLS_EXEMPT = new Set<string>([]);

describe('RLS drift — every organization_id table is isolated', () => {
  it('has RLS enabled + forced + a policy on all tenant tables', async () => {
    const orgTables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT DISTINCT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND c.column_name = 'organization_id'
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name`,
    );

    const status = await prisma.$queryRawUnsafe<
      { relname: string; rowsecurity: boolean; forced: boolean; policies: bigint }[]
    >(
      `SELECT c.relname,
              c.relrowsecurity  AS rowsecurity,
              c.relforcerowsecurity AS forced,
              (SELECT count(*) FROM pg_policies p
                 WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    const byName = new Map(status.map((s) => [s.relname, s]));

    const offenders: string[] = [];
    for (const { table_name } of orgTables) {
      if (RLS_EXEMPT.has(table_name)) continue;
      const s = byName.get(table_name);
      if (!s) {
        offenders.push(`${table_name}: not found in pg_class`);
        continue;
      }
      if (!s.rowsecurity) offenders.push(`${table_name}: RLS not ENABLED`);
      else if (!s.forced) offenders.push(`${table_name}: RLS not FORCED (owner bypasses)`);
      else if (Number(s.policies) === 0) offenders.push(`${table_name}: no policy`);
    }

    expect(orgTables.length).toBeGreaterThan(10); // sanity: schema actually loaded
    expect(offenders, `Tenant tables missing RLS:\n${offenders.join('\n')}`).toEqual([]);
  });
});
