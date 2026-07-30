import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import type { Location } from "react-router-dom";
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";

interface LoginLocationState {
  from?: Location;
  sessionError?: string;
}

const AUTHENTICATED_DESTINATIONS = new Set([
  "/upload",
  "/documents",
  "/chat",
  "/history",
]);

function safePostLoginDestination(state: LoginLocationState | null): string {
  const pathname = state?.from?.pathname;

  if (!pathname || !AUTHENTICATED_DESTINATIONS.has(pathname)) {
    return "/upload";
  }

  return `${pathname}${state.from?.search ?? ""}${state.from?.hash ?? ""}`;
}

const Login = () => {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { user, loading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as LoginLocationState | null;
  const destination = safePostLoginDestination(state);

  useEffect(() => {
    if (state?.sessionError) setFormError(state.sessionError);
  }, [state?.sessionError]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-background to-muted/30">
        <p className="text-sm text-muted-foreground" role="status">Restoring your session...</p>
      </div>
    );
  }

  if (user) {
    return <Navigate to={destination} replace />;
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setNotice(null);

    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
        if (error) throw error;

        if (!data.session) {
          setNotice("Account created. Check your email to confirm your address, then log in.");
          setMode("login");
          return;
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
      }

      navigate(destination, { replace: true });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Authentication failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <Navbar />
      <div className="container px-4 py-12">
        <Card className="mx-auto max-w-md border-2">
          <CardHeader>
            <CardTitle>{mode === "login" ? "Log in to StudyMate" : "Create your StudyMate account"}</CardTitle>
            <CardDescription>
              {mode === "login"
                ? "Access your private documents and saved chats."
                : "Your documents and chats will be private to this account."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  disabled={submitting}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  minLength={6}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  disabled={submitting}
                />
              </div>
              {formError && <p className="text-sm text-destructive" role="alert">{formError}</p>}
              {notice && <p className="text-sm text-muted-foreground" role="status">{notice}</p>}
              <Button type="submit" variant="hero" className="w-full" disabled={submitting}>
                {submitting ? "Please wait..." : mode === "login" ? "Log in" : "Sign up"}
              </Button>
            </form>
            <Button
              type="button"
              variant="ghost"
              className="mt-3 w-full"
              disabled={submitting}
              onClick={() => {
                setMode((current) => current === "login" ? "signup" : "login");
                setFormError(null);
                setNotice(null);
              }}
            >
              {mode === "login" ? "Need an account? Sign up" : "Already have an account? Log in"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Login;
