import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { DestinationsSection } from "@/components/homepage/DestinationsSection";
import { Footer } from "@/components/homepage/Footer";
import { HeroSection } from "@/components/homepage/HeroSection";
import { Navbar } from "@/components/homepage/Navbar";
import { SidebarPanel } from "@/components/homepage/SidebarPanel";
import { TourCarouselSection } from "@/components/homepage/TourCarouselSection";
import { NewsletterSection } from "@/components/homepage/NewsletterSection";
import { FeaturesSection } from "@/components/homepage/FeaturesSection";
import { ReviewsCarousel } from "@/components/homepage/ReviewsCarousel";
import { SupplierSection } from "@/components/homepage/SupplierSection";
import { ExploreMoreSection } from "@/components/homepage/ExploreMoreSection";
import { HomePageSkeleton } from "@/components/homepage/skeletons/HomePageSkeleton";
import BrandLoader from "@/components/ui/BrandLoader";
import { leisureTours, pickupTours, recommendedTours, topRatedTours } from "@/components/homepage/data";
import { AuthModalProvider } from "@/contexts/AuthModalContext";
import { RecentlyViewedProvider } from "@/contexts/RecentlyViewedContext";
import { AuthModal } from "@/components/ui/auth-modal";
import { useAuthModal } from "@/contexts/AuthModalContext";
import { useHomePageData } from "@/hooks/useHomePageData";

/** Post–sign-in/register handoff: show brand splash, stay under ~1200ms. */
const POST_AUTH_SPLASH_MS = 1120;

function HomePageContent() {
  const location = useLocation();
  const navigate = useNavigate();
  const { isAuthModalOpen, closeAuthModal } = useAuthModal();
  const { t } = useTranslation();
  const [skipInitialHomeDelay] = useState(() =>
    Boolean(location.state?.skipHomeSkeletonDelay || location.state?.showQuickHomeSkeleton),
  );
  const [showPostAuthSplash] = useState(() => Boolean(location.state?.postAuthSplash));
  const [authHandoffId] = useState(() =>
    typeof location.state?.handoffId === "number" && Number.isFinite(location.state.handoffId)
      ? location.state.handoffId
      : null,
  );
  const [splashKind] = useState(() => location.state?.splashKind ?? "signin");
  const [splashVisible, setSplashVisible] = useState(() => Boolean(location.state?.postAuthSplash));
  /** Home fetch waits until splash ends so skeleton can run after splash (not during). */
  const homeDataEnabled = !showPostAuthSplash || !splashVisible;
  const homeLoad = useHomePageData({
    skipInitialDelay: skipInitialHomeDelay,
    enabled: homeDataEnabled,
    handoffNonce: authHandoffId,
    postAuthHandoff: authHandoffId != null,
  });
  /** Use fetchStatus + fresh handoff nonce so skeleton does not disappear when TanStack skips isLoading during cache quirks. */
  const homeReady =
    homeDataEnabled &&
    Boolean(homeLoad.data?.loaded) &&
    homeLoad.fetchStatus !== "fetching";
  const showLogoutToast = Boolean(location.state?.showLogoutToast);
  const [sharedHeroDateRange, setSharedHeroDateRange] = useState({ from: null, to: null });
  const [sharedSearchQuery, setSharedSearchQuery] = useState("");
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [showCompactSearch, setShowCompactSearch] = useState(false);

  useEffect(() => {
    if (!showPostAuthSplash) {
      return;
    }
    const id = window.setTimeout(() => setSplashVisible(false), POST_AUTH_SPLASH_MS);
    return () => window.clearTimeout(id);
  }, [showPostAuthSplash]);

  useEffect(() => {
    if (!location.state?.skipHomeSkeletonDelay && !location.state?.postAuthSplash) {
      return;
    }

    navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
  }, [
    location.state?.skipHomeSkeletonDelay,
    location.state?.postAuthSplash,
    navigate,
    location.pathname,
    location.search,
    location.hash,
  ]);

  const authSplashBlocking = showPostAuthSplash && splashVisible;

  useEffect(() => {
    if (!showLogoutToast || !homeReady || authSplashBlocking) {
      return;
    }

    toast.success("successfully logged out", {
      id: "logout-success-toast",
      position: "top-center",
      duration: 3500,
    });
    navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
  }, [
    showLogoutToast,
    homeReady,
    authSplashBlocking,
    navigate,
    location.pathname,
    location.search,
    location.hash,
  ]);

  useEffect(() => {
    let ticking = false;
    
    const handleScroll = () => {
      const scrollY = window.scrollY;
      const shouldShow = scrollY > 480;
      setShowScrollTop((prev) => prev !== shouldShow ? shouldShow : prev);
    };

    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          handleScroll();
          ticking = false;
        });
        ticking = true;
      }
    };

    handleScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (showPostAuthSplash && splashVisible) {
    const splashLabel =
      splashKind === "register" ? t("auth.successAccountCreated") : t("auth.successWelcomeBack");
    return (
      <div
        className="fixed inset-0 z-[120] flex cursor-pointer flex-col items-center justify-center bg-white"
        onClick={() => setSplashVisible(false)}
      >
        <BrandLoader fullScreen={false} splash label={splashLabel} />
        <p className="mt-6 text-xs font-medium tracking-wide text-slate-400 uppercase">
          Tap anywhere to skip
        </p>
      </div>
    );
  }

  if (!homeReady) {
    return <HomePageSkeleton />;
  }

  return (
    <>
      <div className="min-h-screen bg-[color:var(--page-bg)] text-slate-900 overflow-x-hidden">
        <Navbar
          sharedDateRange={sharedHeroDateRange}
          onSharedDateRangeChange={setSharedHeroDateRange}
          forceShowCompactSearch={showCompactSearch}
          externalSearchQuery={sharedSearchQuery}
          onExternalSearchChange={setSharedSearchQuery}
        />
        {/* Navbar spacer - only on desktop where search moves to navbar */}
        <div className={`hidden lg:block lg:h-[104px]`} />
        {/* Mobile spacer - for fixed search bar at top */}
        <div className={`lg:hidden ${showCompactSearch ? 'h-[52px]' : 'h-0'}`} />
        <HeroSection
          sharedDateRange={sharedHeroDateRange}
          onSharedDateRangeChange={setSharedHeroDateRange}
          onSearchBarVisibilityChange={setShowCompactSearch}
          externalSearchQuery={sharedSearchQuery}
          onExternalSearchChange={setSharedSearchQuery}
        />

        <main className="mx-auto max-w-[1520px] overflow-x-hidden px-4 pb-14 sm:px-6">
          <div className="grid gap-5 md:gap-8 xl:gap-7 xl:grid-cols-[minmax(0,1fr)_430px]">
            <div className="space-y-6 pt-6 min-w-0 md:space-y-6 md:pt-6 xl:space-y-5 xl:pt-5">
              <TourCarouselSection id="tours" title={t('sections.featuredTitle')} items={pickupTours} />
              <DestinationsSection />
              <TourCarouselSection id="recommended" title={t('sections.recommendedTitle')} items={recommendedTours} />
              <TourCarouselSection id="deals" title={t('sections.topRatedTitle')} items={topRatedTours} />
              <TourCarouselSection id="leisure" title={t('sections.likelyToSellOut')} items={leisureTours} />
            </div>
            <div className="pt-5 min-w-0 md:pt-6 xl:pt-4">
              <SidebarPanel />
            </div>
          </div>
        </main>

        {/* Newsletter Section - Full Width */}
        <div className="mx-auto max-w-[1520px] px-4 sm:px-6 mb-14 overflow-hidden">
          <NewsletterSection />
        </div>

        {/* Features Section - Full Width before footer */}
        <div className="mx-auto mb-14 max-w-[1520px] px-4 sm:px-6">
          <FeaturesSection />
        </div>

        <div className="mb-14">
          <ReviewsCarousel />
        </div>

        <div className="mb-14">
          <SupplierSection />
        </div>

        <div className="mb-14">
          <ExploreMoreSection />
        </div>

        <Footer />
        {showScrollTop && (
          <button
            type="button"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            className="fixed bottom-5 right-5 z-[60] grid size-11 place-items-center rounded-full border border-slate-200 bg-white text-slate-800 shadow-md transition hover:-translate-y-0.5 hover:bg-slate-50"
            aria-label="Scroll to top"
          >
            <ChevronUp className="size-5" />
          </button>
        )}
      </div>

      <AuthModal isOpen={isAuthModalOpen} onClose={closeAuthModal} />
    </>
  );
}

function HomePage() {
  return (
    <AuthModalProvider>
      <RecentlyViewedProvider>
        <HomePageContent />
      </RecentlyViewedProvider>
    </AuthModalProvider>
  );
}

export default HomePage;
