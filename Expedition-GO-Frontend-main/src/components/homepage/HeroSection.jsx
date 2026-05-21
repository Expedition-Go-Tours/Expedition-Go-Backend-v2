
import { MapPin, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import heroPic from "@/assets/images/hero_pic.jpg";
import { HeroTourCard } from "./HeroTourCard";
import { heroStats } from "./data";
import { useRecentlyViewed } from "@/contexts/RecentlyViewedContext";
import { useSearchAutocomplete } from "@/hooks/useSearchAutocomplete";
import { SearchAutocomplete } from "./SearchAutocomplete";

export function HeroSection({
  _sharedDateRange,
  _onSharedDateRangeChange,
  onSearchBarVisibilityChange,
  externalSearchQuery,
  onExternalSearchChange,
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [_currentIndex, _setCurrentIndex] = useState(0);
  const [isSearchBarSticky, setIsSearchBarSticky] = useState(false);
  const [searchBarHeight, setSearchBarHeight] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const scrollContainerRef = useRef(null);
  const desktopScrollRef = useRef(null);
  const searchBarRef = useRef(null);
  const searchInputRef = useRef(null);
  const autocompleteRef = useRef(null);
  const searchBarInitialTop = useRef(null);
  const _isScrollingRef = useRef(false);
  const prevStickyRef = useRef(false);
  const { recentlyViewed } = useRecentlyViewed();
  const isExternalSearchMode = typeof onExternalSearchChange === "function";
  const activeSearchQuery = isExternalSearchMode ? (externalSearchQuery ?? "") : searchQuery;
  
  // Get search results
  const searchResults = useSearchAutocomplete(activeSearchQuery);

  // Carousel setup - Simple finite scroll
  const carouselItems = recentlyViewed.length > 0 ? recentlyViewed : [];

  const _cardWidth = 280; // Horizontal card width
  const _gap = 12;

  // Simple scroll function for finite carousel
  const scroll = (direction) => {
    const container = desktopScrollRef.current;
    if (!container) return;

    const scrollAmount = 320;
    const currentScroll = container.scrollLeft;
    const maxScroll = container.scrollWidth - container.clientWidth;

    if (direction === "left") {
      const newScrollPosition = Math.max(0, currentScroll - scrollAmount);
      container.scrollTo({
        left: newScrollPosition,
        behavior: "smooth",
      });
    } else {
      const newScrollPosition = Math.min(maxScroll, currentScroll + scrollAmount);
      container.scrollTo({
        left: newScrollPosition,
        behavior: "smooth",
      });
    }
  };

  // Remove infinite scroll initialization and listeners
  useEffect(() => {
    // No special initialization needed for finite scroll
  }, []);

  // Simple mobile scroll (no infinite loop)
  useEffect(() => {
    // No special mobile infinite scroll logic needed
  }, []);

  // Handle click outside to close autocomplete
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        searchInputRef.current &&
        !searchInputRef.current.contains(event.target) &&
        autocompleteRef.current &&
        !autocompleteRef.current.contains(event.target)
      ) {
        setShowAutocomplete(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Show autocomplete when there are results
  useEffect(() => {
    if (activeSearchQuery.trim().length >= 2 && searchResults.total > 0) {
      setShowAutocomplete(true);
    } else {
      setShowAutocomplete(false);
    }
  }, [activeSearchQuery, searchResults.total]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    if (activeSearchQuery.trim()) {
      navigate(`/tours?search=${encodeURIComponent(activeSearchQuery.trim())}`);
      setShowAutocomplete(false);
    }
  };

  const handleSearchChange = (e) => {
    const value = e.target.value;
    if (isExternalSearchMode) {
      onExternalSearchChange(value);
      return;
    }
    setSearchQuery(value);
  };

  const handleAutocompleteSelect = () => {
    setShowAutocomplete(false);
  };

  useEffect(() => {
    const handleScroll = () => {
      if (!searchBarRef.current) return;
      
      // Capture initial position and height only once when component mounts
      if (searchBarInitialTop.current === null) {
        const rect = searchBarRef.current.getBoundingClientRect();
        searchBarInitialTop.current = rect.top + window.scrollY;
        setSearchBarHeight(rect.height);
      }
      
      const scrollPosition = window.scrollY;
      
      // Unstick 150px before reaching original position for snappier feel
      const threshold = searchBarInitialTop.current - 150;
      const shouldBeSticky = scrollPosition >= threshold;
      
      if (prevStickyRef.current !== shouldBeSticky) {
        prevStickyRef.current = shouldBeSticky;
        setIsSearchBarSticky(shouldBeSticky);
        if (onSearchBarVisibilityChange) {
          onSearchBarVisibilityChange(shouldBeSticky);
        }
      }
    };

    // Initial check
    handleScroll();
    
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, [onSearchBarVisibilityChange]);

  return (
    <section
      id="home"
      className="relative min-h-[50vh] sm:min-h-[52vh] md:min-h-[50vh] lg:min-h-[52vh] xl:min-h-[60vh] flex items-start pt-[12vh] overflow-visible bg-(--brand-green) text-white pb-4"
    >
      <div className="absolute inset-0">
        <img
          src={heroPic}
          alt="African safari landscape at sunset"
          className="h-full w-full object-cover object-[center_bottom] lg:object-[center_80%] xl:object-center opacity-80"
        />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.5),rgba(0,0,0,0.18)_25%,rgba(122,69,11,0.14)_60%,rgba(0,0,0,0.2)),radial-gradient(circle_at_center,rgba(255,174,58,0.28),transparent_42%)]" />
      </div>

      <div className="relative mx-auto w-full max-w-[1520px] px-2 py-10 sm:px-4 sm:py-14 md:py-16 overflow-visible">
        <div className="mx-auto max-w-4xl text-center">
          <div className="flex justify-center">
          </div>

            <h1
              className="
                mt-4
                mx-auto
                text-center
                text-white
                drop-shadow-[0_6px_20px_rgba(0,0,0,0.55)]
                whitespace-nowrap
                overflow-hidden
                text-ellipsis
                w-full
                max-w-none
                px-2
              "
              style={{
                fontFamily: 'var(--font-hero)',
                fontWeight: 700,
                fontSize: 'clamp(1.75rem, 4.5vw, 2.75rem)',
                lineHeight: 'clamp(2rem, 5vw, 3rem)',
                letterSpacing: '0px'
              }}
            >
              {t('hero.title')}
            </h1>

          <p 
            className="mt-1 text-white/92 drop-shadow-[0_2px_4px_rgba(0,0,0,0.45)] px-2 whitespace-nowrap"
            style={{
              fontFamily: 'GT Eesti Pro Display, sans-serif',
              fontWeight: 700,
              fontSize: 'clamp(11px, 3.5vw, 24px)',
              lineHeight: 'clamp(16px, 4.5vw, 30px)',
              letterSpacing: '0px'
            }}
          >
            {t('hero.subtitle')}
          </p>

          <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-1 backdrop-blur-md">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--brand-green)]" />
            <p className="text-xs font-medium tracking-wide text-white/80">
              {t("hero.availability")}
            </p>
          </div>
          
          {/* Hero Search Bar - On mobile: becomes fixed at top. On desktop: fades out when reaching navbar */}
          <div 
            className="relative mt-4 sm:mt-3.5 md:mt-4 mx-auto w-full max-w-4xl lg:max-w-2xl"
            style={{ minHeight: searchBarHeight > 0 ? `${searchBarHeight}px` : 'auto' }}
          >
            <div 
              ref={searchBarRef}
              className={`${
                isSearchBarSticky 
                  ? 'fixed top-0 left-0 right-0 z-60 px-3 py-2 lg:opacity-0 lg:pointer-events-none lg:static lg:px-0 lg:py-0' 
                  : 'static opacity-100'
              }`}
            >
              <form
                onSubmit={handleSearchSubmit}
                className="relative"
              >
                <div
                  id="hero-search-bar"
                  className="grid w-full gap-0 rounded-lg border border-slate-200 bg-white sm:grid-cols-[1fr_auto] grid-cols-[1fr_auto] shadow-md mx-auto"
                >
                  <div className="flex items-center gap-2 text-left text-slate-900 px-2 py-1.5">
                    <MapPin className="text-(--brand-green) shrink-0 size-3" />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-[9px] sm:text-[10px] mb-0">
                        {t('hero.destination')}
                      </p>
                      <Input
                        ref={searchInputRef}
                        value={activeSearchQuery}
                        onChange={handleSearchChange}
                        onFocus={() => activeSearchQuery.trim().length >= 2 && searchResults.total > 0 && setShowAutocomplete(true)}
                        className="h-auto border-0 px-1 py-0 text-[11px] sm:text-[11px] text-slate-900 placeholder:text-slate-400 shadow-none ring-0 focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                        style={{ 
                          caretColor: '#01311a',
                          outline: 'none',
                          textAlign: 'left'
                        }}
                        placeholder={t('hero.destinationPlaceholder')}
                        autoComplete="off"
                      />
                    </div>
                  </div>

                  <div className="p-1">
                    <Button
                      type="submit"
                      size="sm"
                      className="h-full w-full rounded-lg min-h-7 text-[10px] px-3 sm:min-h-8 sm:text-[11px] sm:px-4"
                    >
                      <Search className="size-2.5 sm:size-3" />
                      {t('hero.search')}
                    </Button>
                  </div>
                </div>

                {/* Autocomplete Dropdown */}
                <div ref={autocompleteRef}>
                  <SearchAutocomplete
                    results={searchResults}
                    onSelect={handleAutocompleteSelect}
                    isVisible={showAutocomplete}
                    searchQuery={activeSearchQuery}
                  />
                </div>
              </form>
            </div>
          </div>

          <div className="mt-3 sm:mt-3.5 md:mt-4 hidden grid-cols-3 gap-2 md:grid">
            {heroStats.map((stat) => (
              <div
                key={stat.label}
                className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-2 backdrop-blur-sm"
              >
                <p className="text-base font-black">{stat.value}</p>
                <p className="mt-0.5 text-[10px] text-white/70">
                  {t(`stats.${stat.translationKey}`)}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Compact carousel - only show if there are items */}
        {carouselItems.length > 0 && (
          <div className="mt-4 sm:mt-5 md:mt-6 overflow-visible">
            <h2 
              className="mb-3 text-center font-semibold tracking-tight text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.5)]"
              style={{ fontSize: 'clamp(15px, 2.5vw, 16px)' }}
            >
              {t('sections.pickupTitle')}
            </h2>

            <div className="overflow-visible">
              {/* Desktop: arrows outside the card strip (not over the cards) */}
              <div className="mx-auto hidden w-full max-w-full items-center gap-2 px-1 sm:gap-3 md:flex lg:gap-4">
                {carouselItems.length > 1 && (
                  <button
                    type="button"
                    onClick={() => scroll("left")}
                    className="grid size-10 shrink-0 place-items-center rounded-full bg-white/95 text-slate-900 shadow-lg backdrop-blur-sm transition hover:scale-110 hover:bg-white"
                    aria-label="Previous"
                  >
                    <ChevronLeft className="size-5" />
                  </button>
                )}

                <div
                  ref={desktopScrollRef}
                  className="flex min-w-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden pb-6 scrollbar-hide"
                  style={{
                    WebkitOverflowScrolling: "touch",
                    scrollSnapType: "x mandatory",
                  }}
                >
                  {carouselItems.map((item, index) => (
                    <div
                      key={`${item.title}-${index}-desktop`}
                      className="w-[280px] min-w-[280px] shrink-0"
                      style={{ scrollSnapAlign: "start" }}
                    >
                      <HeroTourCard {...item} disableTracking={true} />
                    </div>
                  ))}
                </div>

                {carouselItems.length > 1 && (
                  <button
                    type="button"
                    onClick={() => scroll("right")}
                    className="grid size-10 shrink-0 place-items-center rounded-full bg-white/95 text-slate-900 shadow-lg backdrop-blur-sm transition hover:scale-110 hover:bg-white"
                    aria-label="Next"
                  >
                    <ChevronRight className="size-5" />
                  </button>
                )}
              </div>

              {/* Mobile carousel - finite scroll */}
              <div
                ref={scrollContainerRef}
                className="md:hidden overflow-x-auto scrollbar-hide pb-4 snap-x snap-mandatory"
                style={{
                  WebkitOverflowScrolling: 'touch'
                }}
              >
                <div className="flex gap-3 px-4">
                  {carouselItems.map((item, index) => (
                    <div
                      key={`${item.title}-${index}`}
                      className="w-[280px] shrink-0 snap-start"
                    >
                      <HeroTourCard {...item} disableTracking={true} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}