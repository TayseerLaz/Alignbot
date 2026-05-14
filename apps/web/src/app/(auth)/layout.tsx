import Image from 'next/image';
import { Outfit } from 'next/font/google';

// Outfit is a clean geometric sans-serif that closely matches the
// proportions of the ALIGNED wordmark in /aligned-logo.webp. Scoped
// to the auth tree only so the rest of the app keeps IBM Plex Sans.
const outfit = Outfit({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
});

// Full-page two-column auth shell. Left = brand-blue gradient panel
// with the logo, headline, and three feature chips that pitch the
// platform. Right = dark form area (children). Edge-to-edge, no
// card chrome. Mobile: left panel collapses; form owns the screen.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${outfit.className} fixed inset-0 grid overflow-hidden bg-[#0a0a0c] text-white lg:grid-cols-2`}>
      <BrandPanel />
      <section className="flex h-full flex-col justify-center overflow-hidden px-6 py-10 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-sm">
          {/* Mobile-only logo since the brand panel hides. */}
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
  // Feature chips pitching what Alignbot does for new sign-ins. First
  // chip is "active" (white card with black dot) for the same visual
  // rhythm as the reference; the other two sit on translucent glass.
  const features = [
    { n: 1, label: 'AI WhatsApp\nchatbot', active: true },
    { n: 2, label: 'Synced catalog\n& FAQs' },
    { n: 3, label: 'Bookings captured\nautomatically' },
  ];
  return (
    <aside
      className="relative hidden flex-col justify-end overflow-hidden p-12 lg:flex"
      style={{
        background:
          'radial-gradient(ellipse 80% 70% at 70% 20%, #3a92cf 0%, #2575b0 28%, #185585 55%, #0c2f4c 85%, #061829 100%)',
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 60% 0%, rgba(255,255,255,0.18) 0%, transparent 55%)',
        }}
      />

      {/* Logo — top-left of the brand panel. */}
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
            One inbox for
            <br />
            every customer
          </h2>
          <p className="max-w-[22ch] text-sm leading-snug text-white/80">
            Alignbot turns your catalog, FAQs, and business info into a 24/7
            WhatsApp chatbot — and captures every booking in one place.
          </p>
        </div>

        <ul className="mt-10 grid grid-cols-3 gap-3">
          {features.map((f) => (
            <li
              key={f.n}
              className={
                f.active
                  ? 'rounded-xl bg-white p-4 text-black shadow-lg'
                  : 'rounded-xl bg-white/10 p-4 text-white/80 backdrop-blur-sm'
              }
            >
              <span
                className={
                  f.active
                    ? 'flex size-6 items-center justify-center rounded-full bg-black text-[11px] font-semibold text-white'
                    : 'flex size-6 items-center justify-center rounded-full bg-white/20 text-[11px] font-semibold text-white'
                }
              >
                {f.n}
              </span>
              <p
                className={
                  f.active
                    ? 'mt-6 whitespace-pre-line text-[13px] font-semibold leading-tight'
                    : 'mt-6 whitespace-pre-line text-[13px] leading-tight'
                }
              >
                {f.label}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
