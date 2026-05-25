'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginBodySchema, type LoginBody } from '@aligned/shared';
import { ArrowLeft, ArrowRight, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { api, ApiError, setAccessToken } from '@/lib/api';
import { useSession } from '@/lib/session';

type Step = 'credentials' | 'totp';

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const [showPassword, setShowPassword] = useState(false);
  const [step, setStep] = useState<Step>('credentials');

  const stash = useRef<{ email: string; password: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpError, setTotpError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const totpInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<LoginBody>({
    resolver: zodResolver(loginBodySchema),
    defaultValues: { email: '', password: '' },
  });

  useEffect(() => {
    if (step === 'totp') totpInputRef.current?.focus();
  }, [step]);

  const finishLogin = async (res: { accessToken: string; expiresAt: string }) => {
    setAccessToken(res.accessToken, res.expiresAt);
    await refresh();
    router.push('/dashboard');
  };

  const onSubmitCredentials = form.handleSubmit(async (values) => {
    try {
      const res = await api.post<{ accessToken: string; expiresAt: string }>(
        '/api/v1/auth/login',
        values,
        { anonymous: true },
      );
      await finishLogin(res);
    } catch (err) {
      if (err instanceof ApiError && err.payload.code === 'TOTP_REQUIRED') {
        stash.current = { email: values.email, password: values.password };
        setTotpCode('');
        setTotpError(null);
        setStep('totp');
        return;
      }
      if (err instanceof ApiError) toast.error(err.payload.message);
      else toast.error('Could not sign in. Please try again.');
    }
  });

  const onSubmitTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stash.current) {
      setStep('credentials');
      return;
    }
    const value = totpCode.trim();
    if (value.length < 6) {
      setTotpError('Enter your 6-digit code (or an 8-character recovery code).');
      return;
    }
    setVerifying(true);
    setTotpError(null);
    try {
      const res = await api.post<{ accessToken: string; expiresAt: string }>(
        '/api/v1/auth/login',
        { ...stash.current, totpCode: value },
        { anonymous: true },
      );
      stash.current = null;
      await finishLogin(res);
    } catch (err) {
      if (err instanceof ApiError && err.payload.code === 'TOTP_INVALID') {
        setTotpError('Invalid code. Try again — or use a recovery code.');
      } else if (err instanceof ApiError) {
        setTotpError(err.payload.message);
      } else {
        setTotpError('Could not verify the code. Please try again.');
      }
    } finally {
      setVerifying(false);
    }
  };

  // Marketing-site visual language: warm sand card, oxblood text + inputs,
  // Signal Red primary button. Tokens come from the portal theme so
  // light / dark switches still work — sand ramp lifts toward cream in
  // dark mode automatically.
  const inputClass =
    'w-full rounded-full border border-brand-500/15 bg-white/85 px-4 py-3 text-sm text-brand-500 placeholder:text-brand-500/40 outline-none transition focus:border-brand-500/40 focus:bg-white focus:ring-4 focus:ring-brand-500/10';

  return (
    <div className="flex flex-col">
      <div className="relative overflow-hidden">
        {step === 'credentials' ? (
          <div key="credentials" className="motion-safe:animate-[al-slide-in-left_300ms_ease-out]">
            {/* Mono kicker eyebrow — same shape as the marketing site. */}
            <p className="mb-3 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-brand-500/70">
              <span className="size-1.5 rounded-full bg-coral-500" />
              Login
            </p>
            <h1
              className="text-4xl font-extrabold leading-[0.95] tracking-[-0.035em] text-brand-500"
            >
              Sign in to your{' '}
              <span
                className="font-normal not-italic"
                style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}
              >
                workspace.
              </span>
            </h1>
            <p className="mt-3 text-sm text-brand-500/70">
              Enter your email and password to continue.
            </p>

            <form onSubmit={onSubmitCredentials} className="mt-8 space-y-4">
              <Field label="Email" error={form.formState.errors.email?.message}>
                <input
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  className={inputClass}
                  aria-invalid={!!form.formState.errors.email}
                  {...form.register('email')}
                />
              </Field>

              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between px-1">
                  <label htmlFor="password" className="text-xs font-semibold text-brand-500">
                    Password
                  </label>
                  <Link
                    href="/forgot-password"
                    className="text-[11px] font-medium text-brand-500/70 hover:text-coral-500"
                  >
                    Forgot password?
                  </Link>
                </div>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    className={`${inputClass} pr-12`}
                    aria-invalid={!!form.formState.errors.password}
                    {...form.register('password')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-brand-500/60 transition hover:text-brand-500"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                {form.formState.errors.password ? (
                  <p className="px-1 text-[11px] font-medium text-coral-600">
                    {form.formState.errors.password.message}
                  </p>
                ) : null}
              </div>

              <button
                type="submit"
                disabled={form.formState.isSubmitting}
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full bg-coral-500 px-6 py-3.5 text-sm font-semibold text-brand-500 shadow-coral transition hover:-translate-y-0.5 hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
              >
                {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
                {!form.formState.isSubmitting ? <ArrowRight className="size-4" /> : null}
              </button>
            </form>

            <p className="mt-7 text-center text-xs text-brand-500/70">
              New to Hader?{' '}
              <Link href="/signup" className="font-semibold text-brand-500 hover:text-coral-500">
                Create an account
              </Link>
            </p>
          </div>
        ) : (
          <div key="totp" className="motion-safe:animate-[al-slide-in-right_300ms_ease-out]">
            <div className="text-center">
              <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-coral-500/15 ring-1 ring-coral-500/30">
                <ShieldCheck className="size-5 text-coral-500" />
              </div>
              <p className="mb-2 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-brand-500/70">
                <span className="size-1.5 rounded-full bg-coral-500" />
                Two-factor
              </p>
              <h1 className="text-3xl font-extrabold leading-tight tracking-[-0.03em] text-brand-500">
                Verify it's{' '}
                <span
                  className="font-normal not-italic"
                  style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}
                >
                  you.
                </span>
              </h1>
              <p className="mt-3 text-sm text-brand-500/70">
                Open your authenticator app and enter the 6-digit code.
              </p>
              <p className="mt-1 text-xs text-brand-500/55">
                Signing in as <span className="font-medium text-brand-500">{stash.current?.email}</span>
              </p>
            </div>

            <form onSubmit={onSubmitTotp} className="mt-7 space-y-4">
              <div className="space-y-1.5">
                <input
                  ref={totpInputRef}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={20}
                  placeholder="000000"
                  value={totpCode}
                  onChange={(e) => {
                    setTotpCode(e.target.value);
                    setTotpError(null);
                  }}
                  className={`${inputClass} text-center font-mono text-lg tracking-[0.6em]`}
                  aria-invalid={!!totpError}
                />
                {totpError ? (
                  <p className="text-center text-[11px] font-medium text-coral-600">{totpError}</p>
                ) : (
                  <p className="text-center text-[11px] text-brand-500/55">
                    Lost your authenticator? Type an 8-character recovery code.
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={verifying || totpCode.trim().length < 6}
                className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-coral-500 px-6 py-3.5 text-sm font-semibold text-brand-500 shadow-coral transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
              >
                {verifying ? 'Verifying…' : 'Verify & continue'}
                {!verifying ? <ArrowRight className="size-4" /> : null}
              </button>

              <button
                type="button"
                onClick={() => {
                  stash.current = null;
                  setTotpCode('');
                  setTotpError(null);
                  setStep('credentials');
                }}
                className="flex w-full items-center justify-center gap-1.5 text-xs font-medium text-brand-500/70 transition hover:text-coral-500"
              >
                <ArrowLeft className="size-3.5" /> Use a different account
              </button>
            </form>
          </div>
        )}
      </div>

      <style jsx global>{`
        @keyframes al-slide-in-left {
          from { opacity: 0; transform: translateX(-12px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes al-slide-in-right {
          from { opacity: 0; transform: translateX(12px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block px-1 text-xs font-semibold text-brand-500">{label}</label>
      {children}
      {error ? <p className="px-1 text-[11px] font-medium text-coral-600">{error}</p> : null}
    </div>
  );
}
