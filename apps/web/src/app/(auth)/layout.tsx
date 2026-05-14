import Image from 'next/image';

// Full-page two-column auth shell. Left = brand blue gradient panel
// with copy + onboarding chips. Right = dark form area (children).
// Edge-to-edge, no card chrome — the columns fill the viewport.
// Mobile: left panel collapses; the right column owns the screen.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 grid overflow-hidden bg-[#0a0a0c] text-white lg:grid-cols-2">
      <BrandPanel />
      {/* Form column. overflow-hidden so the page is truly fixed —
          no scrolling on this column or the body. */}
      <section className="flex h-full flex-col justify-center overflow-hidden px-6 py-10 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-sm">
          {/* Mobile-only ALIGNED logo since the brand panel hides. */}
          <div className="mb-8 flex justify-center lg:hidden">
            <Image
              src="/aligned-logo.webp"
              alt="ALIGNED"
              width={180}
              height={36}
              priority
            />
          </div>
          {children}
        </div>
      </section>
    </div>
  );
}

function BrandPanel() {
  const steps = [
    { n: 1, label: 'Sign in to your\naccount', active: true },
    { n: 2, label: 'Pick up where\nyou left off' },
    { n: 3, label: 'Manage your\nworkspace' },
  ];
  return (
    <aside
      className="relative hidden flex-col justify-end overflow-hidden p-12 lg:flex"
      style={{
        // Brand blue gradient — sampled from the ALIGNED logo's three
        // dashes (#3083bd). Highlight at top-right fades through a
        // mid steel-blue into deep navy/near-black at the bottom-left.
        background:
          'radial-gradient(ellipse 80% 70% at 70% 20%, #3a92cf 0%, #2575b0 28%, #185585 55%, #0c2f4c 85%, #061829 100%)',
      }}
    >
      {/* Soft inner highlight near the top — same as the reference. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 60% 0%, rgba(255,255,255,0.18) 0%, transparent 55%)',
        }}
      />

      {/* ALIGNED logo — top-left of the brand panel. */}
      <div className="absolute left-12 top-12 z-10">
        <Image
          src="/aligned-logo.webp"
          alt="ALIGNED"
          width={200}
          height={40}
          priority
        />
      </div>

      <div className="relative">
        <div className="grid items-end gap-x-10 gap-y-4 sm:grid-cols-[1fr_auto]">
          <h2 className="text-5xl font-semibold leading-[1.05] tracking-tight text-white">
            Get Started
            <br />
            with Us
          </h2>
          <p className="max-w-[20ch] text-sm leading-snug text-white/80">
            Complete these easy steps to register your account.
          </p>
        </div>

        <ul className="mt-10 grid grid-cols-3 gap-3">
          {steps.map((s) => (
            <li
              key={s.n}
              className={
                s.active
                  ? 'rounded-xl bg-white p-4 text-black shadow-lg'
                  : 'rounded-xl bg-white/10 p-4 text-white/80 backdrop-blur-sm'
              }
            >
              <span
                className={
                  s.active
                    ? 'flex size-6 items-center justify-center rounded-full bg-black text-[11px] font-semibold text-white'
                    : 'flex size-6 items-center justify-center rounded-full bg-white/20 text-[11px] font-semibold text-white'
                }
              >
                {s.n}
              </span>
              <p
                className={
                  s.active
                    ? 'mt-6 whitespace-pre-line text-[13px] font-semibold leading-tight'
                    : 'mt-6 whitespace-pre-line text-[13px] leading-tight'
                }
              >
                {s.label}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
