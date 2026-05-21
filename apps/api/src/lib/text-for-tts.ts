// Rewrites a bot reply so ElevenLabs pronounces prices naturally in
// the matching language. The bot's normal text uses ISO codes (e.g.
// "0.150 KWD") because that's what looks right when read as text;
// in voice, ElevenLabs reads "KWD" as English letters
// ("kay-double-yoo-dee"), which breaks the flow of an Arabic sentence
// and sounds robotic in English too.
//
// This helper:
//   - detects the surrounding language (Arabic if any Arabic letters
//     appear, else English)
//   - replaces each "<number> <CODE>" match with the full currency
//     name in that language ("Kuwaiti Dinar" / "دينار كويتي", etc.)
//   - strips trailing zeros from the number so "0.150 KWD" reads as
//     "zero point one five Kuwaiti Dinar" instead of
//     "zero point one five zero Kuwaiti Dinar"
//
// Only used on the TTS path — the original `reply` text is still
// saved to the inbox and sent in the text-fallback branch.

const CURRENCY_NAMES: Record<string, { en: string; ar: string }> = {
  KWD: { en: 'Kuwaiti Dinar', ar: 'دينار كويتي' },
  BHD: { en: 'Bahraini Dinar', ar: 'دينار بحريني' },
  OMR: { en: 'Omani Rial', ar: 'ريال عماني' },
  JOD: { en: 'Jordanian Dinar', ar: 'دينار أردني' },
  AED: { en: 'UAE Dirham', ar: 'درهم إماراتي' },
  SAR: { en: 'Saudi Riyal', ar: 'ريال سعودي' },
  QAR: { en: 'Qatari Riyal', ar: 'ريال قطري' },
  USD: { en: 'US dollars', ar: 'دولار أمريكي' },
  EUR: { en: 'euros', ar: 'يورو' },
  GBP: { en: 'pounds', ar: 'جنيه إسترليني' },
  EGP: { en: 'Egyptian pounds', ar: 'جنيه مصري' },
  LBP: { en: 'Lebanese pounds', ar: 'ليرة لبنانية' },
  TRY: { en: 'Turkish Lira', ar: 'ليرة تركية' },
};

function isArabic(text: string): boolean {
  return /[؀-ۿ]/.test(text);
}

// "0.150" → "0.15", "5.000" → "5", "5" → "5", "5.50" → "5.5"
function stripTrailingZeros(num: string): string {
  if (!num.includes('.') && !num.includes(',')) return num;
  const sep = num.includes('.') ? '.' : ',';
  const [intPart, fracPart = ''] = num.split(sep);
  const trimmed = fracPart.replace(/0+$/, '');
  return trimmed ? `${intPart}${sep}${trimmed}` : intPart!;
}

export function rewriteForTts(text: string): string {
  if (!text) return text;
  const lang: 'en' | 'ar' = isArabic(text) ? 'ar' : 'en';

  // Match "<number> <CODE>" where CODE is one of our known 3-letter ISO
  // codes. \b on the right guards against eating part of a longer
  // identifier (e.g. "USDC"). The currency code list is a literal
  // alternation so unknown codes pass through unchanged.
  const codes = Object.keys(CURRENCY_NAMES).join('|');
  const re = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${codes})\\b`, 'g');
  return text.replace(re, (_full, num: string, code: string) => {
    const names = CURRENCY_NAMES[code];
    if (!names) return _full;
    return `${stripTrailingZeros(num)} ${names[lang]}`;
  });
}
