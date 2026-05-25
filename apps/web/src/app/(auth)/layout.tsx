import { AlignedLogo } from '@/components/brand/logo';

// Auth shell modelled after Slide 10 ("End / Sign-off") of the Hader
// brand book. Single oxblood surface, sand foreground, signal-red mark,
// mono-uppercase chrome at the bottom. The form sits below a centered
// hero stack instead of in a right-column split.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 flex flex-col overflow-y-auto bg-brand-500 text-sand-300">
      {/* Top chrome — wordmark + back-to-marketing link. Mono mirrors
          the brand-book chrome bar. */}
      <header className="flex items-center justify-between px-6 py-6 sm:px-10 lg:px-14">
        <a
          href="https://hader.ai/"
          aria-label="Hader AI — back to homepage"
          className="rounded transition hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sand-300/40"
        >
          <AlignedLogo className="!text-sand-300" />
        </a>
        <a
          href="https://hader.ai/"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-sand-300/60 transition hover:text-sand-300"
        >
          ← Back to site
        </a>
      </header>

      {/* Centered content — the slide-10 stack. The page renders
          children into the lower half so the brand mark + headline
          act as the slide's hero, with the form as its sign-off. */}
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-10 sm:px-10 lg:px-14">
        {children}
      </main>

      {/* Bottom chrome — mono caps with absolute positions like the
          brand-book slide footer. Hidden on mobile to save room. */}
      <footer className="hidden items-center justify-between px-14 pb-7 font-mono text-[12px] uppercase tracking-[0.18em] text-sand-300/50 sm:flex">
        <span>Hader AI · Portal</span>
        <span>Sign in / 01</span>
      </footer>
    </div>
  );
}
