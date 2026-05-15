import Image from 'next/image';
import { Outfit } from 'next/font/google';

const outfit = Outfit({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
});

// Full-page two-column auth shell. Left = animated blue lava-lamp
// panel (6 drifting blobs merged via SVG goo filter) with Alignbot
// pitch + chips. Right = dark form area (children).
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <GooFilter />
      <BlobKeyframes />
      <div
        className={`${outfit.className} fixed inset-0 grid overflow-hidden bg-[#0a0a0c] text-white lg:grid-cols-2`}
      >
        <BrandPanel />
        <section className="flex h-full flex-col justify-center overflow-hidden px-6 py-10 sm:px-12 lg:px-16">
          <div className="mx-auto w-full max-w-sm">
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
    </>
  );
}

function BrandPanel() {
  const features = [
    { n: 1, label: 'AI WhatsApp\nchatbot' },
    { n: 2, label: 'Synced catalog\n& FAQs' },
    { n: 3, label: 'Bookings captured\nautomatically' },
  ];
  return (
    <aside
      className="relative hidden flex-col overflow-hidden p-12 lg:flex"
      style={{
        background:
          'radial-gradient(ellipse 90% 70% at 55% 50%, #1F4A78 0%, #0E2747 45%, #061224 100%)',
      }}
    >
      {/* Lava blobs — merged into one organic shape by the SVG goo
          filter. Each blob has a unique drift keyframe so the whole
          mass writhes slowly. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0"
        style={{ filter: 'url(#aligned-goo) blur(0.2px)' }}
      >
        <Blob className="aligned-blob-1" />
        <Blob className="aligned-blob-2" />
        <Blob className="aligned-blob-3" />
        <Blob className="aligned-blob-4" />
        <Blob className="aligned-blob-5" />
        <Blob className="aligned-blob-6" />
      </div>

      {/* Inner light overlay above blobs but below content. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[1]"
        style={{
          background:
            'radial-gradient(ellipse 70% 50% at 50% 45%, rgba(143,196,240,0.18) 0%, transparent 60%), linear-gradient(180deg, rgba(6,18,36,0) 0%, rgba(6,18,36,0.4) 100%)',
        }}
      />
      {/* Grain texture for premium feel. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[2] opacity-[0.08] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.7 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")",
        }}
      />

      {/* Content layer — z-3, above everything. */}
      <div className="relative z-[3] flex h-full flex-col">
        <Image
          src="/aligned-logo.webp"
          alt="ALIGNED"
          width={200}
          height={40}
          priority
        />

        <div className="mt-auto">
          <h2 className="mb-7 text-5xl font-semibold leading-[1.05] tracking-tight text-white">
            One inbox for
            <br />
            <span className="text-white">every Business</span>
          </h2>

          <ul className="grid grid-cols-3 gap-2.5">
            {features.map((f) => (
              <li
                key={f.n}
                className={
                  f.active
                    ? 'flex min-h-[108px] flex-col justify-between rounded-xl border border-white bg-white p-3 text-[#0E2747] shadow-[0_20px_50px_-10px_rgba(8,20,40,0.5),0_0_0_1px_rgba(255,255,255,0.4)] transition'
                    : 'flex min-h-[108px] flex-col justify-between rounded-xl border border-[rgba(143,196,240,0.12)] bg-[rgba(8,20,40,0.55)] p-3 text-white/75 backdrop-blur-md transition hover:-translate-y-0.5 hover:border-[rgba(143,196,240,0.3)]'
                }
              >
                <span
                  className={
                    f.active
                      ? 'flex size-6 items-center justify-center rounded-full bg-[#0E2747] text-[11px] font-semibold text-white'
                      : 'flex size-6 items-center justify-center rounded-full bg-white/10 text-[11px] font-semibold text-white/85'
                  }
                >
                  {f.n}
                </span>
                <span
                  className={
                    f.active
                      ? 'whitespace-pre-line text-[12.5px] font-semibold leading-tight'
                      : 'whitespace-pre-line text-[12.5px] font-medium leading-tight text-white/85'
                  }
                >
                  {f.label}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </aside>
  );
}

function Blob({ className }: { className: string }) {
  return <div aria-hidden className={`${className} absolute rounded-full mix-blend-screen will-change-transform`} />;
}

// SVG goo filter — Gaussian blur + a high-contrast color matrix that
// merges the alpha edges of nearby blobs into one organic blob, the
// classic "metaball" lava-lamp effect.
function GooFilter() {
  return (
    <svg
      width="0"
      height="0"
      style={{ position: 'absolute' }}
      aria-hidden
    >
      <defs>
        <filter id="aligned-goo">
          <feGaussianBlur in="SourceGraphic" stdDeviation="22" result="blur" />
          <feColorMatrix
            in="blur"
            mode="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10"
            result="goo"
          />
          <feBlend in="SourceGraphic" in2="goo" />
        </filter>
      </defs>
    </svg>
  );
}

// Inline keyframes + per-blob sizing/positioning/animation. Kept in
// one block so the lava lamp lives entirely in this file.
function BlobKeyframes() {
  return (
    <style>{`
      .aligned-blob-1 { width: 380px; height: 380px; top: 8%; left: 18%;
        background: radial-gradient(circle at 35% 30%, #8FC4F0, #3D86C5 50%, transparent 70%);
        animation: aligned-drift-1 24s ease-in-out infinite; }
      .aligned-blob-2 { width: 320px; height: 320px; top: 38%; left: 48%;
        background: radial-gradient(circle at 40% 35%, #5DA4E2, #1F4A78 55%, transparent 75%);
        animation: aligned-drift-2 30s ease-in-out infinite; }
      .aligned-blob-3 { width: 280px; height: 280px; top: 58%; left: 8%;
        background: radial-gradient(circle at 50% 40%, #8FC4F0, #3D86C5 60%, transparent 78%);
        animation: aligned-drift-3 28s ease-in-out infinite; }
      .aligned-blob-4 { width: 240px; height: 240px; top: 22%; left: 58%;
        background: radial-gradient(circle at 45% 35%, #5DA4E2, #1F4A78 60%, transparent 80%);
        animation: aligned-drift-4 26s ease-in-out infinite; }
      .aligned-blob-5 { width: 200px; height: 200px; top: 70%; left: 50%;
        background: radial-gradient(circle at 50% 40%, #8FC4F0, #3D86C5 55%, transparent 78%);
        animation: aligned-drift-5 32s ease-in-out infinite; }
      .aligned-blob-6 { width: 160px; height: 160px; top: 4%; left: 62%; opacity: 0.85;
        background: radial-gradient(circle at 50% 40%, #BEE3FF, #5DA4E2 50%, transparent 75%);
        animation: aligned-drift-6 22s ease-in-out infinite; }

      @keyframes aligned-drift-1 {
        0%   { transform: translate(0, 0) scale(1); }
        25%  { transform: translate(40px, 80px) scale(1.08); }
        50%  { transform: translate(-30px, 140px) scale(0.95); }
        75%  { transform: translate(-90px, 40px) scale(1.1); }
        100% { transform: translate(0, 0) scale(1); }
      }
      @keyframes aligned-drift-2 {
        0%   { transform: translate(0, 0) scale(1); }
        33%  { transform: translate(-80px, -100px) scale(1.15); }
        66%  { transform: translate(60px, -40px) scale(0.92); }
        100% { transform: translate(0, 0) scale(1); }
      }
      @keyframes aligned-drift-3 {
        0%   { transform: translate(0, 0) scale(1); }
        25%  { transform: translate(100px, -60px) scale(0.9); }
        50%  { transform: translate(160px, 30px) scale(1.12); }
        75%  { transform: translate(50px, -50px) scale(1); }
        100% { transform: translate(0, 0) scale(1); }
      }
      @keyframes aligned-drift-4 {
        0%   { transform: translate(0, 0) scale(1); }
        50%  { transform: translate(-120px, 90px) scale(1.18); }
        100% { transform: translate(0, 0) scale(1); }
      }
      @keyframes aligned-drift-5 {
        0%   { transform: translate(0, 0) scale(1); }
        30%  { transform: translate(-70px, -120px) scale(1.08); }
        60%  { transform: translate(80px, -180px) scale(0.95); }
        100% { transform: translate(0, 0) scale(1); }
      }
      @keyframes aligned-drift-6 {
        0%   { transform: translate(0, 0) scale(1); }
        40%  { transform: translate(-180px, 120px) scale(1.2); }
        70%  { transform: translate(-60px, 220px) scale(0.85); }
        100% { transform: translate(0, 0) scale(1); }
      }
    `}</style>
  );
}
