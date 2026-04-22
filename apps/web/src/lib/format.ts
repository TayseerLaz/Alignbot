/**
 * Money is stored as integer minor units (e.g. cents). Format using Intl.
 * Pass null/undefined to get a dash.
 */
export function formatMoney(
  minor: number | null | undefined,
  currency: string = 'USD',
  locale = 'en-US',
): string {
  if (minor === null || minor === undefined) return '—';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

export function parseMoneyMajor(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const num = Number(trimmed.replace(/,/g, ''));
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100);
}

export function minorToMajorString(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return '';
  return (minor / 100).toFixed(2);
}

/** Convert minutes-since-midnight (0..1440) to "HH:MM" string. */
export function minutesToTime(min: number): string {
  const h = Math.floor(min / 60).toString().padStart(2, '0');
  const m = (min % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

/** "HH:MM" → minutes since midnight (0..1440). */
export function timeToMinutes(time: string): number {
  const [h = '0', m = '0'] = time.split(':');
  return Number(h) * 60 + Number(m);
}

export function formatRelative(iso: string | null | undefined, locale = 'en-US'): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60_000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(minutes) < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return rtf.format(-days, 'day');
  return date.toLocaleDateString(locale);
}
