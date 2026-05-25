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

// Shared input styles. White input on a Desert Sand page surface, so the
// field reads as the active element. Border picks up the brand on focus
// with a soft 2px ring.
const INPUT =
  'w-full rounded-lg border border-brand-500/15 bg-white px-4 py-3 text-[15px] text-brand-500 placeholder:text-brand-500/35 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15';

const PRIMARY_BTN =
  'w-full rounded-lg bg-brand-500 px-6 py-3 text-[15px] font-semibold text-white transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60';

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

  if (step === 'credentials') {
    return (
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-brand-500">
          Welcome back
        </h1>
        <p className="mt-2 text-sm text-brand-500/75">
          Sign in to continue to your Hader workspace.
        </p>

        <form onSubmit={onSubmitCredentials} className="mt-8 space-y-4">
          <Field label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
            <input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              className={INPUT}
              aria-invalid={!!form.formState.errors.email}
              {...form.register('email')}
            />
          </Field>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <label htmlFor="password" className="text-sm font-medium text-brand-500">
                Password
              </label>
              <Link
                href="/forgot-password"
                className="text-xs font-medium text-brand-500 hover:underline"
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
                className={`${INPUT} pr-12`}
                aria-invalid={!!form.formState.errors.password}
                {...form.register('password')}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-brand-500/50 transition hover:text-brand-500"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {form.formState.errors.password ? (
              <p className="text-xs font-medium text-red-600">
                {form.formState.errors.password.message}
              </p>
            ) : null}
          </div>

          <button
            type="submit"
            disabled={form.formState.isSubmitting}
            className={`${PRIMARY_BTN} mt-2`}
          >
            {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-8 text-center text-sm text-brand-500/75">
          New to Hader?{' '}
          <Link href="/signup" className="font-semibold text-brand-500 hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    );
  }

  // Two-factor step.
  return (
    <div>
      <div className="mb-6 flex size-12 items-center justify-center rounded-full bg-brand-500/10">
        <ShieldCheck className="size-5 text-brand-500" />
      </div>
      <h1 className="text-3xl font-semibold tracking-tight text-brand-500">
        Two-factor code
      </h1>
      <p className="mt-2 text-sm text-brand-500/75">
        Open your authenticator app and enter the 6-digit code.
      </p>
      <p className="mt-1 text-xs text-brand-500/60">
        Signing in as <span className="font-medium text-brand-500">{stash.current?.email}</span>
      </p>

      <form onSubmit={onSubmitTotp} className="mt-8 space-y-4">
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
          className={`${INPUT} text-center font-mono text-lg tracking-[0.5em]`}
          aria-invalid={!!totpError}
        />
        {totpError ? (
          <p className="text-center text-xs font-medium text-red-600">{totpError}</p>
        ) : (
          <p className="text-center text-xs text-brand-500/60">
            Lost your authenticator? Type an 8-character recovery code.
          </p>
        )}

        <button
          type="submit"
          disabled={verifying || totpCode.trim().length < 6}
          className={PRIMARY_BTN}
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
          className="flex w-full items-center justify-center gap-1.5 text-sm text-brand-500/75 transition hover:text-brand-500"
        >
          <ArrowLeft className="size-3.5" /> Use a different account
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-brand-500">
        {label}
      </label>
      {children}
      {error ? <p className="text-xs font-medium text-red-600">{error}</p> : null}
    </div>
  );
}
