import { Navigate, useLocation } from "react-router-dom";

import { useAuth } from "@/components/auth/AuthProvider";
import { userHasRole } from "@/lib/rbac";

function FullPageLoader({ label = "Loading..." }) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="flex items-center gap-3 text-sm font-medium text-slate-500">
        <span className="size-3 animate-pulse rounded-full bg-emerald-500" />
        {label}
      </div>
    </div>
  );
}

export function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageLoader label="Authorising session..." />;

  if (!user) {
    const redirect = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/signin?redirect=${encodeURIComponent(redirect)}`} replace />;
  }

  return children;
}

export function RequireRole({ roles, children, fallback }) {
  const { user, loading } = useAuth();

  if (loading) return <FullPageLoader label="Verifying access..." />;
  if (!user) return <Navigate to="/signin" replace />;

  if (!userHasRole(user, roles)) {
    if (fallback) return fallback;
    return <Navigate to="/admin/forbidden" replace />;
  }

  return children;
}
