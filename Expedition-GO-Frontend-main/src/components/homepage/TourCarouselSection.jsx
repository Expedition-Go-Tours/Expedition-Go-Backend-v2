import { useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { TourCard } from "./TourCard";
import { SectionHeading } from "./SectionHeading";

const CAROUSEL_ARROW_SCROLL_MS = 260;

/** Programmatic scroll for arrow buttons; cancels stale frames if generation does not match. */
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

export function TourCarouselSection({ id, title, subtitle, items }) {
  const scrollContainerRef = useRef(null);
  const mobileScrollRef = useRef(null);
  const isScrollingRef = useRef(false);
  const scrollGenerationRef = useRef(0);

  const infiniteItems = [...items, ...items, ...items];
  const cardWidth = 280;
  const gap = 12;
  const singleSetWidth = items.length * (cardWidth + gap);

  const nudgeMobileInfiniteLoop = useCallback(() => {
    const container = mobileScrollRef.current;
    if (!container || items.length === 0 || isScrollingRef.current) return;

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
  }, [items.length, singleSetWidth, cardWidth]);

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
    <section id={id} className="py-4 md:py-4 xl:py-5">
      <SectionHeading
        title={title}
        subtitle={subtitle}
        categoryId={id}
        onScrollLeft={() => scroll("left")}
        onScrollRight={() => scroll("right")}
      />

      <div
        ref={scrollContainerRef}
        className="hidden gap-3 overflow-x-auto overscroll-x-contain scrollbar-hide xl:flex"
        style={{ scrollSnapType: "x mandatory" }}
      >
        {infiniteItems.map((item, index) => (
          <div
            key={`${item.title}-${index}`}
            className="min-w-[280px] shrink-0"
            style={{ scrollSnapAlign: "start" }}
          >
            <TourCard {...item} />
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
        {infiniteItems.map((item, index) => (
          <div
            key={`${item.title}-${index}`}
            className="w-[280px] min-w-[280px] shrink-0"
            style={{ scrollSnapAlign: "start" }}
          >
            <TourCard {...item} />
          </div>
        ))}
      </div>
    </section>
  );
}
