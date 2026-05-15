import type { Metadata } from 'next';
import { JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';

import { Providers } from '@/components/providers';
import '@/styles/globals.css';

// Aligned design system — Plus Jakarta Sans (display + body) +
// JetBrains Mono (SKUs, IDs, code, mono numerics).
const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700', '800'],
  variable: '--font-jakarta',
  display: 'swap',
});

const monoJb = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono-jb',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'ALIGNED Business Platform',
    template: '%s · ALIGNED',
  },
  description: 'Manage your business data and WhatsApp chatbot from one place.',
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} ${monoJb.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
