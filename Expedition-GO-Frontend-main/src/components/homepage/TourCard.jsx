import { Heart, Star } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useRef } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { useWishlist } from "@/contexts/WishlistContext";
import { useCurrency } from "@/contexts/CurrencyContext";

export function TourCard({
  title,
  duration,
  price,
  rating,
  reviews,
  image,
  discount,
  _disableTracking = false,
  variant = "default",
  badge = "duration",
}) {
  const { t } = useTranslation();
  const { toggleWishlist, isInWishlist } = useWishlist();
  const { convertPrice } = useCurrency();
  const isFavorited = isInWishlist(title);
  /** Tracks this pointer gesture so carousel horizontal scroll does not cancel every tap. */
  const panRef = useRef({
    active: false,
    originX: 0,
    originY: 0,
    maxAbsDx: 0,
    maxAbsDy: 0,
  });
  /** Set in pointerup/cancel before click; true = user was panning the carousel, not tapping. */
  const lastGestureWasPanRef = useRef(false);

  // Convert price
  const convertedPrice = convertPrice(price);

  const handleHeartClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleWishlist({ title, duration, price, rating, reviews, image, discount });
  };

  const resetPanTracking = () => {
    panRef.current = {
      active: false,
      originX: 0,
      originY: 0,
      maxAbsDx: 0,
      maxAbsDy: 0,
    };
  };

  const handlePointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    panRef.current = {
      active: true,
      originX: e.clientX,
      originY: e.clientY,
      maxAbsDx: 0,
      maxAbsDy: 0,
    };
    lastGestureWasPanRef.current = false;
  };

  const handlePointerMove = (e) => {
    if (!panRef.current.active) return;

    const dx = Math.abs(e.clientX - panRef.current.originX);
    const dy = Math.abs(e.clientY - panRef.current.originY);
    panRef.current.maxAbsDx = Math.max(panRef.current.maxAbsDx, dx);
    panRef.current.maxAbsDy = Math.max(panRef.current.maxAbsDy, dy);
  };

  const endPointerGesture = () => {
    if (!panRef.current.active) return;
    const { maxAbsDx, maxAbsDy } = panRef.current;
    resetPanTracking();
    // Only treat as "carousel pan" if movement clearly dominated horizontal (not finger jitter).
    const PAN_MIN_PX = 20;
    const HORIZONTAL_DOMINANCE = 1.35;
    lastGestureWasPanRef.current =
      maxAbsDx >= PAN_MIN_PX && maxAbsDx > maxAbsDy * HORIZONTAL_DOMINANCE;
  };

  const handleDetailLinkClick = (e) => {
    if (lastGestureWasPanRef.current) {
      e.preventDefault();
      lastGestureWasPanRef.current = false;
    }
  };

  const detailTo = `/tour/${encodeURIComponent(title)}`;
  
  const imageHeightClass =
    variant === "allTours" ? "h-[10.25rem] xl:h-[11.1rem]" : "h-40 xl:h-44";

  return (
    <Card 
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointerGesture}
      onPointerCancel={endPointerGesture}
      className="group relative contain-none touch-manipulation overflow-hidden rounded-b-[12px] border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition duration-300 xl:hover:-translate-y-0.5 xl:hover:shadow-none xl:active:scale-95 xl:active:shadow-[0_1px_2px_rgba(15,23,42,0.06)]"
    >
      <div className={`relative z-0 ${imageHeightClass} overflow-hidden bg-slate-100`}>
        <img 
          src={image} 
          alt=""
          aria-hidden={true}
          className="h-full w-full object-cover object-center transition duration-500 xl:group-hover:scale-105" 
          style={{ minHeight: '100%' }}
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-950/45 to-transparent" />
        {badge === "new" ? (
          <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-white/95 px-2 py-1 text-[11px] font-bold text-slate-900 shadow-sm backdrop-blur-sm xl:text-[10px]">
            {t("sections.newBadge")}
          </span>
        ) : (
          <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-slate-900/75 px-2 py-1 text-[11px] font-bold text-white shadow-sm xl:text-[10px]">
            {duration}
          </span>
        )}
        {discount && (
          <span className="pointer-events-none absolute left-2 bottom-2 rounded-md bg-red-500 px-2 py-1 text-[10px] font-bold text-white shadow-sm">
            {discount}
          </span>
        )}
      </div>
      <CardContent
        className={
          variant === "allTours"
            ? "relative z-0 p-[0.85rem] xl:p-[0.85rem]"
            : "relative z-0 p-4 xl:p-4"
        }
      >
        <p
          className={
            variant === "allTours"
              ? "line-clamp-2 font-bold leading-tight tracking-tight text-slate-900"
              : "line-clamp-2 font-bold leading-tight tracking-tight text-slate-900"
          }
          style={{ fontSize: variant === "allTours" ? 'clamp(0.9375rem, 0.8vw + 0.5rem, 1rem)' : 'clamp(0.875rem, 0.7vw + 0.5rem, 0.9375rem)' }}
        >
          {title}
        </p>
        <div
          className={
            variant === "allTours"
              ? "mt-[0.425rem] flex flex-col gap-0.5"
              : "mt-2 flex items-center gap-1"
          }
          style={{ fontSize: variant === "allTours" ? 'clamp(0.75rem, 0.6vw + 0.4rem, 0.8125rem)' : 'clamp(0.6875rem, 0.5vw + 0.4rem, 0.75rem)' }}
        >
          <span className="font-medium text-slate-700">
            {t("features.freeCancellation")}
          </span>
          {variant === "allTours" ? null : <span className="font-medium text-slate-700">•</span>}
          <span className="font-medium text-slate-700">
            {t("tourDetail.pickupIncluded")}
          </span>
        </div>
        <div
          className={
            variant === "allTours"
              ? "mt-[0.64rem] flex items-end justify-between gap-3"
              : "mt-3 flex items-end justify-between gap-3"
          }
        >
          <div
            className={
              variant === "allTours"
                ? "flex items-center gap-1 text-[13px] text-amber-500 xl:text-[12px]"
                : "flex items-center gap-1 text-[13px] text-amber-500 xl:text-[12px]"
            }
          >
            <Star className="size-4 fill-current" />
            <span className={variant === "allTours" ? "text-[15px] font-semibold text-slate-900 xl:text-[14px]" : "text-[15px] font-semibold text-slate-900 xl:text-[14px]"}>{rating}</span>
            <span className={variant === "allTours" ? "text-[13px] text-slate-500 xl:text-[12px]" : "text-[13px] text-slate-500 xl:text-[12px]"}>({reviews})</span>
          </div>
          <p className={variant === "allTours" ? "text-[13px] font-semibold text-slate-500 xl:text-[12px]" : "text-[13px] font-semibold text-slate-500 xl:text-[12px]"}>
            {t('common.from')} <span className={variant === "allTours" ? "text-base text-slate-900 xl:text-[15px]" : "text-base text-slate-900 xl:text-[15px]"}>{convertedPrice.formatted}</span>
          </p>
        </div>
      </CardContent>
      <Link
        to={detailTo}
        onClick={handleDetailLinkClick}
        aria-label={`${t("common.viewDetails", { defaultValue: "View details" })}: ${title}`}
        className="absolute inset-0 z-[5] rounded-b-[12px] outline-none ring-inset xl:focus-visible:ring-2 xl:focus-visible:ring-slate-400"
      />
      <button 
        type="button"
        onClick={handleHeartClick}
        className="absolute right-2 top-2 z-[10] grid size-7 place-items-center rounded-full bg-white/88 text-slate-700 shadow-sm backdrop-blur transition xl:hover:bg-white xl:hover:scale-110"
      >
        <Heart 
          className={`size-3.5 transition-colors ${
            isFavorited ? 'fill-[color:var(--brand-green)] text-[color:var(--brand-green)]' : ''
          }`} 
        />
      </button>
    </Card>
  );
}
