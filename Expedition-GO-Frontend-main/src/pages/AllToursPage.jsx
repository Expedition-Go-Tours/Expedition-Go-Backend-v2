import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, SlidersHorizontal, X, CircleCheck, Star, Heart } from "lucide-react";
import { Navbar } from "@/components/homepage/Navbar";
import { Footer } from "@/components/homepage/Footer";
import { TourCard } from "@/components/homepage/TourCard";
import { DestinationCard } from "@/components/homepage/DestinationCard";
import { Calendar } from "@/components/ui/calendar";
import {
  pickupTours,
  recommendedTours,
  topRatedTours,
  leisureTours,
  destinations,
  lastMinuteDeals,
  sidebarTopRated,
} from "@/components/homepage/data";
import { AuthModalProvider } from "@/contexts/AuthModalContext";
import { AuthModal } from "@/components/ui/auth-modal";
import { useAuthModal } from "@/contexts/AuthModalContext";
import { useWishlist } from "@/contexts/WishlistContext";
import { useCurrency } from "@/contexts/CurrencyContext";
import { ReviewsCarousel } from "@/components/homepage/ReviewsCarousel";

function MobileAllToursCard({ item, badge = "duration" }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { toggleWishlist, isInWishlist } = useWishlist();
  const { convertPrice } = useCurrency();
  const [showDescription, setShowDescription] = useState(false);
  const [touchStartX, setTouchStartX] = useState(null);
  /** After a horizontal swipe (show/hide description), block the synthetic click so the tour link does not fire. */
  const blockNextLinkClickRef = useRef(false);
  const isFavorited = isInWishlist(item.title);
  const detailTo = `/tour/${encodeURIComponent(item.title)}`;
  const convertedPrice = convertPrice(item.price);

  const descriptionText = `Visit the castles of cape coast and explore the adventures of Kakum National Park with this guided tour from Accra. You'll learn and discover the history of Cape Coast Castle and Elmina Castle and also undertake the canopy walkway experience at Kakum National Park.`;
  const showReadMore = descriptionText.length > 170;

  const handleTouchStart = (event) => {
    blockNextLinkClickRef.current = false;
    setTouchStartX(event.touches[0]?.clientX ?? null);
  };

  const handleTouchEnd = (event) => {
    if (touchStartX === null) return;
    const endX = event.changedTouches[0]?.clientX ?? touchStartX;
    const deltaX = endX - touchStartX;
    if (deltaX < -40) {
      setShowDescription(true);
      blockNextLinkClickRef.current = true;
    } else if (deltaX > 40) {
      setShowDescription(false);
      blockNextLinkClickRef.current = true;
    }
    setTouchStartX(null);
  };

  const handleDetailLinkClick = (e) => {
    if (blockNextLinkClickRef.current) {
      e.preventDefault();
      blockNextLinkClickRef.current = false;
    }
  };

  return (
    <article
      className="overflow-hidden rounded-md border border-slate-300 bg-white"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div
        className={`flex w-[200%] transition-transform duration-300 ease-out ${showDescription ? "-translate-x-1/2" : "translate-x-0"}`}
      >
        <div className="relative w-1/2">
          <Link
            to={detailTo}
            onClick={handleDetailLinkClick}
            aria-label={`${t("common.viewDetails", { defaultValue: "View details" })}: ${item.title}`}
            className="absolute inset-0 z-[5] rounded-md outline-none ring-inset focus-visible:ring-2 focus-visible:ring-slate-400"
          />
          <div className="flex h-[188px]">
            <div className="relative w-[38%] overflow-hidden">
              <img src={item.image} alt={item.title} className="h-full w-full object-cover" />
              <span
                className={
                  badge === "new"
                    ? "absolute left-2 top-2 rounded-md bg-white/95 px-2 py-1 text-[8px] font-bold text-slate-900 shadow-sm backdrop-blur-sm"
                    : "absolute left-2 top-2 rounded-md bg-slate-900/80 px-2 py-1 text-[8px] font-bold text-white shadow-sm"
                }
              >
                {badge === "new" ? t("sections.newBadge") : item.duration || "11 to 15 hours"}
              </span>
              <button
                type="button"
                onClick={() =>
                  toggleWishlist({
                    title: item.title,
                    duration: item.duration,
                    price: item.price,
                    rating: item.rating,
                    reviews: item.reviews,
                    image: item.image,
                    discount: item.discount,
                  })
                }
                className="absolute right-2 top-2 z-10 grid size-7 place-items-center rounded-full bg-white/92 text-slate-700 shadow"
              >
                <Heart className={`size-4 ${isFavorited ? "fill-[color:var(--brand-green)] text-[color:var(--brand-green)]" : ""}`} />
              </button>
            </div>

            <div className="flex h-full w-[62%] flex-col bg-slate-100/80 p-2.5">
              <span className="inline-flex rounded-full bg-[color:var(--brand-mint)] px-3 py-1 text-[10px] font-semibold text-[color:var(--brand-green)]">
                Best Seller
              </span>
              <h3 className="mt-2 line-clamp-3 font-semibold leading-4 text-slate-900" style={{ fontSize: 'clamp(0.8875rem, 0.7vw + 0.4rem, 0.8125rem)' }}>{item.title}</h3>
              <div className="mt-2.5 space-y-1.5 text-[10px] text-slate-900">
                <p className="flex items-center gap-2">
                  <CircleCheck className="size-4" />
                  {t("features.freeCancellation")}
                </p>
                <p className="flex items-center gap-2">
                  <CircleCheck className="size-4" />
                  {t("tourDetail.pickupIncluded")}
                </p>
              </div>
              <div className="mt-auto mb-1 flex items-end justify-between">
                <div className="flex items-center gap-1 text-slate-800">
                  <Star className="size-4 fill-current text-emerald-500" />
                  <span className="text-[12px] leading-none text-emerald-500">4.8</span>
                  <span className="text-[10px] text-slate-700">({item.reviews})</span>
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-slate-600">from</p>
                  <p className="text-[16px] font-bold leading-[0.95] text-slate-900">{convertedPrice.formatted}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="h-[188px] w-1/2 overflow-hidden bg-slate-100/60 p-3">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setShowDescription(false)}
              className="rounded p-1 text-slate-600"
              aria-label="Close description"
            >
              <X className="size-6" />
            </button>
          </div>
          <p className="mt-3 line-clamp-5 text-[11px] leading-5 text-slate-700">{descriptionText}</p>
          {showReadMore && (
            <button
              type="button"
              onClick={() => navigate(`/tour/${encodeURIComponent(item.title)}`)}
              className="mt-2 text-[11px] font-semibold text-slate-800 underline"
            >
              Read more
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function AllToursPageContent() {
  const CARDS_PER_PAGE = 8;
  const { t } = useTranslation();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const category = searchParams.get("category") || "all";
  const tourListBadge = category === "new-experiences" ? "new" : "duration";
  const initialSearch = searchParams.get("search") || "";

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [category]);
  const { isAuthModalOpen, closeAuthModal } = useAuthModal();
  const [sortBy, setSortBy] = useState("featured");
  const [searchQuery, setSearchQuery] = useState(initialSearch);

  const [appliedAdults, setAppliedAdults] = useState(2);
  const [appliedChildren, setAppliedChildren] = useState(0);
  const [appliedChildAges, setAppliedChildAges] = useState([]);

  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [childAges, setChildAges] = useState([]);

  const [showTravelers, setShowTravelers] = useState(false);
  const [selectedDates, setSelectedDates] = useState({ from: null, to: null });
  const [showDateCalendar, setShowDateCalendar] = useState(false);

  const [showTimeOfDayMenu, setShowTimeOfDayMenu] = useState(false);
  const [selectedTimeOfDay, setSelectedTimeOfDay] = useState("");

  const [showPriceMenu, setShowPriceMenu] = useState(false);
  const [priceMin, setPriceMin] = useState(0);
  const [priceMax, setPriceMax] = useState(500);

  const [showRatingMenu, setShowRatingMenu] = useState(false);
  const [selectedRating, setSelectedRating] = useState(null);
  const [selectedExperienceFilter, setSelectedExperienceFilter] = useState("All");
  const [canScrollFiltersLeft, setCanScrollFiltersLeft] = useState(false);
  const [canScrollFiltersRight, setCanScrollFiltersRight] = useState(false);
  const experienceFiltersRef = useRef(null);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  const adultsTriggerRef = useRef(null);
  const travelersPanelRef = useRef(null);
  const [travelersPanelPosition, setTravelersPanelPosition] = useState({ top: 0, left: 0 });

  const desktopDateTriggerRef = useRef(null);
  const mobileDateTriggerRef = useRef(null);
  const dateCalendarRef = useRef(null);
  const [calendarPosition, setCalendarPosition] = useState({ top: 0, left: 0 });

  const timeTriggerRef = useRef(null);
  const timeMenuRef = useRef(null);
  const [timeMenuPosition, setTimeMenuPosition] = useState({ top: 0, left: 0 });

  const priceTriggerRef = useRef(null);
  const priceMenuRef = useRef(null);
  const [priceMenuPosition, setPriceMenuPosition] = useState({ top: 0, left: 0 });

  const ratingTriggerRef = useRef(null);
  const ratingMenuRef = useRef(null);
  const [ratingMenuPosition, setRatingMenuPosition] = useState({ top: 0, left: 0 });

  const sidebarNewExperiences = [...sidebarTopRated, ...sidebarTopRated.slice(0, 2)];

  const categoryMap = {
    tours: { title: t("sections.featuredTitle"), items: pickupTours, type: "tours" },
    recommended: { title: t("sections.recommendedTitle"), items: recommendedTours, type: "tours" },
    deals: { title: t("sections.topRatedTitle"), items: topRatedTours, type: "tours" },
    leisure: { title: t("sections.likelyToSellOut"), items: leisureTours, type: "tours" },
    "last-minute-deals": { title: t("sections.lastMinuteDeals"), items: lastMinuteDeals, type: "tours" },
    "new-experiences": { title: t("sections.newExperiences"), items: sidebarNewExperiences, type: "tours" },
    destinations: { title: t("sections.destinations"), items: destinations, type: "destinations" },
    all: { title: t("sections.allToursTitle", { defaultValue: "All Tours" }), items: [...pickupTours, ...recommendedTours, ...topRatedTours, ...leisureTours], type: "tours" },
  };
  const experienceFilters = [
    "All",
    "Multi-day",
    "Day trips",
    "Plantations & farms",
    "Quads & ATVs",
    "Monkeys",
    "Cooking classes",
    "African-American heritage",
    "Wellness & spas",
    "Safaris & wildlife",
    "Jungle",
    "Canopy walks",
    "Boat cruises",
    "Waterfalls",
    "Prohibition",
    "Bus tours",
  ];

  const { title, items, type } = categoryMap[category] || categoryMap.all;
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const getExperienceKeywords = (filterLabel) => {
    const map = {
      "multi-day": ["expedition", "safari", "adventure", "heritage"],
      "day trips": ["city", "tour", "castle", "coast", "waterfall", "park"],
      "plantations & farms": ["farm", "cocoa", "plantation"],
      "quads & atvs": ["atv", "quad"],
      monkeys: ["monkey", "forest", "wildlife"],
      "cooking classes": ["cooking", "food", "culinary"],
      "african-american heritage": ["heritage", "history", "castle", "museum"],
    };

    return map[filterLabel.toLowerCase()] || [];
  };

  const matchesExperienceFilter = (item) => {
    if (selectedExperienceFilter === "All") return true;
    const keywords = getExperienceKeywords(selectedExperienceFilter);
    if (!keywords.length) return true;
    const haystack = Object.values(item)
      .filter((value) => typeof value === "string")
      .join(" ")
      .toLowerCase();
    return keywords.some((keyword) => haystack.includes(keyword));
  };

  const filteredItems = items.filter((item) => {
    const matchesSearch =
      !normalizedQuery ||
      Object.values(item).some((value) =>
        typeof value === "string" ? value.toLowerCase().includes(normalizedQuery) : false
      );
    return matchesSearch && matchesExperienceFilter(item);
  });
  const totalPages = Math.max(1, Math.ceil(filteredItems.length / CARDS_PER_PAGE));
  const paginatedItems = filteredItems.slice(
    (currentPage - 1) * CARDS_PER_PAGE,
    currentPage * CARDS_PER_PAGE
  );

  useEffect(() => {
    const handleClickOutside = (event) => {
      const clickedDesktopDateTrigger = desktopDateTriggerRef.current?.contains(event.target);
      const clickedMobileDateTrigger = mobileDateTriggerRef.current?.contains(event.target);
      const clickedDateCalendar = dateCalendarRef.current?.contains(event.target);
      const clickedAdultsTrigger = adultsTriggerRef.current?.contains(event.target);
      const clickedTravelersPanel = travelersPanelRef.current?.contains(event.target);

      const clickedTimeTrigger = timeTriggerRef.current?.contains(event.target);
      const clickedTimeMenu = timeMenuRef.current?.contains(event.target);
      const clickedPriceTrigger = priceTriggerRef.current?.contains(event.target);
      const clickedPriceMenu = priceMenuRef.current?.contains(event.target);
      const clickedRatingTrigger = ratingTriggerRef.current?.contains(event.target);
      const clickedRatingMenu = ratingMenuRef.current?.contains(event.target);

      if (!clickedDesktopDateTrigger && !clickedMobileDateTrigger && !clickedDateCalendar) setShowDateCalendar(false);
      if (!clickedAdultsTrigger && !clickedTravelersPanel) setShowTravelers(false);
      if (!clickedTimeTrigger && !clickedTimeMenu) setShowTimeOfDayMenu(false);
      if (!clickedPriceTrigger && !clickedPriceMenu) setShowPriceMenu(false);
      if (!clickedRatingTrigger && !clickedRatingMenu) setShowRatingMenu(false);
    };

    if (showDateCalendar || showTravelers || showTimeOfDayMenu || showPriceMenu || showRatingMenu) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showDateCalendar, showTravelers, showTimeOfDayMenu, showPriceMenu, showRatingMenu]);

  const formatDate = (date) => {
    if (!date) return "";
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const dateLabel = selectedDates?.from
    ? selectedDates?.to
      ? `${formatDate(selectedDates.from)} - ${formatDate(selectedDates.to)}`
      : `${formatDate(selectedDates.from)}`
    : "";

  const toggleDateCalendar = () => {
    const activeDateTrigger = window.innerWidth >= 768 ? desktopDateTriggerRef.current : mobileDateTriggerRef.current;
    if (!showDateCalendar && activeDateTrigger) {
      const rect = activeDateTrigger.getBoundingClientRect();
      setCalendarPosition({ top: rect.bottom + 8, left: rect.left });
    }
    setShowDateCalendar((value) => !value);
  };

  const toggleTravelersPanel = () => {
    if (!showTravelers && adultsTriggerRef.current) {
      const rect = adultsTriggerRef.current.getBoundingClientRect();
      setTravelersPanelPosition({ top: rect.bottom + 8, left: rect.left });
      setAdults(appliedAdults);
      setChildren(appliedChildren);
      setChildAges(Array.from({ length: appliedChildren }, (_, index) => appliedChildAges[index] ?? 7));
    }
    setShowTravelers((value) => !value);
  };

  const toggleTimeOfDayMenu = () => {
    if (!showTimeOfDayMenu && timeTriggerRef.current) {
      const rect = timeTriggerRef.current.getBoundingClientRect();
      setTimeMenuPosition({ top: rect.bottom + 8, left: rect.left });
    }
    setShowTimeOfDayMenu((value) => !value);
  };

  const togglePriceMenu = () => {
    if (!showPriceMenu && priceTriggerRef.current) {
      const rect = priceTriggerRef.current.getBoundingClientRect();
      setPriceMenuPosition({ top: rect.bottom + 8, left: rect.left });
    }
    setShowPriceMenu((value) => !value);
  };

  const toggleRatingMenu = () => {
    if (!showRatingMenu && ratingTriggerRef.current) {
      const rect = ratingTriggerRef.current.getBoundingClientRect();
      setRatingMenuPosition({ top: rect.bottom + 8, left: rect.left });
    }
    setShowRatingMenu((value) => !value);
  };

  const totalTravelers = adults + children;
  const canAddTraveler = totalTravelers < 15;
  const travelerLabel =
    appliedChildren > 0
      ? `${appliedAdults} Adult${appliedAdults === 1 ? "" : "s"}, ${appliedChildren} Child${appliedChildren === 1 ? "" : "ren"}`
      : `${appliedAdults} Adult${appliedAdults === 1 ? "" : "s"}`;

  const setChildrenCount = (nextChildren) => {
    const safeChildren = Math.max(0, nextChildren);
    setChildren(safeChildren);
    setChildAges((prev) => {
      if (safeChildren <= prev.length) return prev.slice(0, safeChildren);
      return [...prev, ...Array.from({ length: safeChildren - prev.length }, () => 7)];
    });
  };

  const timeOfDayLabel = selectedTimeOfDay || "Time of Day";
  const priceLabel = priceMin === 0 && priceMax === 500 ? "Price" : `$${priceMin} - $${priceMax}${priceMax === 500 ? "+" : ""}`;
  const ratingLabel = selectedRating ? `${selectedRating}+ Stars` : "Rating";

  const handleMinPriceChange = (value) => {
    const nextMin = Math.min(value, priceMax - 10);
    setPriceMin(nextMin);
  };

  const handleMaxPriceChange = (value) => {
    const nextMax = Math.max(value, priceMin + 10);
    setPriceMax(nextMax);
  };

  const renderStars = (filled) => {
    const stars = [];
    for (let i = 1; i <= 5; i += 1) {
      if (i <= filled) {
        stars.push(<span key={`star-${filled}-${i}`}>⭐</span>);
      }
    }
    return stars;
  };

  const updateFilterArrows = () => {
    const container = experienceFiltersRef.current;
    if (!container) return;
    const maxLeft = container.scrollWidth - container.clientWidth;
    setCanScrollFiltersLeft(container.scrollLeft > 2);
    setCanScrollFiltersRight(maxLeft > 2 && container.scrollLeft < maxLeft - 2);
  };

  const scrollExperienceFilters = (direction) => {
    const container = experienceFiltersRef.current;
    if (!container) return;
    const amount = 220;
    container.scrollBy({
      left: direction === "left" ? -amount : amount,
      behavior: "smooth",
    });
    requestAnimationFrame(updateFilterArrows);
    setTimeout(updateFilterArrows, 220);
  };
  useEffect(() => {
    const container = experienceFiltersRef.current;
    if (!container) return;

    updateFilterArrows();
    container.addEventListener("scroll", updateFilterArrows, { passive: true });
    window.addEventListener("resize", updateFilterArrows);

    return () => {
      container.removeEventListener("scroll", updateFilterArrows);
      window.removeEventListener("resize", updateFilterArrows);
    };
  }, [experienceFilters.length, category]);

  useEffect(() => {
    const container = experienceFiltersRef.current;
    if (!container) return;
    if (selectedExperienceFilter === "All") {
      container.scrollTo({ left: 0, behavior: "smooth" });
    }
    const frameId = requestAnimationFrame(updateFilterArrows);

    return () => cancelAnimationFrame(frameId);
  }, [selectedExperienceFilter]);

  useEffect(() => {
    const toggleBackToTop = () => {
      setShowBackToTop(window.scrollY > 320);
    };

    toggleBackToTop();
    window.addEventListener("scroll", toggleBackToTop, { passive: true });

    return () => {
      window.removeEventListener("scroll", toggleBackToTop);
    };
  }, []);

  const handleBackToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  useEffect(() => {
    setCurrentPage(1);
  }, [category, searchQuery, selectedExperienceFilter]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  return (
    <>
      <div className="flex min-h-screen flex-col">
        {/* Navbar - visible on all screens */}
        <div className="bg-white text-slate-900">
          <Navbar
            forceShowCompactSearch={true}
            externalSearchQuery={searchQuery}
            onExternalSearchChange={setSearchQuery}
          />
        </div>
        
        {/* Navbar spacer */}
        <div className="h-[76px] sm:h-[104px] md:h-[120px] lg:h-[116px]" />

        <main className="mx-auto flex-1 w-full max-w-[1520px] overflow-x-hidden bg-white px-4 pt-2 pb-6 sm:px-6 lg:px-8 lg:py-6">
          <div className="mb-8 mt-4">
            <Link
              to="/"
              className="mb-3 inline-flex items-center gap-2 text-sm font-medium !text-slate-900 transition hover:!text-[color:var(--brand-green)] sm:mb-4"
            >
              <ArrowLeft className="size-4" />
              Back To Home
            </Link>
            <h1 className="font-bold tracking-tight text-slate-900" style={{ fontSize: 'clamp(1.75rem, 3vw + 0.5rem, 2.75rem)' }}>{title}</h1>
          </div>

          <div className="w-full">
            {category !== "destinations" && (
              <div className="mb-6 overflow-y-visible pb-1">
                <div className="flex w-full items-center gap-2 overflow-x-auto pb-1 scrollbar-hide overscroll-x-contain lg:min-w-0 lg:overflow-visible lg:pb-0">
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-2 rounded-full border border-slate-300 bg-slate-50 px-4 py-2.5 text-sm font-medium text-slate-900 transition hover:bg-slate-100"
                  >
                    <SlidersHorizontal className="size-4" />
                    <span>Filter</span>
                  </button>

                  <div className="relative">
                    <button
                      ref={desktopDateTriggerRef}
                      onClick={toggleDateCalendar}
                      className="hidden items-center gap-2 rounded-full border border-slate-300 bg-slate-50 px-4 py-2.5 text-sm font-medium text-slate-900 transition hover:bg-slate-100 lg:inline-flex"
                    >
                      <CalendarDays className="size-4" />
                      <span>{dateLabel ? `Date ${dateLabel}` : "Date"}</span>
                    </button>
                  </div>

                  <button
                    ref={adultsTriggerRef}
                    onClick={toggleTravelersPanel}
                    className="inline-flex shrink-0 items-center gap-2 rounded-full border border-slate-900 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 transition hover:bg-slate-50"
                  >
                    <span>{travelerLabel}</span>
                    <ChevronDown className="size-4" />
                  </button>

                  <button
                    ref={timeTriggerRef}
                    onClick={toggleTimeOfDayMenu}
                    className="inline-flex shrink-0 items-center gap-2 rounded-full border border-slate-300 bg-slate-50 px-4 py-2.5 text-sm font-medium text-slate-900 transition hover:bg-slate-100"
                  >
                    <span>{timeOfDayLabel}</span>
                    <ChevronDown className="size-4" />
                  </button>

                  <button
                    ref={priceTriggerRef}
                    onClick={togglePriceMenu}
                    className="inline-flex shrink-0 items-center gap-2 rounded-full border border-slate-300 bg-slate-50 px-4 py-2.5 text-sm font-medium text-slate-900 transition hover:bg-slate-100"
                  >
                    <span>{priceLabel}</span>
                    <ChevronDown className="size-4" />
                  </button>

                  <button
                    ref={ratingTriggerRef}
                    onClick={toggleRatingMenu}
                    className="inline-flex shrink-0 items-center gap-2 rounded-full border border-slate-300 bg-slate-50 px-4 py-2.5 text-sm font-medium text-slate-900 transition hover:bg-slate-100"
                  >
                    <span>{ratingLabel}</span>
                    <ChevronDown className="size-4" />
                  </button>

                  <span className="mx-1 h-8 w-px shrink-0 bg-slate-300" aria-hidden="true" />

                  <button
                    type="button"
                    onClick={() => scrollExperienceFilters("left")}
                    disabled={!canScrollFiltersLeft}
                    className="hidden lg:grid size-9 shrink-0 place-items-center rounded-full border border-slate-300 bg-slate-50 text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Scroll filters left"
                  >
                    <ChevronLeft className="size-4" />
                  </button>

                  <div
                    ref={experienceFiltersRef}
                    className="flex shrink-0 items-center gap-2 lg:w-0 lg:flex-1 lg:shrink lg:overflow-x-auto lg:overscroll-x-contain lg:[scrollbar-width:none] lg:[-ms-overflow-style:none] lg:[&::-webkit-scrollbar]:hidden"
                  >
                    {experienceFilters.map((filterLabel) => {
                      const isActive = selectedExperienceFilter === filterLabel;
                      return (
                        <button
                          key={filterLabel}
                          type="button"
                          onClick={() => {
                            setSelectedExperienceFilter(filterLabel);
                            requestAnimationFrame(updateFilterArrows);
                          }}
                          className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition ${
                            isActive
                              ? "bg-slate-900 text-white"
                              : "bg-slate-100 text-slate-900 hover:bg-slate-200"
                          }`}
                        >
                          {filterLabel}
                        </button>
                      );
                    })}
                  </div>

                  <button
                    type="button"
                    onClick={() => scrollExperienceFilters("right")}
                    disabled={!canScrollFiltersRight}
                    className="hidden lg:grid size-9 shrink-0 place-items-center rounded-full border border-slate-300 bg-slate-50 text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Scroll filters right"
                  >
                    <ChevronRight className="size-4" />
                  </button>

                </div>
              </div>
            )}

            <div className="mb-6 flex items-center justify-between border-b border-slate-200 pb-4">
              <p className="text-sm font-medium text-slate-600">
                {filteredItems.length} {type === "destinations" ? t("common.destinations") : t("common.tours")} available
              </p>
              <div className="flex items-center gap-3">
                <span className="text-sm text-slate-600">Sort by:</span>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="rounded px-3 py-2 text-sm font-medium text-slate-900 outline-none"
                >
                  <option value="featured">Featured</option>
                  <option value="price-low">Price: Low to High</option>
                  <option value="price-high">Price: High to Low</option>
                  <option value="rating">Highest Rated</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 pb-2 sm:pb-0 sm:gap-x-1.5 sm:gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {paginatedItems.map((item, index) =>
                type === "destinations" ? (
                  <div key={`${item.title}-${index}`} className="w-full">
                    <DestinationCard {...item} variant="allTours" />
                  </div>
                ) : (
                  <div key={`${item.title}-${index}`} className="w-full">
                    <div className="sm:hidden">
                      <MobileAllToursCard item={item} badge={tourListBadge} />
                    </div>
                    <div className="hidden sm:block">
                      <TourCard {...item} variant="allTours" badge={tourListBadge} />
                    </div>
                  </div>
                )
              )}
            </div>
            {totalPages > 1 && (
              <div className="mt-6 flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setCurrentPage((value) => Math.max(1, value - 1))}
                  disabled={currentPage === 1}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Prev
                </button>
                <span className="text-sm font-medium text-slate-700">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setCurrentPage((value) => Math.min(totalPages, value + 1))}
                  disabled={currentPage === totalPages}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}

            <ReviewsCarousel />
          </div>
        </main>

        <Footer />
      </div>

      {showDateCalendar && (
        <div
          ref={dateCalendarRef}
          className="fixed z-[250]"
          style={{ top: `${calendarPosition.top}px`, left: `${calendarPosition.left}px` }}
        >
          <Calendar
            mode="range"
            selected={selectedDates}
            onSelect={setSelectedDates}
            onClose={() => setShowDateCalendar(false)}
          />
        </div>
      )}

      {showTimeOfDayMenu && (
        <div
          ref={timeMenuRef}
          className="fixed z-[250] w-[210px] rounded-2xl border border-slate-200 bg-white p-2 shadow-xl"
          style={{ top: `${timeMenuPosition.top}px`, left: `${timeMenuPosition.left}px` }}
        >
          {["Morning", "Afternoon", "Evening"].map((option) => (
            <button
              key={option}
              onClick={() => {
                setSelectedTimeOfDay(option);
                setShowTimeOfDayMenu(false);
              }}
              className="block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-900 transition hover:bg-slate-100"
            >
              {option}
            </button>
          ))}
        </div>
      )}

      {showPriceMenu && (
        <div
          ref={priceMenuRef}
          className="fixed z-[250] w-[420px] rounded-2xl border border-slate-200 bg-white p-4 shadow-xl"
          style={{ top: `${priceMenuPosition.top}px`, left: `${priceMenuPosition.left}px` }}
        >
          <p className="text-2xl font-semibold text-slate-900">Price</p>
          <div className="mt-4 flex items-center justify-between text-3xl font-medium text-slate-900">
            <span>${priceMin}</span>
            <span>${priceMax}{priceMax === 500 ? "+" : ""}</span>
          </div>
          <div className="relative mt-4 h-10">
            <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-slate-200" />
            <div
              className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-slate-900"
              style={{ left: `${(priceMin / 500) * 100}%`, right: `${100 - (priceMax / 500) * 100}%` }}
            />
            <input
              type="range"
              min="0"
              max="500"
              value={priceMin}
              onChange={(e) => handleMinPriceChange(Number(e.target.value))}
              className="pointer-events-none absolute h-10 w-full appearance-none bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:size-6 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-slate-300 [&::-webkit-slider-thumb]:bg-white"
            />
            <input
              type="range"
              min="0"
              max="500"
              value={priceMax}
              onChange={(e) => handleMaxPriceChange(Number(e.target.value))}
              className="pointer-events-none absolute h-10 w-full appearance-none bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:size-6 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-slate-300 [&::-webkit-slider-thumb]:bg-white"
            />
          </div>
          <div className="mt-4 border-t border-slate-200" />
        </div>
      )}

      {showRatingMenu && (
        <div
          ref={ratingMenuRef}
          className="fixed z-[250] w-[360px] rounded-2xl border border-slate-200 bg-white p-4 shadow-xl"
          style={{ top: `${ratingMenuPosition.top}px`, left: `${ratingMenuPosition.left}px` }}
        >
          <p className="text-2xl font-semibold text-slate-900">Rating</p>
          <div className="mt-4 grid grid-cols-1 gap-2">
            {[5, 4, 3].map((rating) => (
              <button
                key={rating}
                onClick={() => {
                  setSelectedRating(rating);
                  setShowRatingMenu(false);
                }}
                className={`flex items-center gap-3 rounded-lg p-2 text-left transition hover:bg-slate-50 ${
                  selectedRating === rating ? "bg-slate-50" : ""
                }`}
              >
                <span className="text-2xl leading-none tracking-wide">{renderStars(rating)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {showTravelers && (
        <div
          ref={travelersPanelRef}
          className="fixed z-[250] w-[340px] rounded-2xl border border-slate-200 bg-white p-4 shadow-xl"
          style={{ top: `${travelersPanelPosition.top}px`, left: `${travelersPanelPosition.left}px` }}
        >
          <p className="text-sm text-slate-700">You can select up to 15 travelers in total.</p>

          <div className="mt-5 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-2xl font-semibold text-slate-900">Adult (18+)</p>
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setAdults((value) => Math.max(1, value - 1))}
                  className="grid size-8 place-items-center rounded-lg text-slate-600 transition hover:bg-slate-100"
                  aria-label="Decrease adults"
                >
                  <span className="text-xl leading-none">-</span>
                </button>
                <span className="w-6 text-center text-xl font-semibold text-slate-900">{adults}</span>
                <button
                  onClick={() => canAddTraveler && setAdults((value) => value + 1)}
                  className="grid size-8 place-items-center rounded-lg text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="Increase adults"
                  disabled={!canAddTraveler}
                >
                  <span className="text-xl leading-none">+</span>
                </button>
              </div>
            </div>

            <div className="border-t border-slate-200 pt-4">
              <div className="flex items-center justify-between">
                <p className="text-2xl font-semibold text-slate-900">Child (0-17)</p>
                <div className="flex items-center gap-4">
                  <button
                    onClick={() => setChildrenCount(children - 1)}
                    className="grid size-8 place-items-center rounded-lg text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Decrease children"
                    disabled={children === 0}
                  >
                    <span className="text-xl leading-none">-</span>
                  </button>
                  <span className="w-6 text-center text-xl font-semibold text-slate-900">{children}</span>
                  <button
                    onClick={() => canAddTraveler && setChildrenCount(children + 1)}
                    className="grid size-8 place-items-center rounded-lg text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Increase children"
                    disabled={!canAddTraveler}
                  >
                    <span className="text-xl leading-none">+</span>
                  </button>
                </div>
              </div>
            </div>

            {children > 0 && (
              <div className="border-t border-slate-200 pt-4">
                <p className="mb-3 text-sm font-medium text-slate-700">Child age(s)</p>
                <div className="grid grid-cols-2 gap-2">
                  {Array.from({ length: children }).map((_, index) => (
                    <label key={`child-age-${index}`} className="text-xs text-slate-600">
                      Child {index + 1}
                      <select
                        value={childAges[index] ?? 7}
                        onChange={(e) => {
                          const age = Number(e.target.value);
                          setChildAges((prev) => {
                            const next = [...prev];
                            next[index] = age;
                            return next;
                          });
                        }}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
                      >
                        {Array.from({ length: 18 }).map((__, age) => (
                          <option key={`age-${age}`} value={age}>
                            {age} years
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="mt-6 flex gap-3">
            <button
              onClick={() => {
                setAdults(1);
                setChildren(0);
                setChildAges([]);
              }}
              className="flex-1 rounded-xl border border-slate-900 px-4 py-2.5 text-lg font-semibold text-slate-900 transition hover:bg-slate-50"
            >
              Reset
            </button>
            <button
              onClick={() => {
                setAppliedAdults(adults);
                setAppliedChildren(children);
                setAppliedChildAges(childAges.slice(0, children));
                setShowTravelers(false);
              }}
              className="flex-1 rounded-xl border border-slate-900 px-4 py-2.5 text-lg font-semibold text-slate-900 transition hover:bg-slate-50"
            >
              Apply
            </button>
          </div>
        </div>
      )}

      <AuthModal isOpen={isAuthModalOpen} onClose={closeAuthModal} />

      {showBackToTop && (
        <button
          type="button"
          onClick={handleBackToTop}
          className="fixed bottom-6 right-6 z-[260] grid size-11 place-items-center rounded-full bg-slate-900 text-white shadow-lg transition hover:bg-slate-800"
          aria-label="Back to top"
        >
          <ChevronUp className="size-5" />
        </button>
      )}
    </>
  );
}

function AllToursPage() {
  return (
    <AuthModalProvider>
      <AllToursPageContent />
    </AuthModalProvider>
  );
}

export default AllToursPage;
