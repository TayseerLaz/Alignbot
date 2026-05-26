import type { Metadata } from 'next';
import { Fraunces, JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';
import { headers } from 'next/headers';

import { Providers } from '@/components/providers';
import '@/styles/globals.css';

// Hader AI brand book — Fraunces (display + headlines) + Plus Jakarta Sans
// (body + UI) + JetBrains Mono (SKUs, IDs, code, mono numerics).
const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700', '800'],
  variable: '--font-jakarta',
  display: 'swap',
});

const fraunces = Fraunces({
  subsets: ['latin'],
  // next/font requires weight to be omitted (or `variable`) when axes are
  // declared, since the file IS the variable font. Without weight we get
  // the full 100-900 axis at runtime via `font-weight` — same effect as
  // listing discrete weights but in one file.
  variable: '--font-fraunces',
  display: 'swap',
  // Fraunces ships a variable optical-size axis — letting Next bake it in
  // means headings render with the "Display" optical sizing automatically.
  axes: ['opsz'],
});

const monoJb = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono-jb',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Hader AI',
    template: '%s · Hader AI',
  },
  description: 'The AI ops layer for your business. WhatsApp catalogs, conversations, and intelligence in one place.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
};

// Inline script that runs before React hydrates: reads the persisted theme
// (or OS preference) and sets the `dark` class on <html> so the page never
// flashes the wrong theme.
const themeBootstrap = `
(function () {
  try {
    var stored = localStorage.getItem('aligned:theme');
    var system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    var target = stored && stored !== 'system' ? stored : system;
    var root = document.documentElement;
    if (target === 'dark') root.classList.add('dark');
    root.style.colorScheme = target;
  } catch (e) {}
})();
`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Sprint 2 #17 — CSP nonce flows from the middleware. The inline theme
  // bootstrap script below must carry it so the browser doesn't block it
  // under the no-`unsafe-inline` policy.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html
      lang="en"
      className={`${jakarta.variable} ${fraunces.variable} ${monoJb.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
