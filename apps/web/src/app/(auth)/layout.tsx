import { AlignedLogo } from '@/components/brand/logo';

// Auth shell — Slide 10 ("Sign-off") of the Hader brand book, applied
// in the inverse colour treatment: Desert Sand surface, Oxblood
// foreground (the marketing-site root palette). Oxblood is the single
// accent — icon, headline, button, focus all share it.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 flex flex-col overflow-y-auto bg-sand-300 text-brand-500">
      <header className="flex items-center justify-between px-6 py-6 sm:px-10 lg:px-14">
        <a
          href="https://hader.ai/"
          aria-label="Hader AI — back to homepage"
          className="rounded transition hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
        >
          <AlignedLogo className="!text-brand-500" />
        </a>
        <a
          href="https://hader.ai/"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-brand-500/60 transition hover:text-brand-500"
        >
          ← Back to site
        </a>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 py-10 sm:px-10 lg:px-14">
        {children}
      </main>

      <footer className="hidden items-center justify-between px-14 pb-7 font-mono text-[12px] uppercase tracking-[0.18em] text-brand-500/50 sm:flex">
        <span>Hader AI · Portal</span>
        <span>Sign in / 01</span>
      </footer>
    </div>
  );
}
