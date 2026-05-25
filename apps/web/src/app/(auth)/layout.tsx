import { AlignedLogo } from '@/components/brand/logo';

// Two-column auth shell on a single oxblood surface. The form area
// inherits the brand background so the type system reads as one
// consistent white-on-oxblood treatment. Wordmark top-left is a
// clickable link back to the marketing site.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 grid overflow-y-auto bg-brand-500 text-white lg:grid-cols-[5fr_7fr]">
      {/* Top-left wordmark — clickable, returns to hader.ai. Always
          white on this surface. */}
      <a
        href="https://hader.ai/"
        aria-label="Hader AI — back to homepage"
        className="absolute left-6 top-6 z-20 inline-block rounded transition hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 sm:left-8 sm:top-8 lg:left-12 lg:top-12"
      >
        <AlignedLogo className="!text-white" />
      </a>

      <BrandPanel />
      <section className="flex h-full flex-col justify-center px-6 py-10 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-sm">{children}</div>
      </section>
    </div>
  );
}

function BrandPanel() {
  return (
    <aside className="relative hidden flex-col justify-end p-12 text-white lg:flex">
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
