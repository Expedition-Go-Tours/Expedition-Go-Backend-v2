import { Suspense, lazy } from "react";
import { Route, Routes } from "react-router-dom";

import { ALL_ADMIN_ROLES, ADMIN_ROLES } from "@/lib/rbac";
import ErrorBoundary from "@/components/ErrorBoundary";
import DashboardLayout from "@/layouts/DashboardLayout";
import ForbiddenPage from "@/pages/admin/ForbiddenPage";
import { RequireAuth, RequireRole } from "@/routes/guards";

const OverviewPage = lazy(() => import("@/pages/admin/OverviewPage"));
const UsersPage = lazy(() => import("@/pages/admin/UsersPage"));
const BookingsPage = lazy(() => import("@/pages/admin/BookingsPage"));
const AnalyticsPage = lazy(() => import("@/pages/admin/AnalyticsPage"));
const SettingsPage = lazy(() => import("@/pages/admin/SettingsPage"));
const CreateTourPage = lazy(() => import("@/pages/admin/CreateTourPage"));

function AdminFallback() {
  return (
    <div className="grid gap-3">
      <div className="h-10 w-44 animate-pulse rounded-lg bg-[color:var(--admin-border-soft)]" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl bg-[color:var(--admin-border-soft)]" />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-2xl bg-[color:var(--admin-border-soft)]" />
    </div>
  );
}

export default function AdminRoutes() {
  return (
    <RequireAuth>
      <RequireRole roles={ALL_ADMIN_ROLES}>
        <ErrorBoundary>
          <Routes>
            <Route element={<DashboardLayout />}>
              <Route
                index
                element={
                  <Suspense fallback={<AdminFallback />}>
                    <OverviewPage />
                  </Suspense>
                }
              />
              <Route
                path="users"
                element={
                  <Suspense fallback={<AdminFallback />}>
                    <RequireRole roles={[ADMIN_ROLES.ADMIN, ADMIN_ROLES.MANAGER]}>
                      <UsersPage />
                    </RequireRole>
                  </Suspense>
                }
              />
              <Route
                path="bookings"
                element={
                  <Suspense fallback={<AdminFallback />}>
                    <BookingsPage />
                  </Suspense>
                }
              />
              <Route
                path="analytics"
                element={
                  <Suspense fallback={<AdminFallback />}>
                    <AnalyticsPage />
                  </Suspense>
                }
              />
              <Route
                path="settings"
                element={
                  <Suspense fallback={<AdminFallback />}>
                    <SettingsPage />
                  </Suspense>
                }
              />
              <Route
                path="tours/new"
                element={
                  <Suspense fallback={<AdminFallback />}>
                    <RequireRole roles={[ADMIN_ROLES.ADMIN, ADMIN_ROLES.MANAGER]}>
                      <CreateTourPage />
                    </RequireRole>
                  </Suspense>
                }
              />
              <Route path="forbidden" element={<ForbiddenPage />} />
            </Route>
          </Routes>
        </ErrorBoundary>
      </RequireRole>
    </RequireAuth>
  );
}
