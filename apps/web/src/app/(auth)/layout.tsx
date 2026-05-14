// Reference: centred rounded card on a near-black page. Card is split
// in two: a green-gradient brand panel on the left (headline + 3
// onboarding chips) and a dark form panel on the right. The form
// content comes in via {children}. On mobile the left panel collapses.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#0a0a0c] p-4 text-white sm:p-8">
      <div className="grid w-full max-w-6xl overflow-hidden rounded-3xl border border-white/5 bg-[#111114] shadow-[0_30px_120px_-30px_rgba(0,0,0,0.9)] lg:grid-cols-2">
        <BrandPanel />
        <section className="flex flex-col px-8 py-10 sm:px-14 sm:py-16">{children}</section>
      </div>
    </div>
  );
}

// Left side — green gradient with a headline + three numbered chips.
// First chip is "active" (white card, dark text); the others are
// dimmer to match the reference exactly.
function BrandPanel() {
  const steps = [
    { n: 1, label: 'Manage your catalog', active: true },
    { n: 2, label: 'Sync to WhatsApp' },
    { n: 3, label: 'Capture bookings' },
  ];
  return (
    <aside
      aria-hidden
      className="relative hidden flex-col justify-between p-12 lg:flex"
      style={{
        background:
          'radial-gradient(ellipse at 30% 30%, #1f6b4e 0%, #134a36 35%, #0b3326 65%, #07241b 100%)',
      }}
    >
      {/* Subtle inner highlight to match the reference's soft glow. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 50% 0%, rgba(255,255,255,0.08) 0%, transparent 50%)',
        }}
      />

      <div className="relative" />

      <div className="relative mt-auto">
        <div className="grid items-end gap-6 sm:grid-cols-[1fr_auto]">
          <h2 className="text-4xl font-semibold leading-[1.1] tracking-tight text-white sm:text-5xl">
            Get Started
            <br />
            with Us
          </h2>
          <p className="max-w-[14ch] text-sm leading-snug text-white/80 sm:text-right">
            Complete these easy steps to register your account.
          </p>
        </div>

        <ul className="mt-8 grid grid-cols-3 gap-3">
          {steps.map((s) => (
            <li
              key={s.n}
              className={
                s.active
                  ? 'rounded-2xl bg-white px-4 py-4 text-black shadow-lg'
                  : 'rounded-2xl bg-white/10 px-4 py-4 text-white/80 backdrop-blur-sm'
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
                    ? 'mt-4 text-[13px] font-medium leading-snug'
                    : 'mt-4 text-[13px] leading-snug'
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
