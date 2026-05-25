import { AlignedLogo } from '@/components/brand/logo';

// Full-page two-column auth shell. Visual language mirrors the
// hader.ai marketing site: Desert Sand body, Oxblood brand panel
// with a Signal Red pulse accent, Plus Jakarta heavy headlines + a
// Fraunces italic emphasis word. The right column hosts the auth
// form on a soft elevated sand card.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 grid overflow-y-auto bg-sand-300 text-brand-500 lg:grid-cols-2">
      <BrandPanel />
      <section className="flex h-full flex-col justify-center px-6 py-10 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-md">
          <div className="mb-10 flex justify-center lg:hidden">
            <AlignedLogo />
          </div>
          {children}
        </div>
      </section>
    </div>
  );
}

// Left column on lg+. Oxblood gradient, sand text, a pulse-dot eyebrow,
// a heavy headline with one italic Fraunces accent word, and three
// feature chips matching the marketing site's hero tiles.
function BrandPanel() {
  const features: { n: number; label: string }[] = [
    { n: 1, label: 'AI WhatsApp\nchatbot' },
    { n: 2, label: 'Synced catalog\n& FAQs' },
    { n: 3, label: 'Bookings captured\nautomatically' },
  ];
  return (
    <aside
      className="relative hidden flex-col overflow-hidden p-12 text-sand-300 lg:flex"
      style={{
        background:
          'radial-gradient(ellipse 90% 70% at 55% 50%, #4a1525 0%, #360516 45%, #1a0a10 100%)',
      }}
    >
      {/* Soft warm overlay so the gradient never feels muddy on big monitors. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 70% 50% at 50% 45%, rgba(207,192,169,0.18) 0%, transparent 60%), linear-gradient(180deg, rgba(26,10,16,0) 0%, rgba(26,10,16,0.4) 100%)',
        }}
      />
      {/* Grain so the panel doesn't feel like flat CSS. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.06] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.7 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")",
        }}
      />

      <div className="relative z-[3] flex h-full flex-col">
        <AlignedLogo />

        <div className="mt-auto">
          {/* Marketing-style "kicker" eyebrow: pulse dot + mono caps. */}
          <p className="mb-6 inline-flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-sand-300/85">
            <span className="relative inline-flex size-2 rounded-full bg-coral-500">
              <span className="absolute inset-[-4px] animate-[pulse_1.8s_ease-out_infinite] rounded-full border-2 border-coral-500/60" />
            </span>
            Hader portal · Login
          </p>

          <h2
            className="mb-7 text-5xl font-extrabold leading-[0.9] tracking-[-0.04em] text-sand-300"
          >
            One inbox for{' '}
            <span
              className="font-normal not-italic text-sand-300"
              style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}
            >
              every business.
            </span>
          </h2>

          <p className="mb-9 max-w-md text-base leading-relaxed text-sand-300/80">
            Sign in to your Hader workspace — manage your catalog, conversations,
            and AI replies from one place.
          </p>

          <ul className="grid grid-cols-3 gap-2.5">
            {features.map((f) => (
              <li
                key={f.n}
                className="flex min-h-[108px] flex-col justify-between rounded-2xl border border-sand-300/20 bg-sand-300/[0.08] p-3 text-sand-300/85 backdrop-blur-md transition hover:-translate-y-0.5 hover:border-sand-300/40"
              >
                <span className="flex size-6 items-center justify-center rounded-full bg-sand-300/15 font-mono text-[11px] font-semibold text-sand-300/95">
                  {f.n}
                </span>
                <span className="whitespace-pre-line text-[12.5px] font-medium leading-tight">
                  {f.label}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </aside>
  );
}
