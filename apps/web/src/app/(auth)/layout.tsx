import Link from 'next/link';

// Golden-Suisse style two-column dark login layout. Left column is the
// brand canvas: wordmark top-left, faint full-bleed crosshair, an
// 8-point starburst centred, copyright bottom-left. Right column is
// the form, in a marginally lighter charcoal so the seam reads.
// On mobile the left panel collapses; only the form stays.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-black text-white lg:grid-cols-2">
      {/* LEFT — brand canvas */}
      <aside className="relative hidden overflow-hidden bg-black lg:block">
        {/* Faint crosshair guide lines through the centre. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/[0.06]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/[0.06]"
        />

        {/* Brand wordmark — top-left. */}
        <div className="absolute left-10 top-10 text-sm tracking-tight">
          <span className="font-semibold">ALIGNED</span>
          <sup className="ml-0.5 text-[10px] text-white/70">®</sup>
        </div>

        {/* Centred 8-point starburst. Pure SVG so it stays crisp. */}
        <div className="absolute inset-0 flex items-center justify-center">
          <Starburst className="size-40 text-white" />
        </div>

        {/* Copyright — bottom-left. */}
        <p className="absolute bottom-8 left-10 text-[11px] tracking-wide text-white/40">
          © ALIGNED {new Date().getFullYear()}. All rights reserved.
        </p>
      </aside>

      {/* RIGHT — form column */}
      <section className="relative flex min-h-dvh flex-col bg-[#0d0d0f] px-8 py-10 sm:px-16 lg:px-20">
        {/* Mobile-only brand wordmark since the left panel is hidden. */}
        <div className="mb-10 text-sm tracking-tight lg:hidden">
          <span className="font-semibold">ALIGNED</span>
          <sup className="ml-0.5 text-[10px] text-white/70">®</sup>
        </div>
        <div className="flex justify-end">
          <Link
            href="/signup"
            className="text-xs text-white/70 hover:text-white hover:underline focus-visible:underline"
          >
            Create an account
          </Link>
        </div>
        <div className="mt-16 flex flex-1 flex-col sm:mt-24">{children}</div>
      </section>
    </div>
  );
}

function Starburst({ className }: { className?: string }) {
  // 8 lines: 4 cardinal (long) + 4 diagonals (slightly shorter) to
  // match the reference's slight visual hierarchy.
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden>
      {/* cardinals */}
      <line x1="50" y1="10" x2="50" y2="90" stroke="currentColor" strokeWidth="2.6" />
      <line x1="10" y1="50" x2="90" y2="50" stroke="currentColor" strokeWidth="2.6" />
      {/* diagonals — slightly shorter for the 8-point look */}
      <line x1="22" y1="22" x2="78" y2="78" stroke="currentColor" strokeWidth="2.2" />
      <line x1="78" y1="22" x2="22" y2="78" stroke="currentColor" strokeWidth="2.2" />
    </svg>
  );
}
