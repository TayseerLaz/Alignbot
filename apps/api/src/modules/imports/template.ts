// Generates downloadable XLSX import templates per entity kind, with
// header row, sample data row, and a column mapping cheat-sheet on a second sheet.
import type { ImportEntityKind, ImportFieldHint } from '@aligned/shared';
import ExcelJS from 'exceljs';

interface TemplateSpec {
  fields: ImportFieldHint[];
  sample: Record<string, string | number | boolean>;
}

export const TEMPLATES: Record<ImportEntityKind, TemplateSpec> = {
  product: {
    fields: [
      { field: 'sku', label: 'SKU', required: true, description: 'Unique identifier per product' },
      { field: 'name', label: 'Name', required: true, description: 'Display name' },
      { field: 'shortDescription', label: 'Short description', required: false },
      { field: 'description', label: 'Description', required: false, description: 'Long-form, markdown OK' },
      { field: 'priceMinor', label: 'Price (cents)', required: false, description: 'Integer cents, e.g. 1999 = $19.99' },
      { field: 'currency', label: 'Currency', required: false, description: '3-letter ISO, e.g. USD' },
      { field: 'isAvailable', label: 'Available', required: false, description: 'true/false' },
      { field: 'stockQuantity', label: 'Stock', required: false },
      { field: 'categorySlug', label: 'Category slug', required: false, description: 'Will be created if missing' },
    ],
    sample: {
      sku: 'WIDGET-001',
      name: 'Premium Widget',
      shortDescription: 'A premium widget for everyday use',
      description: 'Long description here.',
      priceMinor: 1999,
      currency: 'USD',
      isAvailable: true,
      stockQuantity: 50,
      categorySlug: 'widgets',
    },
  },
  service: {
    fields: [
      { field: 'name', label: 'Name', required: true },
      { field: 'shortDescription', label: 'Short description', required: false },
      { field: 'description', label: 'Description', required: false },
      { field: 'durationMinutes', label: 'Duration (minutes)', required: false },
      { field: 'basePriceMinor', label: 'Base price (cents)', required: false },
      { field: 'currency', label: 'Currency', required: false },
      {
        field: 'priceUnit',
        label: 'Price unit',
        required: false,
        description: 'flat | per_hour | per_day | per_session | per_unit',
      },
      { field: 'isAvailable', label: 'Available', required: false },
      { field: 'categorySlug', label: 'Category slug', required: false },
    ],
    sample: {
      name: 'Consulting session',
      shortDescription: '30-minute consult',
      description: 'A 30-minute strategy session.',
      durationMinutes: 30,
      basePriceMinor: 5000,
      currency: 'USD',
      priceUnit: 'flat',
      isAvailable: true,
      categorySlug: 'consulting',
    },
  },
  faq: {
    fields: [
      { field: 'question', label: 'Question', required: true },
      { field: 'answer', label: 'Answer', required: true },
      { field: 'visibility', label: 'Visibility', required: false, description: 'public | private (default: public)' },
      { field: 'tags', label: 'Tags', required: false, description: 'Comma-separated' },
    ],
    sample: {
      question: 'What is your return policy?',
      answer: 'You may return any item within 30 days of purchase.',
      visibility: 'public',
      tags: 'returns, policy',
    },
  },
  business_info: {
    fields: [
      { field: 'legalName', label: 'Legal name', required: false },
      { field: 'tagline', label: 'Tagline', required: false },
      { field: 'about', label: 'About', required: false },
      { field: 'websiteUrl', label: 'Website URL', required: false },
      { field: 'timezone', label: 'Timezone', required: false },
      { field: 'currency', label: 'Currency', required: false },
    ],
    sample: {
      legalName: 'Aligned Demo, Inc.',
      tagline: 'Aligning technology with your business',
      about: 'A short business description.',
      websiteUrl: 'https://aligned.example',
      timezone: 'UTC',
      currency: 'USD',
    },
  },
};

export async function buildTemplateXlsx(kind: ImportEntityKind): Promise<Buffer> {
  const spec = TEMPLATES[kind];
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ALIGNED Business Platform';
  wb.created = new Date();

  const sheet = wb.addWorksheet(kind);
  sheet.columns = spec.fields.map((f) => ({
    header: f.label,
    key: f.field,
    width: Math.max(16, f.label.length + 4),
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: 'middle' };
  // Sample row
  sheet.addRow(spec.sample);

  const help = wb.addWorksheet('How to import');
  help.columns = [
    { header: 'Field', key: 'field', width: 24 },
    { header: 'Required', key: 'required', width: 12 },
    { header: 'Description', key: 'description', width: 60 },
  ];
  help.getRow(1).font = { bold: true };
  for (const f of spec.fields) {
    help.addRow({ field: f.field, required: f.required ? 'YES' : '', description: f.description ?? '' });
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
