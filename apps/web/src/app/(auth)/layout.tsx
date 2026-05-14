import { AlignedLogo } from '@/components/brand/logo';

// The auth layout takes its visual cue from a Peter Boyadjieff-style
// concentric-halo painting: white field, one big soft "aurora" of
// yellow→orange→magenta→purple→indigo→navy, with the form floating in
// negative space. We stack two blurred radial-gradient orbs (one
// large background, one smaller foreground accent) for depth.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-dvh overflow-hidden bg-white">
      {/* Background halo — large, soft, concentric. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-[18%] top-1/2 -z-10 size-[140vmin] -translate-y-1/2 rounded-full opacity-80 blur-3xl"
        style={{
          background:
            'radial-gradient(circle at 50% 50%, #0a0f3a 0%, #1e1b4b 18%, #4c1d95 36%, #a21caf 50%, #ea580c 64%, #facc15 76%, transparent 92%)',
        }}
      />
      {/* Smaller offset accent halo — adds the painting's "drip" feel. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-[12%] -top-[10%] -z-10 size-[70vmin] rounded-full opacity-60 blur-3xl"
        style={{
          background:
            'radial-gradient(circle at 50% 50%, #1e1b4b 0%, #7c3aed 30%, #ec4899 55%, #f59e0b 75%, transparent 92%)',
        }}
      />

      {/* Page chrome — logo top-left, footer bottom-center. */}
      <header className="absolute left-0 right-0 top-0 z-10 flex items-center justify-between px-6 py-6 sm:px-10">
        <AlignedLogo />
      </header>

      {/* Center the form. Card is white with a faint border so it lifts
          off the halo without competing with it. */}
      <main className="relative z-10 mx-auto flex min-h-dvh w-full max-w-md items-center justify-center px-6 py-24">
        <div className="w-full rounded-2xl border border-black/5 bg-white/95 p-8 shadow-[0_30px_80px_-30px_rgba(15,23,42,0.25)] backdrop-blur-sm sm:p-10">
          {children}
        </div>
      </main>

      <footer className="absolute inset-x-0 bottom-0 z-10 px-6 pb-6 text-center">
        <p className="text-xs text-foreground-subtle">
          © {new Date().getFullYear()} ALIGNED · Aligning Technology with Your Business
        </p>
      </footer>
    </div>
  );
}
