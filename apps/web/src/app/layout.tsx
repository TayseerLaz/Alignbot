import type { Metadata } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import { headers } from 'next/headers';

import { Providers } from '@/components/providers';
import '@/styles/globals.css';

// Single-font system: Plus Jakarta Sans across the entire Hader panel
// (body, UI, headings, SKUs, prices, code blocks). The Fraunces (display
// serif) and JetBrains Mono (mono numerics) loaders that used to live
// here were dropped — saves ~100 KB of woff2 on every page load and
// gives every surface a consistent typographic feel.
const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700', '800'],
  variable: '--font-jakarta',
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
      className={jakarta.variable}
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
