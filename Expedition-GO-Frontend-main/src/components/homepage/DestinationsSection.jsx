import { useRef, useState, useEffect, useLayoutEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { destinations } from "./data";
import { DestinationCard } from "./DestinationCard";
import { DestinationsModal } from "./DestinationsModal";

const CAROUSEL_ARROW_SCROLL_MS = 260;

/** Arrow-driven scroll; stale runs stop when generation bumps (rapid clicks). */
function smoothScrollTo(element, target, duration, generationRef, generation, onComplete) {
  const start = element.scrollLeft;
  const distance = target - start;

  const invokeComplete = () => {
    if (generationRef.current === generation) {
      onComplete?.();
    }
  };

  if (Math.abs(distance) < 0.5) {
    requestAnimationFrame(invokeComplete);
    return;
  }

  let startTime = null;
  const originalSnap = element.style.scrollSnapType;

  element.style.scrollSnapType = "none";

  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  const finishSnap = () => {
    if (generationRef.current !== generation) {
      element.style.scrollSnapType = originalSnap;
      return;
    }
    element.style.scrollSnapType = originalSnap;
    invokeComplete();
  };

  const step = (timestamp) => {
    if (generationRef.current !== generation) {
      element.style.scrollSnapType = originalSnap;
      return;
    }
    if (!startTime) startTime = timestamp;
    const elapsed = timestamp - startTime;
    const progress = Math.min(elapsed / duration, 1);

    element.scrollLeft = start + distance * easeOutCubic(progress);

    if (progress < 1) {
      requestAnimationFrame(step);
    } else {
      requestAnimationFrame(finishSnap);
    }
  };

  requestAnimationFrame(step);
}

export function DestinationsSection() {
  const { t } = useTranslation();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const viewAllTriggerRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const mobileScrollRef = useRef(null);
  const isScrollingRef = useRef(false);
  const scrollGenerationRef = useRef(0);

  const infiniteDestinations = [...destinations, ...destinations, ...destinations];
  const cardWidth = 280;
  const gap = 12;
  const singleSetWidth = destinations.length * (cardWidth + gap);

  const nudgeMobileInfiniteLoop = useCallback(() => {
    const container = mobileScrollRef.current;
    if (!container || destinations.length === 0 || isScrollingRef.current) return;

    const { scrollLeft, scrollWidth, clientWidth } = container;
    const maxScroll = scrollWidth - clientWidth;

    if (maxScroll <= 0) return;

    const threshold = cardWidth * 0.5;

    if (scrollLeft <= threshold) {
      isScrollingRef.current = true;
      const originalSnap = container.style.scrollSnapType;
      container.style.scrollSnapType = "none";
      container.scrollLeft = scrollLeft + singleSetWidth;
      container.style.scrollSnapType = originalSnap;
      setTimeout(() => {
        isScrollingRef.current = false;
      }, 100);
    } else if (scrollLeft >= maxScroll - threshold) {
      isScrollingRef.current = true;
      const originalSnap = container.style.scrollSnapType;
      container.style.scrollSnapType = "none";
      container.scrollLeft = scrollLeft - singleSetWidth;
      container.style.scrollSnapType = originalSnap;
      setTimeout(() => {
        isScrollingRef.current = false;
      }, 100);
    }
  }, [cardWidth, singleSetWidth]);

  const scroll = (direction) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    scrollGenerationRef.current += 1;
    const gen = scrollGenerationRef.current;

    const scrollAmount = cardWidth + gap;
    const currentScroll = container.scrollLeft;

    let newScrollPosition;

    if (direction === "left") {
      newScrollPosition = currentScroll - scrollAmount;
      if (newScrollPosition < scrollAmount) {
        const originalSnap = container.style.scrollSnapType;
        container.style.scrollSnapType = "none";
        container.scrollLeft = singleSetWidth + newScrollPosition;
        container.style.scrollSnapType = originalSnap;
        return;
      }
    } else {
      newScrollPosition = currentScroll + scrollAmount;
      if (newScrollPosition > singleSetWidth * 2 - scrollAmount) {
        const originalSnap = container.style.scrollSnapType;
        container.style.scrollSnapType = "none";
        container.scrollLeft = singleSetWidth + (newScrollPosition - singleSetWidth * 2);
        container.style.scrollSnapType = originalSnap;
        return;
      }
    }

    smoothScrollTo(
      container,
      newScrollPosition,
      CAROUSEL_ARROW_SCROLL_MS,
      scrollGenerationRef,
      gen,
    );
  };

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollLeft = singleSetWidth;
  }, [singleSetWidth]);

  useLayoutEffect(() => {
    const el = mobileScrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    if (maxScroll <= 0) return;
    el.scrollLeft = Math.min(singleSetWidth, maxScroll);
  }, [singleSetWidth]);

  useEffect(() => {
    const el = mobileScrollRef.current;
    if (!el) return;

    let rafId = null;

    const onScroll = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }

      rafId = requestAnimationFrame(() => {
        nudgeMobileInfiniteLoop();
        rafId = null;
      });
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      el.removeEventListener("scroll", onScroll);
    };
  }, [nudgeMobileInfiniteLoop]);

  return (
    <section id="destinations" className="py-4 md:py-4 xl:py-5">
      <div className="mb-[0.6375rem] md:mb-2.5 xl:mb-3 flex items-center justify-between gap-3">
        <h2
          className="whitespace-nowrap font-bold leading-[1.15] tracking-tight text-slate-900"
          style={{ fontSize: "clamp(1.2rem, 1.2vw + 0.5rem, 1.375rem)" }}
        >
          {t("sections.destinations")}
        </h2>

        <div className="flex items-center gap-3">
          <Link
            to="/tours?category=destinations"
            onClick={() => window.scrollTo({ top: 0, behavior: "auto" })}
            className="group inline-flex shrink-0 touch-manipulation items-center gap-1 whitespace-nowrap rounded-md py-2 pl-2 pr-2 text-[13px] font-semibold text-slate-700 transition hover:bg-slate-100/90 hover:text-slate-950 sm:text-[13px] xl:text-[14px]"
          >
            <span className="relative">
              {t("sections.viewAll")}
              <span className="absolute bottom-0 left-0 h-0.5 w-0 bg-[color:var(--brand-green)] transition-all duration-300 group-hover:w-full" />
            </span>
            <ChevronRight className="size-4 text-slate-500 transition group-hover:text-[color:var(--brand-green)]" />
          </Link>
          <div className="hidden items-center gap-2 xl:flex">
            <button
              type="button"
              onClick={() => scroll("left")}
              className="grid size-8 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-[color:var(--brand-green)] hover:text-[color:var(--brand-green)]"
              aria-label="Scroll left"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => scroll("right")}
              className="grid size-8 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-[color:var(--brand-green)] hover:text-[color:var(--brand-green)]"
              aria-label="Scroll right"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        className="hidden gap-3 overflow-x-auto overscroll-x-contain scrollbar-hide xl:flex"
        style={{ scrollSnapType: "x mandatory" }}
      >
        {infiniteDestinations.map((item, index) => (
          <div
            key={`${item.title}-${index}`}
            className="min-w-[280px] shrink-0"
            style={{ scrollSnapAlign: "start" }}
          >
            <DestinationCard {...item} />
          </div>
        ))}
      </div>

      <div
        ref={mobileScrollRef}
        className="-mx-1 flex gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain px-1 scrollbar-hide xl:hidden"
        style={{
          WebkitOverflowScrolling: "touch",
          scrollSnapType: "x mandatory",
        }}
      >
        {infiniteDestinations.map((item, index) => (
          <div
            key={`${item.title}-${index}`}
            className="w-[280px] min-w-[280px] shrink-0"
            style={{ scrollSnapAlign: "start" }}
          >
            <DestinationCard {...item} />
          </div>
        ))}
      </div>

      <DestinationsModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        triggerRef={viewAllTriggerRef}
      />
    </section>
  );
}
