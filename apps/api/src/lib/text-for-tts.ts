// Rewrites a bot reply so ElevenLabs pronounces prices naturally in
// the matching language. The bot's normal text uses ISO codes (e.g.
// "0.150 KWD") because that's what looks right when read as text.
// In a voice reply, ElevenLabs reads "KWD" as English letters
// ("kay-double-yoo-dee"), which breaks the flow of an Arabic sentence
// and sounds robotic in English too. This helper:
//   - detects the surrounding language (Arabic if any Arabic letters
//     appear, else English)
//   - replaces each "<number> <CODE>" match with the spoken currency
//     name in that language
//   - collapses sub-major amounts to their minor unit ("150 fils"
//     reads more naturally than "zero point one five zero dinar")
//
// Only used on the TTS path — the original `reply` text is still
// saved to the inbox and sent in the text-fallback branch.

interface CurrencyEntry {
  en: { major: string; minor: string };
  ar: { major: string; minor: string };
  minorPerMajor: 100 | 1000;
}

const CURRENCIES: Record<string, CurrencyEntry> = {
  KWD: { en: { major: 'Kuwaiti Dinar', minor: 'fils' }, ar: { major: 'دينار كويتي', minor: 'فلس' }, minorPerMajor: 1000 },
  BHD: { en: { major: 'Bahraini Dinar', minor: 'fils' }, ar: { major: 'دينار بحريني', minor: 'فلس' }, minorPerMajor: 1000 },
  OMR: { en: { major: 'Omani Rial', minor: 'baisa' }, ar: { major: 'ريال عماني', minor: 'بيسة' }, minorPerMajor: 1000 },
  JOD: { en: { major: 'Jordanian Dinar', minor: 'fils' }, ar: { major: 'دينار أردني', minor: 'فلس' }, minorPerMajor: 1000 },
  AED: { en: { major: 'UAE Dirham', minor: 'fils' }, ar: { major: 'درهم إماراتي', minor: 'فلس' }, minorPerMajor: 100 },
  SAR: { en: { major: 'Saudi Riyal', minor: 'halala' }, ar: { major: 'ريال سعودي', minor: 'هللة' }, minorPerMajor: 100 },
  QAR: { en: { major: 'Qatari Riyal', minor: 'dirham' }, ar: { major: 'ريال قطري', minor: 'درهم' }, minorPerMajor: 100 },
  USD: { en: { major: 'US dollars', minor: 'cents' }, ar: { major: 'دولار أمريكي', minor: 'سنت' }, minorPerMajor: 100 },
  EUR: { en: { major: 'euros', minor: 'cents' }, ar: { major: 'يورو', minor: 'سنت' }, minorPerMajor: 100 },
  GBP: { en: { major: 'pounds', minor: 'pence' }, ar: { major: 'جنيه إسترليني', minor: 'بنس' }, minorPerMajor: 100 },
  EGP: { en: { major: 'Egyptian pounds', minor: 'piastres' }, ar: { major: 'جنيه مصري', minor: 'قرش' }, minorPerMajor: 100 },
  LBP: { en: { major: 'Lebanese pounds', minor: 'piastres' }, ar: { major: 'ليرة لبنانية', minor: 'قرش' }, minorPerMajor: 100 },
  TRY: { en: { major: 'Turkish Lira', minor: 'kurus' }, ar: { major: 'ليرة تركية', minor: 'كروش' }, minorPerMajor: 100 },
};

function isArabic(text: string): boolean {
  return /[؀-ۿ]/.test(text);
}

function spokenPrice(value: number, code: string, lang: 'en' | 'ar'): string {
  const c = CURRENCIES[code];
  if (!c) return `${value} ${code}`;
  const names = c[lang];

  const totalMinor = Math.round(value * c.minorPerMajor);
  const major = Math.floor(totalMinor / c.minorPerMajor);
  const minor = totalMinor - major * c.minorPerMajor;

  if (major === 0 && minor > 0) {
    return `${minor} ${names.minor}`;
  }
  if (minor === 0) {
    return `${major} ${names.major}`;
  }
  return lang === 'ar'
    ? `${major} ${names.major} و ${minor} ${names.minor}`
    : `${major} ${names.major} and ${minor} ${names.minor}`;
}

export function rewriteForTts(text: string): string {
  if (!text) return text;
  const lang: 'en' | 'ar' = isArabic(text) ? 'ar' : 'en';

  // Match "<number> <CODE>" where CODE is one of our known 3-letter ISO
  // codes. \b on the right side guards against eating part of a longer
  // identifier (e.g. "USDC"). The currency code list is a literal
  // alternation so unknown codes are left alone.
  const codes = Object.keys(CURRENCIES).join('|');
  const re = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(?:${codes})\\b`, 'g');
  return text.replace(re, (full, num) => {
    const code = full.match(new RegExp(`(${codes})$`))?.[1];
    if (!code) return full;
    const value = parseFloat(String(num).replace(',', '.'));
    if (!Number.isFinite(value)) return full;
    return spokenPrice(value, code, lang);
  });
}
