import { Star, CircleCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useRef } from "react";

import { useCurrency } from "@/contexts/CurrencyContext";

/**
 * Hero Tour Card - Horizontal layout for hero section "Pickup where you left off" carousel
 * Matches GetYourGuide's "Continue planning your trip" card style exactly
 */
export function HeroTourCard({ title, duration, price, rating, reviews, image, _disableTracking = false }) {
  const { t } = useTranslation();
  const { convertPrice } = useCurrency();

  const convertedPrice = convertPrice(price);

  const panRef = useRef({
    active: false,
    originX: 0,
    originY: 0,
    maxAbsDx: 0,
    maxAbsDy: 0,
  });
  const lastGestureWasPanRef = useRef(false);

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

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointerGesture}
      onPointerCancel={endPointerGesture}
      className="group relative contain-none flex h-[133px] touch-manipulation overflow-hidden rounded-xl bg-white p-2 shadow-md transition duration-200 hover:shadow-lg"
    >
      {/* Image - Left side, adjusted for new height */}
      <div className="relative z-0 w-[100px] shrink-0 overflow-hidden rounded-lg bg-slate-100">
        <img 
          src={image} 
          alt=""
          aria-hidden={true}
          className="h-full w-full object-cover object-center transition duration-300 group-hover:scale-105" 
        />
      </div>

      {/* Content - Right side */}
      <div className="relative z-0 flex min-w-0 flex-1 flex-col pl-2">
        {/* Title - single line with ellipsis, full width */}
        <h3 
          className="truncate font-semibold leading-[1.1] text-slate-900 mb-1 w-full"
          style={{ fontSize: 'clamp(13px, 2.2vw, 14px)' }}
        >
          {title}
        </h3>
        
        {/* Duration - Very small */}
        <p 
          className="text-slate-600 leading-tight mb-1.5"
          style={{ fontSize: 'clamp(11px, 1.8vw, 11px)' }}
        >
          {duration}
        </p>
        
        {/* Features - Free Cancellation & Pickup */}
        <div className="mb-auto space-y-0.5">
          <div className="flex items-center gap-1">
            <CircleCheck className="size-6 text-emerald-500" />
            <span 
              className="text-slate-700 font-semibold"
              style={{ fontSize: 'clamp(11px, 1.6vw, 10px)' }}
            >
              {t("features.freeCancellation")}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <CircleCheck className="size-6 text-emerald-500" />
            <span 
              className="text-slate-700 font-semibold"
              style={{ fontSize: 'clamp(11px, 1.6vw, 10px)' }}
            >
              {t("tourDetail.pickupIncluded")}
            </span>
          </div>
        </div>
        
        {/* Bottom row: Rating & Price - tight to bottom */}
        <div className="flex items-center justify-between gap-2">
          {/* Rating */}
          <div className="flex items-center gap-0.5">
            <Star className="size-3 fill-amber-400 text-amber-400" />
            <span 
              className="font-semibold text-slate-900"
              style={{ fontSize: 'clamp(10px, 1.9vw, 12px)' }}
            >
              {rating}
            </span>
            <span 
              className="text-slate-600"
              style={{ fontSize: 'clamp(8px, 1.7vw, 10px)' }}
            >
              ({reviews})
            </span>
          </div>
          
          {/* Price */}
          <div className="text-right leading-none">
            <p 
              className="text-slate-600 mb-0.5"
              style={{ fontSize: 'clamp(7px, 1.5vw, 9px)' }}
            >
              {t('common.from')}
            </p>
            <p 
              className="font-semibold text-slate-900"
              style={{ fontSize: 'clamp(12px, 2.3vw, 15px)' }}
            >
              {convertedPrice.formatted}
            </p>
          </div>
        </div>
      </div>
      <Link
        to={detailTo}
        onClick={handleDetailLinkClick}
        aria-label={`${t("common.viewDetails", { defaultValue: "View details" })}: ${title}`}
        className="absolute inset-0 z-[5] rounded-xl outline-none ring-inset xl:focus-visible:ring-2 xl:focus-visible:ring-slate-400"
      />
    </div>
  );
}
