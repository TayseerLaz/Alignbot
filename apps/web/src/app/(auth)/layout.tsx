import { AlignedLogo } from '@/components/brand/logo';

// Dark "horizontal motion blur" hero aesthetic — black canvas with a
// wide magenta/purple/pink smear pulled across the middle. Pure CSS
// via stacked linear/radial gradients + a heavy blur. The form floats
// over it in a translucent dark card. Used by every auth page.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-dvh overflow-hidden bg-[#0a0a0c] text-white">
      {/* Horizontal smear: three layered gradients (each blurred) so
          the streaks look painted, not banded. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-1/2 -z-10 h-[60vmin] -translate-y-1/2 opacity-90 blur-3xl"
        style={{
          background: [
            'linear-gradient(90deg, transparent 0%, rgba(236,72,153,0.55) 22%, rgba(255,255,255,0.85) 42%, rgba(168,85,247,0.7) 60%, rgba(124,58,237,0.5) 78%, transparent 100%)',
          ].join(','),
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-1/2 -z-10 h-[42vmin] -translate-y-[60%] opacity-80 blur-2xl"
        style={{
          background:
            'linear-gradient(90deg, transparent 5%, rgba(217,70,239,0.65) 30%, rgba(255,182,193,0.7) 48%, rgba(147,51,234,0.55) 68%, transparent 95%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-1/2 -z-10 h-[28vmin] -translate-y-[40%] opacity-70 blur-xl"
        style={{
          background:
            'linear-gradient(90deg, transparent 12%, rgba(192,38,211,0.55) 35%, rgba(255,255,255,0.45) 50%, rgba(126,34,206,0.5) 65%, transparent 88%)',
        }}
      />
      {/* Subtle vertical vignette so the form card lifts off the smear. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 30%, rgba(10,10,12,0.55) 70%, rgba(10,10,12,0.9) 100%)',
        }}
      />

      <header className="absolute left-0 right-0 top-0 z-10 flex items-center justify-between px-6 py-6 sm:px-10">
        <AlignedLogo />
      </header>

      <main className="relative z-10 mx-auto flex min-h-dvh w-full max-w-md items-center justify-center px-6 py-24">
        <div className="w-full rounded-2xl border border-white/10 bg-white/[0.04] p-8 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.8)] backdrop-blur-xl sm:p-10">
          {children}
        </div>
      </main>

      <footer className="absolute inset-x-0 bottom-0 z-10 px-6 pb-6 text-center">
        <p className="text-xs text-white/40">
          © {new Date().getFullYear()} ALIGNED · Aligning Technology with Your Business
        </p>
      </footer>
    </div>
  );
}
