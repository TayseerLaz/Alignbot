import { AlignedLogo } from '@/components/brand/logo';

// Two-column auth shell. Deliberately simple: solid oxblood panel on the
// left (just a tagline), clean white form surface on the right. One
// typeface (Plus Jakarta Sans), one accent. The Hader wordmark sits in
// the top-left of the viewport in one place — white when it overlays the
// oxblood brand panel (lg+), oxblood when it's over the white form area
// (mobile).
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 grid overflow-y-auto bg-sand-300 text-brand-500 lg:grid-cols-[5fr_7fr]">
      {/* Top-left logo — single source, color-aware so it reads against
          whichever surface is behind it at the current viewport. */}
      <div className="pointer-events-none absolute left-6 top-6 z-20 sm:left-8 sm:top-8 lg:left-12 lg:top-12">
        <AlignedLogo className="pointer-events-auto text-brand-500 lg:text-white" />
      </div>

      <BrandPanel />
      <section className="flex h-full flex-col justify-center px-6 py-10 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-sm">{children}</div>
      </section>
    </div>
  );
}

function BrandPanel() {
  return (
    <aside className="relative hidden flex-col justify-end bg-brand-500 p-12 text-white lg:flex">
      <div>
        <h2 className="max-w-md text-3xl font-semibold leading-tight tracking-tight text-white">
          Every WhatsApp, answered.
        </h2>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-white/70">
          Sign in to your Hader workspace — catalog, conversations, and AI
          replies in one place.
        </p>
      </div>
    </aside>
  );
}
