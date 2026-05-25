import { AlignedLogo } from '@/components/brand/logo';

// Two colours, period — bypassing the theme tokens because brand-500
// flips to Signal Red in dark mode. These literal hexes lock the
// auth shell to the brand-book pairing regardless of system theme.
const OXBLOOD = '#360516';
const SAND = '#cfc0a9';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 flex flex-col overflow-y-auto"
      style={{ backgroundColor: OXBLOOD, color: SAND }}
    >
      <header className="flex items-center justify-between px-6 py-6 sm:px-10 lg:px-14">
        <a
          href="https://hader.ai/"
          aria-label="Hader AI — back to homepage"
          className="rounded-md px-2 py-1 transition hover:bg-[#cfc0a9] [&>span]:hover:!bg-[#360516] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#cfc0a9]/40"
        >
          <AlignedLogo className="!text-[#cfc0a9]" />
        </a>
        <a
          href="https://hader.ai/"
          className="rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[#cfc0a9]/70 transition hover:bg-[#cfc0a9] hover:text-[#360516]"
        >
          ← Back to site
        </a>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 py-10 sm:px-10 lg:px-14">
        {children}
      </main>

      <footer
        className="hidden items-center justify-between px-14 pb-7 font-mono text-[12px] uppercase tracking-[0.18em] sm:flex"
        style={{ color: `${SAND}80` }}
      >
        <span>Hader AI · Portal</span>
        <span>Sign in / 01</span>
      </footer>
    </div>
  );
}
