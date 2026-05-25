import { AlignedLogo } from '@/components/brand/logo';

// Two-column auth shell. Deliberately simple: solid oxblood panel on the
// left (wordmark + a single short tagline), clean white form surface on
// the right. One typeface (Plus Jakarta Sans), one accent (Signal Red).
// No font mixing, no italic accents, no mono kickers — that combo read
// "busy" on the previous pass.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 grid overflow-y-auto bg-white text-brand-500 lg:grid-cols-[5fr_7fr]">
      <BrandPanel />
      <section className="flex h-full flex-col justify-center px-6 py-10 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-12 flex justify-center lg:hidden">
            <AlignedLogo />
          </div>
          {children}
        </div>
      </section>
    </div>
  );
}

function BrandPanel() {
  return (
    <aside className="relative hidden flex-col justify-between bg-brand-500 p-12 text-white lg:flex">
      <AlignedLogo className="text-white" />

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
