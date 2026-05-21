import { Link } from "react-router-dom";
import { Heart, ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Navbar } from "@/components/homepage/Navbar";
import { Footer } from "@/components/homepage/Footer";
import { TourCard } from "@/components/homepage/TourCard";
import { useWishlist } from "@/contexts/WishlistContext";
import { AuthModalProvider } from "@/contexts/AuthModalContext";
import { RecentlyViewedProvider } from "@/contexts/RecentlyViewedContext";

function WishlistPageContent() {
  const { t } = useTranslation();
  const { wishlist } = useWishlist();

  return (
    <div className="min-h-screen bg-[color:var(--page-bg)] text-slate-900">
      <Navbar />
      
      {/* Navbar spacer */}
      <div className="h-[58px] sm:h-[96px] lg:h-[104px]" />

      <main className="mx-auto w-full max-w-[1520px] px-3 py-5 sm:px-5 sm:py-7 lg:px-6 lg:py-8">
        {/* Header */}
        <div className="mb-5 sm:mb-7">
          <Link
            to="/"
            className="mb-3 inline-flex items-center gap-2 text-sm text-slate-600 transition hover:text-[color:var(--brand-green)] sm:mb-4"
          >
            <ArrowLeft className="size-4" />
            {t('common.backToHome')}
          </Link>
          <div className="flex items-start gap-2.5 sm:items-center sm:gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-full bg-[color:var(--brand-mist)] text-[color:var(--brand-green)] sm:size-12">
              <Heart className="size-5 fill-current sm:size-6" />
            </div>
            <div className="min-w-0">
              <h1 className="leading-tight text-slate-900" style={{ fontSize: 'clamp(1.5rem, 2.5vw + 0.5rem, 2.25rem)' }}>{t('wishlist.title')}</h1>
              <p className="mt-1 text-slate-600" style={{ fontSize: 'clamp(0.875rem, 0.8vw + 0.5rem, 1rem)' }}>
                {wishlist.length} {wishlist.length === 1 ? t('wishlist.tourSaved') : t('wishlist.toursSaved')}
              </p>
            </div>
          </div>
        </div>

        {/* Wishlist Content */}
        {wishlist.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center sm:py-16 lg:py-20">
            <div className="mb-5 grid size-20 place-items-center rounded-full bg-slate-100 text-slate-400 sm:mb-6 sm:size-24">
              <Heart className="size-10 sm:size-12" />
            </div>
            <h2 className="mb-2 font-bold text-slate-900" style={{ fontSize: 'clamp(1.25rem, 1.8vw + 0.5rem, 1.75rem)' }}>{t('wishlist.empty')}</h2>
            <p className="mb-6 max-w-md px-2 text-slate-600" style={{ fontSize: 'clamp(0.875rem, 0.8vw + 0.5rem, 1.0625rem)' }}>
              {t('wishlist.emptyDesc')}
            </p>
            <Link
              to="/"
              className="inline-flex items-center gap-2 rounded-lg bg-[color:var(--brand-green)] px-5 py-2.5 text-sm font-semibold !text-white transition hover:bg-[color:var(--brand-green)]/90 sm:px-6 sm:py-3 sm:text-base"
            >
              {t('wishlist.exploreTours')}
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 md:gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {wishlist.map((item, index) => (
              <TourCard key={`${item.title}-${index}`} {...item} />
            ))}
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}

function WishlistPage() {
  return (
    <AuthModalProvider>
      <RecentlyViewedProvider>
        <WishlistPageContent />
      </RecentlyViewedProvider>
    </AuthModalProvider>
  );
}

export default WishlistPage;
