'use client';

import type { OrgRole } from '@aligned/shared';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { api, ApiError, clearAccessToken, setAccessToken, SESSION_EXPIRED_EVENT } from './api';

export interface SessionUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  isAlignedAdmin: boolean;
}

export interface SessionOrganization {
  id: string;
  slug: string;
  name: string;
  role: OrgRole;
}

export interface SessionState {
  user: SessionUser;
  organization: SessionOrganization;
  availableOrganizations: SessionOrganization[];
}

interface SessionContextValue {
  status: 'loading' | 'authenticated' | 'unauthenticated';
  session: SessionState | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  switchOrg: (organizationId: string) => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<SessionState | null>(null);
  const [status, setStatus] = useState<SessionContextValue['status']>('loading');
  const refreshInFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return refreshInFlight.current;
    refreshInFlight.current = (async () => {
      try {
        // Refresh access token from refresh cookie first.
        try {
          const tokenRes = await api.post<{ accessToken: string; expiresAt: string }>(
            '/api/v1/auth/refresh',
            undefined,
            { anonymous: true },
          );
          setAccessToken(tokenRes.accessToken, tokenRes.expiresAt);
        } catch {
          clearAccessToken();
          setSession(null);
          setStatus('unauthenticated');
          return;
        }
        // Now fetch session context.
        const data = await api.get<SessionState>('/api/v1/auth/session');
        setSession(data);
        setStatus('authenticated');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clearAccessToken();
          setSession(null);
          setStatus('unauthenticated');
          return;
        }
        throw err;
      } finally {
        refreshInFlight.current = null;
      }
    })();
    return refreshInFlight.current;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Listen for the SESSION_EXPIRED_EVENT emitted by api.ts when /auth/refresh
  // returns 401 from inside a non-session-manager code path (any polling
  // useQuery, the SSE helper, etc). Without this, those queries keep firing
  // every refetchInterval, each one hitting 401, producing an unbounded
  // refresh-loop in the browser console. Flipping status here triggers the
  // dashboard layout's existing redirect to /login.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => {
      clearAccessToken();
      setSession(null);
      setStatus('unauthenticated');
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, handler);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handler);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/api/v1/auth/logout');
    } finally {
      clearAccessToken();
      setSession(null);
      setStatus('unauthenticated');
      router.push('/login');
    }
  }, [router]);

  const switchOrg = useCallback(
    async (organizationId: string) => {
      const res = await api.post<{ accessToken: string; expiresAt: string }>(
        '/api/v1/auth/switch-org',
        { organizationId },
      );
      setAccessToken(res.accessToken, res.expiresAt);
      await refresh();
    },
    [refresh],
  );

  const value = useMemo<SessionContextValue>(
    () => ({ status, session, refresh, signOut, switchOrg }),
    [status, session, refresh, signOut, switchOrg],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
