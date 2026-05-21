import { Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";

import { AuthProvider } from "@/components/auth/AuthProvider";
import { useAuth } from "@/components/auth/AuthProvider";
import BrandLoader from "@/components/ui/BrandLoader";
import ErrorBoundary from "@/components/ErrorBoundary";
import { WishlistProvider } from "@/contexts/WishlistContext";
import { CurrencyProvider } from "@/contexts/CurrencyContext";
import { CartProvider } from "@/contexts/CartContext";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";
import HomePage from "@/pages/HomePage";
import AllToursPage from "@/pages/AllToursPage";
import WishlistPage from "@/pages/WishlistPage";
import CartPage from "@/pages/CartPage";
import TourDetailPage from "@/pages/TourDetailPage";
import RegisterPage from "@/pages/RegisterPage";
import SignInPage from "@/pages/SignInPage";
import SignOutPage from "@/pages/SignOutPage";
import SupportPage from "@/pages/SupportPage";
import SettingsPage from "@/pages/SettingsPage";
import BookingPage from "@/pages/BookingPage";

function AppContent() {
  useScrollRestoration();
  const { loading } = useAuth();

  if (loading) {
    return <BrandLoader fullScreen label="Loading application" />;
  }

  return (
    <CurrencyProvider>
      <WishlistProvider>
        <CartProvider>
          <Toaster
            position="top-right"
            toastOptions={{
              duration: 1400,
              style: {
                background: "var(--brand-mist)",
                color: "var(--brand-green)",
                border: "1px solid rgba(9, 106, 79, 0.18)",
              },
            }}
          />
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/tours" element={<AllToursPage />} />
            <Route path="/tour/:id" element={<TourDetailPage />} />
            <Route path="/wishlist" element={<WishlistPage />} />
            <Route path="/cart" element={<CartPage />} />
            <Route path="/signin" element={<SignInPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/signout" element={<SignOutPage />} />
            <Route path="/support" element={<SupportPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/booking" element={<BookingPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </CartProvider>
      </WishlistProvider>
    </CurrencyProvider>
  );
}

function App() {
  return (
    <ErrorBoundary goHomeLink="/" goHomeLabel="Go Home">
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
