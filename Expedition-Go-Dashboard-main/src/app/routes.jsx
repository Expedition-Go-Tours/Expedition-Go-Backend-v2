import { Routes, Route } from "react-router-dom";
import AppShell from "@/components/layout/AppShell";

// Pages
import DashboardPage from "@/features/dashboard/pages/DashboardPage";
import BookingsPage from "@/features/bookings/pages/BookingsPage";
import ProductsListPage from "@/features/products/pages/ProductsListPage";
import ProductBuilderPage from "@/features/products/pages/ProductBuilderPage";
import AvailabilityPage from "@/features/availability/pages/AvailabilityPage";
import PerformancePage from "@/features/performance/pages/PerformancePage";
import ReviewsPage from "@/features/reviews/pages/ReviewsPage";
import FinancePage from "@/features/finance/pages/FinancePage";
import NotificationsPage from "@/features/notifications/pages/NotificationsPage";
import UsersPage from "@/features/users/pages/UsersPage";
import SettingsPage from "@/features/settings/pages/SettingsPage";

// Auth Pages (rendered outside AppShell)
import AuthCallback from "@/features/auth/pages/AuthCallback";

// Error Pages
import NotFoundPage from "@/pages/errors/NotFoundPage";
import ServerErrorPage from "@/pages/errors/ServerErrorPage";
import ForbiddenPage from "@/pages/errors/ForbiddenPage";
import NetworkErrorPage from "@/pages/errors/NetworkErrorPage";

export default function AppRoutes() {
  return (
    <Routes>
      {/* Auth Callback (without AppShell — full-screen auth bridge) */}
      <Route path="/auth/callback" element={<AuthCallback />} />

      {/* Error Pages (without AppShell) */}
      <Route path="/error/404" element={<NotFoundPage />} />
      <Route path="/error/500" element={<ServerErrorPage />} />
      <Route path="/error/403" element={<ForbiddenPage />} />
      <Route path="/error/network" element={<NetworkErrorPage />} />

      {/* Main App Routes (with AppShell) */}
      <Route element={<AppShell />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/bookings" element={<BookingsPage />} />
        <Route path="/products" element={<ProductsListPage />} />
        <Route path="/products/build/:id?/:step?" element={<ProductBuilderPage />} />
        <Route path="/availability" element={<AvailabilityPage />} />
        <Route path="/performance" element={<PerformancePage />} />
        <Route path="/reviews" element={<ReviewsPage />} />
        <Route path="/finance" element={<FinancePage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        
        {/* Catch-all route for 404 */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
