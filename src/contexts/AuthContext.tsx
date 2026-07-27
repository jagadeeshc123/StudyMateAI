import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { clearAllActiveBatches } from "@/integrations/supabase/active-batch";

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  error: string | null;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // `undefined` means the initial session has not been resolved yet. Preserve
  // that user's session-scoped active batch on refresh, but clear it for every
  // real transition between signed-out/signed-in users.
  const currentUserId = useRef<string | null | undefined>(undefined);
  const queryClient = useQueryClient();

  useEffect(() => {
    let isActive = true;

    const restoreSession = async () => {
      const { data, error: sessionError } = await supabase.auth.getSession();

      if (!isActive) return;

      if (sessionError) {
        queryClient.clear();
        clearAllActiveBatches();
        currentUserId.current = null;
        setSession(null);
        setError(`Could not restore your session: ${sessionError.message}`);
      } else {
        const nextUserId = data.session?.user.id ?? null;
        queryClient.clear();
        if (currentUserId.current !== undefined && currentUserId.current !== nextUserId) {
          clearAllActiveBatches();
        }
        currentUserId.current = nextUserId;
        setSession(data.session);
        setError(null);
      }

      setLoading(false);
    };

    void restoreSession();

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!isActive) return;
      const nextUserId = nextSession?.user.id ?? null;
      queryClient.clear();
      if (currentUserId.current !== undefined && currentUserId.current !== nextUserId) {
        clearAllActiveBatches();
      }
      currentUserId.current = nextUserId;
      setSession(nextSession);
      setError(null);
      setLoading(false);
    });

    return () => {
      isActive = false;
      subscription.subscription.unsubscribe();
    };
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(() => ({
    session,
    user: session?.user ?? null,
    loading,
    error,
    signOut: async () => {
      setError(null);
      queryClient.clear();
      clearAllActiveBatches();
      currentUserId.current = null;
      setSession(null);
      const { error: signOutError } = await supabase.auth.signOut();

      if (signOutError) {
        setError(`Could not log out: ${signOutError.message}`);
        const { data } = await supabase.auth.getSession();
        currentUserId.current = data.session?.user.id ?? null;
        setSession(data.session);
        throw signOutError;
      }
    },
  }), [error, loading, queryClient, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// AuthProvider and its colocated hook intentionally share one module.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider.");
  }

  return context;
}
