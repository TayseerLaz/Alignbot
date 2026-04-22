import { AlignedLogo } from '@/components/brand/logo';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <div className="flex flex-col px-6 py-10 sm:px-12">
        <AlignedLogo />
        <div className="flex flex-1 items-center justify-center py-12">
          <div className="w-full max-w-md">{children}</div>
        </div>
        <p className="text-center text-xs text-foreground-subtle">
          © {new Date().getFullYear()} ALIGNED · Aligning Technology with Your Business
        </p>
      </div>
      <aside
        aria-hidden
        className="relative hidden overflow-hidden bg-brand-500 lg:block"
        style={{
          backgroundImage:
            'radial-gradient(1200px 600px at 80% -10%, rgba(255,255,255,0.12), transparent), radial-gradient(800px 400px at -10% 110%, rgba(255,255,255,0.08), transparent)',
        }}
      >
        <div className="flex h-full flex-col justify-end p-12 text-white">
          <p className="max-w-md text-balance text-2xl font-medium leading-snug">
            One source of truth for your products, services, and customer answers — synced to your
            WhatsApp chatbot in real time.
          </p>
          <ul className="mt-8 space-y-2 text-sm text-white/80">
            <li>· Manage product &amp; service data with auto-save and versioning</li>
            <li>· Bulk import from CSV/Excel or connect your existing systems</li>
            <li>· Sub-200ms WhatsApp answers with intelligent caching</li>
          </ul>
        </div>
      </aside>
    </div>
  );
}
