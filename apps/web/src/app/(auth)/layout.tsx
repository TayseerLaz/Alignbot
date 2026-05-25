import { AlignedLogo } from '@/components/brand/logo';

// Two colours, period:
//   bg     = Oxblood   (#360516)
//   text   = Desert Sand (#cfc0a9)
//   hover  = invert (sand bg + oxblood text)
// No accents, no signal red, no semantic colour bleed. Every
// hoverable surface flips the same way so the whole page feels
// like one interaction model.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 flex flex-col overflow-y-auto bg-brand-500 text-sand-300">
      <header className="flex items-center justify-between px-6 py-6 sm:px-10 lg:px-14">
        <a
          href="https://hader.ai/"
          aria-label="Hader AI — back to homepage"
          className="rounded-md px-2 py-1 transition hover:bg-sand-300 [&>span]:hover:!bg-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sand-300/40"
        >
          <AlignedLogo className="!text-sand-300" />
        </a>
        <a
          href="https://hader.ai/"
          className="rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-sand-300/70 transition hover:bg-sand-300 hover:text-brand-500"
        >
          ← Back to site
        </a>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 py-10 sm:px-10 lg:px-14">
        {children}
      </main>

      <footer className="hidden items-center justify-between px-14 pb-7 font-mono text-[12px] uppercase tracking-[0.18em] text-sand-300/50 sm:flex">
        <span>Hader AI · Portal</span>
        <span>Sign in / 01</span>
      </footer>
    </div>
  );
}
