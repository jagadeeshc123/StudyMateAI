import { Fragment } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, loading, error } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-background to-muted/30">
        <p className="text-sm text-muted-foreground" role="status">Restoring your session...</p>
      </div>
    );
  }

  if (error && !user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location, sessionError: error }}
      />
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <Fragment key={user.id}>{children}</Fragment>;
};

export default ProtectedRoute;
