import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, CalendarDays, Clock3, ShoppingCart, Trash2, ShieldCheck, Users } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Navbar } from "@/components/homepage/Navbar";
import { Footer } from "@/components/homepage/Footer";
import { Button } from "@/components/ui/button";
import { useCart } from "@/contexts/CartContext";
import { useCurrency } from "@/contexts/CurrencyContext";
import BrandLoader from "@/components/ui/BrandLoader";

const formatCartDate = (dateString) =>
  new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

const formatBookingDateLabel = (selectedDate, selectedDateEnd) => {
  const start = formatCartDate(selectedDate);
  if (!selectedDateEnd) return start;
  const end = formatCartDate(selectedDateEnd);
  return start === end ? start : `${start} – ${end}`;
};

const formatRemainingTime = (ms) => {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
};

function CartPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { cart, removeFromCart, clearCart } = useCart();
  const { convertPrice } = useCurrency();
  const [now, setNow] = useState(Date.now());
  const [showSplash, setShowSplash] = useState(false);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  const total = useMemo(() => {
    return cart.reduce((acc, item) => {
      const raw = typeof item.price === "number" ? item.price : Number.parseFloat(String(item.price).replace(/[^\d.]/g, "")) || 0;
      return acc + raw;
    }, 0);
  }, [cart]);

  return (
    <div className="flex min-h-screen flex-col bg-[color:var(--page-bg)] text-slate-900">
      <Navbar />
      <div className="h-[58px] sm:h-[96px] lg:h-[104px]" />

      <main className="mx-auto w-full flex-1 max-w-[1520px] px-3 py-5 sm:px-5 sm:py-7 lg:px-6 lg:py-8">
        {/* Header */}
        <div className="mb-6 sm:mb-8">
          <button
            onClick={() => navigate(-1)}
            className="group mb-5 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-base font-semibold text-slate-600 shadow-sm transition hover:border-[color:var(--brand-green)]/30 hover:bg-[color:var(--brand-mist)] hover:text-[color:var(--brand-green)] hover:shadow-md sm:text-sm"
          >
            <ArrowLeft className="size-4 text-[color:var(--brand-green)] transition group-hover:-translate-x-0.5" />
            Back
          </button>

          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-4">
              <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-[color:var(--brand-mist)] text-[color:var(--brand-green)] shadow-sm sm:size-14">
                <ShoppingCart className="size-6 sm:size-7" />
              </div>
              <div className="min-w-0">
                <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
                  {t("nav.cart")}
                </h1>
                <p className="mt-0.5 text-base font-medium text-slate-500 sm:text-sm">
                  {cart.length} {cart.length === 1 ? "item" : "items"} in your cart
                </p>
              </div>
            </div>

            {cart.length > 0 && (
              <Button
                variant="ghost"
                onClick={clearCart}
                className="shrink-0 gap-2 text-base text-slate-500 hover:bg-rose-50 hover:text-rose-600 sm:text-sm"
              >
                <Trash2 className="size-4" />
                <span className="hidden sm:inline">Clear cart</span>
                <span className="sm:hidden">Clear</span>
              </Button>
            )}
          </div>
        </div>

        {cart.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-3xl border border-slate-200 bg-white px-6 py-16 text-center shadow-sm sm:py-24">
            <div className="mb-6 grid size-20 place-items-center rounded-full bg-[color:var(--brand-mist)] sm:size-24">
              <ShoppingCart className="size-10 text-[color:var(--brand-green)] sm:size-12" />
            </div>
            <h2 className="mb-2 text-xl font-bold text-slate-900 sm:text-2xl">
              Your cart is empty
            </h2>
            <p className="mb-8 max-w-xs text-base leading-relaxed text-slate-500">
              Activities you add will appear here. You have up to 25 minutes to complete your booking.
            </p>
            <Link
              to="/tours"
              className="inline-flex items-center justify-center rounded-full bg-[color:var(--brand-green)] px-8 py-3 text-base font-semibold !text-white shadow-lg shadow-[color:var(--brand-green)]/25 transition hover:bg-[color:var(--brand-green)]/90 hover:shadow-xl hover:shadow-[color:var(--brand-green)]/30 sm:text-sm"
            >
              Explore activities
            </Link>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
            {/* Items */}
            <div className="space-y-4">
              {cart.map((item) => {
                const remainingMs = Math.max(0, Number(item.expiresAt) - now);
                const converted = convertPrice(item.price);
                const isExpired = remainingMs <= 0;

                return (
                  <article
                    key={item.key}
                    className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition-all hover:shadow-md"
                  >
                    <div className="absolute left-0 top-0 h-full w-1.5 bg-[color:var(--brand-green)]" />
                    <div className="flex items-start gap-3 p-3 pl-4 sm:gap-5 sm:p-5 sm:pl-6">
                      <img
                        src={item.image}
                        alt={item.title}
                        className="h-36 w-[7rem] shrink-0 rounded-xl object-cover object-center shadow-sm sm:h-80 sm:w-36 lg:h-40 lg:w-44"
                      />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex items-start justify-between gap-2">
                           <h5 className="line-clamp-2 text-base font-bold leading-snug text-slate-900 sm:text-base lg:text-lg">
                            {item.title}
                          </h5>
                          <button
                            type="button"
                            onClick={() => removeFromCart(item.key)}
                            className="hidden shrink-0 rounded-full p-2 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 sm:block"
                            aria-label="Remove item"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </div>

                        <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500">
                          <Clock3 className="size-3.5 sm:size-4" />
                          {item.duration}
                        </p>

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700 sm:text-xs">
                            <CalendarDays className="size-3.5" />
                            {formatBookingDateLabel(item.selectedDate, item.selectedDateEnd)}
                          </span>
                          {(item.adults || item.seniors || item.youths || item.children || item.infants) && (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700 sm:text-xs">
                              <Users className="size-3.5" />
                              {(item.adults || 0) + (item.seniors || 0) + (item.youths || 0) + (item.children || 0) + (item.infants || 0)} travelers
                            </span>
                          )}
                          {!isExpired ? (
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-100 bg-amber-50 px-3 py-1 text-sm font-semibold text-amber-700 sm:text-xs">
                              <span className="relative flex size-2">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                                <span className="relative inline-flex size-2 rounded-full bg-amber-500" />
                              </span>
                              Expires in {formatRemainingTime(remainingMs)}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-500 sm:text-xs">
                              Expired
                            </span>
                          )}
                        </div>

                        <div className="mt-4 flex items-center justify-between sm:mt-auto sm:pt-4">
                           <p className="text-base font-bold text-slate-900 sm:text-lg lg:text-xl">
                            {converted.formatted}
                          </p>
                          <button
                            type="button"
                            onClick={() => removeFromCart(item.key)}
                            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-base font-medium text-rose-600 transition hover:bg-rose-50 sm:hidden"
                          >
                            <Trash2 className="size-4" />
                            Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>

            {/* Summary */}
            <aside className="h-fit space-y-4 lg:sticky lg:top-28">
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                <h5 className="text-base font-bold text-slate-900 sm:text-lg lg:text-xl">Order Summary</h5>

                <div className="mt-5 space-y-3">
                  <div className="flex items-center justify-between text-base text-slate-600 sm:text-sm">
                    <span>Subtotal ({cart.length} {cart.length === 1 ? "item" : "items"})</span>
                    <span>{convertPrice(total).formatted}</span>
                  </div>
                  <div className="flex items-center justify-between text-base text-slate-600 sm:text-sm">
                    <span>Taxes & Fees</span>
                    <span className="text-slate-400">Calculated at checkout</span>
                  </div>
                </div>

                <div className="my-4 h-px bg-slate-100" />

                <div className="flex items-center justify-between">
                  <span className="text-base font-semibold text-slate-900">Total</span>
                  <span className="text-lg font-bold text-slate-900 sm:text-xl">{convertPrice(total).formatted}</span>
                </div>

                <Button
                  onClick={() => {
                    setShowSplash(true);
                    const item = cart[0];
                    const totalTravelers =
                      (item.adults || 0) +
                      (item.seniors || 0) +
                      (item.youths || 0) +
                      (item.children || 0) +
                      (item.infants || 0);
                    window.setTimeout(() => {
                      navigate("/booking", {
                        state: {
                          tour: {
                            title: item.title,
                            image: item.image,
                            provider: item.provider || "Expedition GO Tours",
                            rating: item.rating || 4.8,
                            reviews: item.reviews || 120,
                            date: formatBookingDateLabel(item.selectedDate, item.selectedDateEnd),
                            time: item.time || "9:00 AM",
                            duration: item.duration,
                            travelers: `${totalTravelers} ${totalTravelers === 1 ? "adult" : "travelers"}`,
                            price: typeof item.price === "number" ? item.price : Number.parseFloat(String(item.price).replace(/[^\d.]/g, "")) || 0,
                            cancellation: item.cancellation || "Free cancellation up to 24 hours before",
                            language: item.language || "English - Guide",
                          },
                        },
                      });
                    }, 1200);
                  }}
                  className="mt-6 w-full bg-[color:var(--brand-green)] py-6 text-base font-semibold !text-white shadow-lg shadow-[color:var(--brand-green)]/20 transition hover:bg-[color:var(--brand-green)]/90 hover:shadow-xl hover:shadow-[color:var(--brand-green)]/30"
                >
                  Continue to Checkout
                </Button>

                <div className="mt-4 flex items-center justify-center gap-2 text-sm text-slate-500 sm:text-xs">
                  <ShieldCheck className="size-3.5 text-slate-400" />
                  <span>Secure checkout &middot; No hidden fees</span>
                </div>
              </div>

              {/* Trust / Help small card */}
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                <h4 className="mb-3 text-base font-semibold text-slate-900 sm:text-lg">Need help?</h4>
                <p className="text-base leading-relaxed text-slate-500 sm:text-sm">
                  Your items are reserved for 25 minutes. If you have questions, visit our{" "}
                  <Link to="/help" className="font-medium text-[color:var(--brand-green)] hover:underline">
                    Help Centre
                  </Link>
                  .
                </p>
              </div>
            </aside>
          </div>
        )}
      </main>

      {showSplash && (
        <BrandLoader fullScreen splash label="Loading checkout..." />
      )}

      <Footer />
    </div>
  );
}

export default CartPage;
