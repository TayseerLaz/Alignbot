'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginBodySchema, type LoginBody } from '@aligned/shared';
import { ArrowLeft, Eye, EyeOff, ShieldCheck } from 'lucide-react';
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

  // Stash the credentials between steps so we can re-POST with the TOTP
  // code attached. Kept in a ref (not state) so re-renders don't churn.
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

  // Step 1: credentials. On TOTP_REQUIRED, slide to step 2 instead of
  // showing an error toast — the password was right, we just need another
  // factor.
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

  // Step 2: re-submit with TOTP code (or 8-char recovery code).
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

  const inputClass =
    'w-full rounded-lg border border-white/[0.06] bg-[#19191c] px-3.5 py-2.5 text-sm text-white placeholder:text-white/30 outline-none transition focus:border-white/30 focus:bg-[#1c1c20]';

  return (
    <div className="flex flex-col">
      <div className="relative overflow-hidden">
        {step === 'credentials' ? (
          <div
            key="credentials"
            className="motion-safe:animate-[al-slide-in_300ms_ease-out]"
            style={{ animationName: 'al-slide-in-left' }}
          >
            <div className="text-center">
              <h1 className="text-3xl font-bold tracking-tight text-white">Sign in to Account</h1>
              <p className="mt-2 text-sm text-white/60">Enter your details to continue.</p>
            </div>

            <form onSubmit={onSubmitCredentials} className="mt-7 space-y-4">
              <Field label="Email" error={form.formState.errors.email?.message}>
                <input
                  type="email"
                  autoComplete="email"
                  placeholder="eg. johnfrans@gmail.com"
                  className={inputClass}
                  aria-invalid={!!form.formState.errors.email}
                  {...form.register('email')}
                />
              </Field>

              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <label htmlFor="password" className="block text-xs font-medium text-white/80">
                    Password
                  </label>
                  <Link
                    href="/forgot-password"
                    className="text-[11px] text-white/60 hover:text-white hover:underline"
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
                    className={`${inputClass} pr-10`}
                    aria-invalid={!!form.formState.errors.password}
                    {...form.register('password')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-white/50 hover:text-white"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                {form.formState.errors.password ? (
                  <p className="text-[11px] text-rose-300">
                    {form.formState.errors.password.message}
                  </p>
                ) : null}
              </div>

              <button
                type="submit"
                disabled={form.formState.isSubmitting}
                className="mt-2 w-full rounded-lg bg-white py-3 text-sm font-semibold text-black transition hover:bg-white/90 disabled:opacity-60"
              >
                {form.formState.isSubmitting ? 'Signing in…' : 'Sign In'}
              </button>
            </form>
          </div>
        ) : (
          <div
            key="totp"
            className="motion-safe:animate-[al-slide-in_300ms_ease-out]"
            style={{ animationName: 'al-slide-in-right' }}
          >
            <div className="text-center">
              <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-white/[0.08] ring-1 ring-white/10">
                <ShieldCheck className="size-5 text-white" />
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-white">Two-factor code</h1>
              <p className="mt-2 text-sm text-white/60">
                Open your authenticator app and enter the 6-digit code.
              </p>
              <p className="mt-1 text-xs text-white/40">
                Signing in as <span className="text-white/70">{stash.current?.email}</span>
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
                  <p className="text-center text-[11px] text-rose-300">{totpError}</p>
                ) : (
                  <p className="text-center text-[11px] text-white/40">
                    Lost your authenticator? Type an 8-character recovery code.
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={verifying || totpCode.trim().length < 6}
                className="mt-2 w-full rounded-lg bg-white py-3 text-sm font-semibold text-black transition hover:bg-white/90 disabled:opacity-60"
              >
                {verifying ? 'Verifying…' : 'Verify & continue'}
              </button>

              <button
                type="button"
                onClick={() => {
                  stash.current = null;
                  setTotpCode('');
                  setTotpError(null);
                  setStep('credentials');
                }}
                className="flex w-full items-center justify-center gap-1.5 text-xs text-white/60 transition hover:text-white"
              >
                <ArrowLeft className="size-3.5" /> Use a different account
              </button>
            </form>
          </div>
        )}
      </div>

      {/* Step-transition keyframes. Scoped to this page so they don't
          pollute global stylesheets. motion-reduce users get an instant
          swap (motion-safe: on the wrapper above). */}
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
      <label className="block text-xs font-medium text-white/80">{label}</label>
      {children}
      {error ? <p className="text-[11px] text-rose-300">{error}</p> : null}
    </div>
  );
}
