// Formal PDF report renderer for the data export. Builds a clean, branded HTML
// document from the gathered bundle and renders it to PDF via the same Chromium
// (Playwright) the crawler already ships. Full CSS control → a professional,
// non-"AI-looking" report: cover page, table of contents, one section per page,
// zebra-striped tables, running header/footer with page numbers.
//
// Two layouts:
//   combined → one PDF with every selected section.
//   separate → one PDF per section (the worker zips them).
import type { Browser } from 'playwright';

const OXBLOOD = '#360516';
const INK = '#1a1418';
const MUTED = '#6b6169';
const RULE = '#e4dfe1';

// Columns that are noise in a human-facing report — dropped before rendering.
const HIDDEN_COLUMNS = new Set([
  'embedding',
  'embeddingHash',
  'embedding_hash',
  'searchText',
  'search_text',
  'organizationId',
  'organization_id',
]);

// Per-table row cap so a report stays a report (huge dumps → use the CSV format).
const MAX_ROWS_PER_TABLE = 500;

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// camelCase / snake_case → "Title Case" for column headers.
function humanize(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\bid\b/i, 'ID')
    .replace(/^\w/, (c) => c.toUpperCase());
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return '';
    }
  }
  const s = String(v);
  // ISO timestamps → readable.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 19).replace('T', ' ');
  return s;
}

function cleanRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (HIDDEN_COLUMNS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface ReportTable {
  title: string;
  rows: Record<string, unknown>[];
}
export interface ReportSection {
  key: string;
  label: string;
  tables: ReportTable[];
}

// Map the gathered bundle → ordered sections of tables (mirrors the CSV files).
// Only sections with at least one non-empty table are returned.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bundleToReportSections(b: any): ReportSection[] {
  const products: any[] = b.products ?? [];
  const services: any[] = b.services ?? [];
  const clients: any[] = b.clients ?? [];
  const threads: any[] = b.threads ?? [];

  const raw: ReportSection[] = [
    {
      key: 'business_info',
      label: 'Business info',
      tables: [
        { title: 'Business profile', rows: b.businessInfo ? [b.businessInfo] : [] },
        { title: 'Locations', rows: b.locations ?? [] },
        { title: 'Contact channels', rows: b.contactChannels ?? [] },
      ],
    },
    {
      key: 'products',
      label: 'Products',
      tables: [
        {
          title: 'Products',
          rows: products.map(({ variants: _v, images: _i, ...rest }) => rest),
        },
        {
          title: 'Variants',
          rows: products.flatMap((p) => (p.variants ?? []).map((v: any) => ({ product: p.name, ...v }))),
        },
        { title: 'Categories', rows: b.categories ?? [] },
      ],
    },
    {
      key: 'services',
      label: 'Services',
      tables: [
        {
          title: 'Services',
          rows: services.map(({ pricingTiers: _t, availability: _a, ...rest }) => rest),
        },
        {
          title: 'Pricing tiers',
          rows: services.flatMap((s) => (s.pricingTiers ?? []).map((t: any) => ({ service: s.name, ...t }))),
        },
      ],
    },
    {
      key: 'faqs_policies',
      label: 'FAQs & policies',
      tables: [
        { title: 'FAQs', rows: b.faqs ?? [] },
        { title: 'Policies', rows: b.policies ?? [] },
      ],
    },
    {
      key: 'contacts',
      label: 'Clients / contacts',
      tables: [
        { title: 'Clients', rows: clients.map(({ tags: _tg, ...rest }) => rest) },
        {
          title: 'Client tags',
          rows: clients.flatMap((c) => (c.tags ?? []).map((tag: any) => ({ contact: c.phoneE164, tag: tag.tag }))),
        },
      ],
    },
    { key: 'segments', label: 'Segments', tables: [{ title: 'Segments', rows: b.segments ?? [] }] },
    {
      key: 'broadcasts',
      label: 'Broadcasts',
      tables: [
        { title: 'Broadcasts', rows: b.broadcasts ?? [] },
        { title: 'Recipients', rows: b.broadcastRecipients ?? [] },
        { title: 'Events', rows: b.broadcastEvents ?? [] },
      ],
    },
    {
      key: 'orders',
      label: 'Orders',
      tables: [
        { title: 'Orders', rows: b.carts ?? [] },
        { title: 'Order items', rows: b.cartItems ?? [] },
      ],
    },
    { key: 'bookings', label: 'Bookings', tables: [{ title: 'Bookings', rows: b.bookings ?? [] }] },
    {
      key: 'conversations',
      label: 'Conversations',
      tables: [
        { title: 'Threads', rows: threads.map(({ tags: _tg, ...rest }) => rest) },
        { title: 'Messages', rows: b.messages ?? [] },
        { title: 'Notes', rows: b.notes ?? [] },
      ],
    },
    { key: 'members', label: 'Team members', tables: [{ title: 'Members', rows: b.members ?? [] }] },
    { key: 'activity', label: 'Activity log', tables: [{ title: 'Audit log', rows: b.audit ?? [] }] },
    {
      key: 'ai',
      label: 'AI config',
      tables: [
        { title: 'Bot config', rows: b.botConfig ? [b.botConfig] : [] },
        { title: 'Knowledge base', rows: b.kb ?? [] },
      ],
    },
    { key: 'api_keys', label: 'API keys', tables: [{ title: 'API keys', rows: b.apiKeys ?? [] }] },
  ];

  // Drop empty tables + sections that end up with no data.
  return raw
    .map((s) => ({ ...s, tables: s.tables.filter((t) => t.rows && t.rows.length > 0) }))
    .filter((s) => s.tables.length > 0);
}

function renderTable(t: ReportTable): string {
  const cleaned = t.rows.map(cleanRow);
  const cols = Array.from(
    cleaned.reduce<Set<string>>((set, r) => {
      Object.keys(r).forEach((k) => set.add(k));
      return set;
    }, new Set()),
  );
  const shown = cleaned.slice(0, MAX_ROWS_PER_TABLE);
  const head = cols.map((c) => `<th>${esc(humanize(c))}</th>`).join('');
  const body = shown
    .map(
      (r) =>
        `<tr>${cols.map((c) => `<td>${esc(fmtValue(r[c]))}</td>`).join('')}</tr>`,
    )
    .join('');
  const truncated =
    cleaned.length > MAX_ROWS_PER_TABLE
      ? `<p class="note">Showing ${MAX_ROWS_PER_TABLE} of ${cleaned.length} rows — export as CSV for the full data.</p>`
      : '';
  return `
    <div class="table-block">
      <h3>${esc(t.title)} <span class="count">${cleaned.length}</span></h3>
      <div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
      ${truncated}
    </div>`;
}

function renderSectionBody(s: ReportSection): string {
  return `<section class="doc-section"><h2>${esc(s.label)}</h2>${s.tables.map(renderTable).join('')}</section>`;
}

const CSS = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: ${INK}; margin: 0; font-size: 10px; }
  h1, h2, h3 { font-family: Georgia, "Times New Roman", serif; }
  .cover { height: 100vh; display: flex; flex-direction: column; justify-content: center; padding: 0 24mm; page-break-after: always; }
  .cover .kicker { text-transform: uppercase; letter-spacing: 3px; font-size: 10px; color: ${OXBLOOD}; font-weight: 700; }
  .cover h1 { font-size: 34px; margin: 8px 0 4px; color: ${INK}; }
  .cover .org { font-size: 18px; color: ${MUTED}; margin: 0; }
  .cover .meta { margin-top: 40px; font-size: 11px; color: ${MUTED}; line-height: 1.9; border-top: 2px solid ${OXBLOOD}; padding-top: 16px; }
  .cover .conf { margin-top: auto; font-size: 9px; color: ${MUTED}; letter-spacing: 1px; }
  .toc { padding: 0 6mm 8mm; page-break-after: always; }
  .toc h2 { font-size: 15px; border-bottom: 1px solid ${RULE}; padding-bottom: 6px; }
  .toc ol { columns: 2; font-size: 11px; color: ${INK}; line-height: 1.9; }
  .doc-section { page-break-before: always; padding: 0 6mm; }
  h2 { font-size: 17px; color: ${OXBLOOD}; border-bottom: 2px solid ${OXBLOOD}; padding-bottom: 5px; margin-bottom: 14px; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: ${INK}; margin: 16px 0 6px; }
  h3 .count { color: ${MUTED}; font-weight: 400; font-size: 10px; }
  .table-block { margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid ${RULE}; padding: 3px 5px; text-align: left; vertical-align: top; word-break: break-word; overflow-wrap: anywhere; font-size: 8.5px; }
  th { background: ${OXBLOOD}; color: #fff; font-weight: 600; font-size: 8px; text-transform: uppercase; letter-spacing: 0.3px; }
  tbody tr:nth-child(even) { background: #faf7f8; }
  .note { font-size: 8.5px; color: ${MUTED}; font-style: italic; margin: 4px 0 0; }
`;

function docShell(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${inner}</body></html>`;
}

function coverPage(orgName: string, title: string, generatedAtIso: string, sectionLabels: string[]): string {
  const date = new Date(generatedAtIso).toUTCString();
  return `
    <div class="cover">
      <div class="kicker">Data Export Report</div>
      <h1>${esc(title)}</h1>
      <p class="org">${esc(orgName)}</p>
      <div class="meta">
        <div><strong>Prepared for:</strong> ${esc(orgName)}</div>
        <div><strong>Generated:</strong> ${esc(date)}</div>
        <div><strong>Sections:</strong> ${esc(sectionLabels.join(', '))}</div>
        <div><strong>Produced by:</strong> Hader &middot; ALIGNED platform</div>
      </div>
      <div class="conf">CONFIDENTIAL — contains business and customer data. Handle per your data-protection obligations.</div>
    </div>`;
}

/** One combined document with every section. */
export function renderCombinedHtml(orgName: string, sections: ReportSection[], generatedAtIso: string): string {
  const toc = `
    <div class="toc"><h2>Contents</h2><ol>${sections
      .map((s) => `<li>${esc(s.label)} <span style="color:${MUTED}">(${s.tables.reduce((n, t) => n + t.rows.length, 0)} rows)</span></li>`)
      .join('')}</ol></div>`;
  const body = sections.map(renderSectionBody).join('');
  return docShell(
    coverPage(orgName, 'Business Data Report', generatedAtIso, sections.map((s) => s.label)) + toc + body,
  );
}

/** A single-section document. */
export function renderSectionHtml(orgName: string, section: ReportSection, generatedAtIso: string): string {
  return docShell(
    coverPage(orgName, section.label, generatedAtIso, [section.label]) + renderSectionBody(section),
  );
}

/** Render an HTML string to a PDF Buffer using a shared Chromium browser. */
export async function htmlToPdf(browser: Browser, html: string): Promise<Buffer> {
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
    const footer = `
      <div style="width:100%;font-size:8px;color:#6b6169;padding:0 14mm;display:flex;justify-content:space-between;">
        <span>Hader &middot; ALIGNED — Confidential</span>
        <span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>
      </div>`;
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: footer,
      margin: { top: '14mm', bottom: '16mm', left: '10mm', right: '10mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}
