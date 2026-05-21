import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Heart, Star } from "lucide-react";

import { useWishlist } from "@/contexts/WishlistContext";
import { useCurrency } from "@/contexts/CurrencyContext";
import { getMixedHomeSectionToursForSimilar } from "@/lib/tourData";

const CARD_GAP_PX = 16;
const CARD_WIDTH_SM = 260;
const CARD_WIDTH_MD = 280;

function parseReviewsDisplay(value) {
  if (value == null) return "0";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const s = String(value).replace(/,/g, "").trim();
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? String(n) : String(value);
}

/**
 * @param {{ excludeTitle: string, onImageError: (e: import('react').SyntheticEvent<HTMLImageElement>) => void }} props
 */
export function SimilarExperiencesCarousel({ excludeTitle, onImageError }) {
  const { t } = useTranslation();
  const { toggleWishlist, isInWishlist } = useWishlist();
  const { convertPrice } = useCurrency();
  const scrollRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const items = useMemo(
    () => getMixedHomeSectionToursForSimilar({ excludeTitle, limit: 16 }),
    [excludeTitle],
  );

  const updateScrollEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    const max = scrollWidth - clientWidth;
    const eps = 6;
    setCanScrollLeft(scrollLeft > eps);
    setCanScrollRight(max > eps && scrollLeft < max - eps);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollEdges();
    el.addEventListener("scroll", updateScrollEdges, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateScrollEdges) : null;
    ro?.observe(el);
    window.addEventListener("resize", updateScrollEdges);
    return () => {
      el.removeEventListener("scroll", updateScrollEdges);
      ro?.disconnect();
      window.removeEventListener("resize", updateScrollEdges);
    };
  }, [items.length, updateScrollEdges]);

  const scrollByDirection = useCallback((dir) => {
    const el = scrollRef.current;
    if (!el) return;

    const card = window.innerWidth >= 640 ? CARD_WIDTH_MD : CARD_WIDTH_SM;
    const step = card + CARD_GAP_PX;
    const maxScroll = el.scrollWidth - el.clientWidth;
    const target = Math.max(0, Math.min(maxScroll, el.scrollLeft + dir * step * 1.35));

    el.scrollTo({
      left: target,
      behavior: "smooth"
    });
  }, []);

  if (items.length === 0) return null;

  return (
    <section className="mt-6 pt-4 lg:mt-8 lg:pt-6">
      <h2
        className="font-bold tracking-tight text-[color:var(--brand-green)]"
        style={{ fontSize: "clamp(1.15rem, 1.5vw + 0.55rem, 1.5rem)" }}
      >
        {t("tourDetail.similarExperiences")}
      </h2>

      <div className="mt-6 flex items-center gap-2 sm:gap-3">
        <button
          type="button"
          className="hidden size-9 shrink-0 place-items-center rounded-full border border-slate-900 bg-white text-slate-900 shadow-md transition-opacity duration-200 sm:grid sm:size-10 disabled:opacity-0"
          style={{ opacity: canScrollLeft ? 1 : 0, pointerEvents: canScrollLeft ? "auto" : "none" }}
          aria-label={t("tourDetail.similarScrollPrev")}
          onClick={() => scrollByDirection(-1)}
        >
          <ChevronLeft className="size-5" strokeWidth={2} aria-hidden />
        </button>

        <div
          ref={scrollRef}
          className="min-w-0 flex-1 -mx-1 flex gap-4 overflow-x-auto px-1 pb-2 [scrollbar-width:none] [-ms-overflow-style:none] sm:gap-5 md:gap-5 [&::-webkit-scrollbar]:hidden"
          style={{ 
            WebkitOverflowScrolling: "touch",
            overflowY: "unset"
          }}
        >
          {items.map((tour, index) => {
            const detailTo = `/tour/${encodeURIComponent(tour.title)}`;
            const converted = convertPrice(tour.price);
            const reviewsDisplay = parseReviewsDisplay(tour.reviews);
            const isFav = isInWishlist(tour.title);
            const badgeKind = tour.similarExperienceBadge ?? "duration";
            const dealDiscount = tour.discount != null && String(tour.discount).trim() ? String(tour.discount).trim() : null;

            return (
              <article
                key={tour.title}
                className="w-[260px] shrink-0 sm:w-[280px]"
              >
                <div className="relative flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_4px_rgba(15,23,42,0.08)] transition hover:shadow-md">
                  <div className="relative">
                    <Link
                      to={detailTo}
                      className="block overflow-hidden rounded-t-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brand-green)]"
                    >
                      <div className="relative aspect-[4/3] bg-slate-100">
                        <img
                          src={tour.image}
                          alt=""
                          className="h-full w-full object-cover pointer-events-none"
                          data-fallback-offset={index}
                          onError={onImageError}
                        />
                        {badgeKind === "new" ? (
                          <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-white/95 px-1.5 py-0.5 text-[10px] font-bold text-slate-900 shadow-sm backdrop-blur-sm sm:text-[10px]">
                            {t("sections.newBadge")}
                          </span>
                        ) : badgeKind === "deal" && dealDiscount ? (
                          <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-red-500 px-2 py-1 text-[11px] font-bold text-white shadow-sm sm:text-[10px]">
                            {dealDiscount}
                          </span>
                        ) : (
                          <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-slate-700/95 px-2 py-1 text-[11px] font-bold text-white shadow-sm sm:text-[10px]">
                            {tour.duration}
                          </span>
                        )}
                      </div>
                    </Link>
                    <button
                      type="button"
                      onClick={() =>
                        toggleWishlist({
                          title: tour.title,
                          duration: tour.duration,
                          price: tour.price,
                          rating: tour.rating,
                          reviews: tour.reviews,
                          image: tour.image,
                          discount: tour.discount,
                        })
                      }
                      className="absolute right-2 top-2 z-10 grid size-9 place-items-center rounded-full border border-slate-200/90 bg-white text-slate-700 shadow-sm transition hover:scale-105"
                      aria-label={t("nav.wishlist")}
                    >
                      <Heart
                        className={`size-4 ${isFav ? "fill-[color:var(--brand-green)] text-[color:var(--brand-green)]" : "fill-none"}`}
                        strokeWidth={2}
                      />
                    </button>
                  </div>

                  <div className="flex flex-1 flex-col px-3 pb-3 pt-2.5 sm:px-3.5 sm:pb-3.5 sm:pt-3">
                    <Link
                      to={detailTo}
                      className="line-clamp-2 min-h-[2.5rem] font-bold leading-snug text-slate-900 hover:underline"
                      style={{ fontSize: "clamp(0.8125rem, 0.6vw + 0.5rem, 0.9375rem)" }}
                    >
                      {tour.title}
                    </Link>

                    <p className="mt-1.5 text-[12px] font-medium leading-snug text-slate-500 sm:text-[11px]">
                      {t("features.freeCancellation")}
                      <span className="mx-1 text-slate-400" aria-hidden>
                        •
                      </span>
                      {t("tourDetail.pickupIncluded")}
                    </p>

                    <div className="mt-auto flex items-end justify-between gap-2 pt-3">
                      <div className="flex min-w-0 items-center gap-1">
                        <Star
                          className="size-4 shrink-0 fill-amber-500 text-amber-500"
                          strokeWidth={1.5}
                          aria-hidden
                        />
                        <span className="text-[13px] font-bold tabular-nums text-slate-900 sm:text-[12px]">
                          {tour.rating}
                        </span>
                        <span className="text-[12px] text-slate-500 sm:text-[11px]">
                          ({reviewsDisplay})
                        </span>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-[11px] font-medium leading-none text-slate-500">{t("common.from")}</p>
                        <p className="mt-0.5 text-sm font-bold tabular-nums text-slate-900">{converted.formatted}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        <button
          type="button"
          className="hidden size-9 shrink-0 place-items-center rounded-full border border-slate-900 bg-white text-slate-900 shadow-md transition-opacity duration-200 sm:grid sm:size-10 disabled:opacity-0"
          style={{ opacity: canScrollRight ? 1 : 0, pointerEvents: canScrollRight ? "auto" : "none" }}
          aria-label={t("tourDetail.similarScrollNext")}
          onClick={() => scrollByDirection(1)}
        >
          <ChevronRight className="size-5" strokeWidth={2} aria-hidden />
        </button>
      </div>
    </section>
  );
}
