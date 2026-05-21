import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { 
  ArrowLeft, 
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Clock,
  Star, 
  Heart,
  Info,
  Check,
  X,
  Languages,
  Minus,
  Plus,
  Truck,
  Users,
  MapPin,
  Share2,
  Grid3X3,
  MessageSquare,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { Navbar } from "@/components/homepage/Navbar";
import { Footer } from "@/components/homepage/Footer";
import { SimilarExperiencesCarousel } from "@/components/tour-detail/SimilarExperiencesCarousel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AuthModalProvider } from "@/contexts/AuthModalContext";
import { RecentlyViewedProvider, useRecentlyViewed } from "@/contexts/RecentlyViewedContext";
import { useWishlist } from "@/contexts/WishlistContext";
import { useCurrency } from "@/contexts/CurrencyContext";
import { useCart } from "@/contexts/CartContext";
import { getTourByTitle } from "@/lib/tourData";
import { loadTawkScript, openTawkChat } from "@/lib/tawk";
import fallbackTourImage from "@/assets/images/hero_pic.jpg";

const EXTERNAL_FALLBACK_IMAGES = [
  "https://ecotourghana.com/img/n10.jpg",
  "https://grassroottours.com/wp-content/uploads/2019/04/IMG_5843-370x260.jpg",
  "https://images.squarespace-cdn.com/content/v1/65cfd1369377d32bcd0051fa/1713964352006-GG68CSEC76Z06G1JZBFQ/Accra+City+Tour-+Sheeda+Travel+Tribe.jpg",
  "https://images.squarespace-cdn.com/content/v1/65cfd1369377d32bcd0051fa/f0eaf879-3685-41fb-ba88-5fbab02dda4a/Travel+to+Ghana-+Sheeda+Travel+Tribe.jpg",
  "https://www.outlooktravelmag.com/media/ghana-1-1582212936.profileImage.2x-jpg-webp.webp",
];

const normalizeImageKey = (imageUrl) =>
  String(imageUrl || "")
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "")
    .toLowerCase();

const dedupeImages = (imageUrls) => {
  const seen = new Set();
  return imageUrls.filter((url) => {
    const key = normalizeImageKey(url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const safeDecodeRouteParam = (value) => {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const TOUR_DETAIL_TABS = [
  { key: "overview", label: "Overview" },
  { key: "details", label: "Details" },
  { key: "itinerary", label: "Itinerary" },
  { key: "reviews", label: "Reviews" },
];

const getDateKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const parseDateKey = (value) => {
  const parts = String(value || "").split("-");
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return new Date(y, m - 1, d);
};

const isSameCalendarDay = (firstDate, secondDate) => (
  firstDate &&
  secondDate &&
  firstDate.getFullYear() === secondDate.getFullYear() &&
  firstDate.getMonth() === secondDate.getMonth() &&
  firstDate.getDate() === secondDate.getDate()
);

const startOfLocalDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

const normalizeBookingRange = (a, b) => {
  const start = startOfLocalDay(a);
  const end = startOfLocalDay(b);
  return start.getTime() <= end.getTime() ? { start, end } : { start: end, end: start };
};

const dayTime = (date) => startOfLocalDay(date).getTime();

const isDayInInclusiveRange = (day, rangeStart, rangeEnd) => {
  if (!rangeStart || !rangeEnd) return false;
  const t = dayTime(day);
  const lo = Math.min(dayTime(rangeStart), dayTime(rangeEnd));
  const hi = Math.max(dayTime(rangeStart), dayTime(rangeEnd));
  return t >= lo && t <= hi;
};

const parseReviewCount = (value) => {
  if (typeof value === "number") return value;
  const parsed = Number.parseInt(String(value || "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

const buildReviewBreakdown = (rating, reviewCount) => {
  const labels = [
    { label: "5 stars", stars: 5 },
    { label: "4 stars", stars: 4 },
    { label: "3 stars", stars: 3 },
    { label: "2 stars", stars: 2 },
    { label: "1 star", stars: 1 },
  ];

  if (!reviewCount) {
    return labels.map((item) => ({ ...item, count: 0, percentage: 0 }));
  }

  const weights = labels.map(({ stars }) => Math.max(0.01, Math.pow(Math.max(0, 1 - Math.abs(rating - stars) / 4), 6)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const counts = weights.map((weight) => Math.round((weight / totalWeight) * reviewCount));
  const countDifference = reviewCount - counts.reduce((sum, count) => sum + count, 0);
  counts[0] += countDifference;

  return labels.map((item, index) => ({
    ...item,
    count: counts[index],
    percentage: Math.round((counts[index] / reviewCount) * 100),
  }));
};

function BookingCalendarPopover({
  monthCursor,
  onMonthChange,
  onCommitRange,
  selectedRange,
  today,
}) {
  const [dragRedraw, setDragRedraw] = useState(0);
  const dragActiveRef = useRef(false);
  const anchorRef = useRef(null);
  const hoverRef = useRef(null);
  const gridRef = useRef(null);
  const captureIdRef = useRef(null);

  const todayStart = startOfLocalDay(today);
  const monthDate = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);

  const monthDays = useMemo(() => {
    const year = monthCursor.getFullYear();
    const month = monthCursor.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPreviousMonth = new Date(year, month, 0).getDate();
    const days = [];

    for (let index = firstDay - 1; index >= 0; index -= 1) {
      days.push({
        date: new Date(year, month - 1, daysInPreviousMonth - index),
        isCurrentMonth: false,
      });
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      days.push({
        date: new Date(year, month, day),
        isCurrentMonth: true,
      });
    }

    while (days.length % 7 !== 0) {
      const day = days.length - firstDay - daysInMonth + 1;
      days.push({
        date: new Date(year, month + 1, day),
        isCurrentMonth: false,
      });
    }

    return days;
  }, [monthCursor.getFullYear(), monthCursor.getMonth()]);

  const updateHoverFromClientPoint = (clientX, clientY) => {
    const el = document.elementFromPoint(clientX, clientY);
    const node = el?.closest?.("[data-cal-selectable]");
    if (!node || !gridRef.current?.contains(node)) return;
    const parsed = parseDateKey(node.getAttribute("data-cal-day"));
    if (!parsed || startOfLocalDay(parsed) < todayStart) return;
    hoverRef.current = parsed;
    setDragRedraw((n) => n + 1);
  };

  const bump = () => setDragRedraw((n) => n + 1);

  const liveRange = useMemo(() => {
    if (dragActiveRef.current && anchorRef.current) {
      const hover = hoverRef.current ?? anchorRef.current;
      return normalizeBookingRange(anchorRef.current, hover);
    }
    return selectedRange ?? null;
  }, [selectedRange, dragRedraw]);

  useEffect(() => {
    const finish = (event) => {
      if (!dragActiveRef.current) return;
      if (event.type === "pointerup" && event.button !== 0) return;
      if (gridRef.current && captureIdRef.current != null) {
        try {
          gridRef.current.releasePointerCapture(captureIdRef.current);
        } catch {
          // Already released or target detached.
        }
        captureIdRef.current = null;
      }
      const anchor = anchorRef.current;
      const hover = hoverRef.current ?? anchorRef.current;
      dragActiveRef.current = false;
      anchorRef.current = null;
      hoverRef.current = null;
      bump();
      if (anchor && hover) onCommitRange(anchor, hover);
    };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [onCommitRange]);

  const handlePrevMonth = () => {
    onMonthChange(new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1));
  };

  const handleNextMonth = () => {
    onMonthChange(new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1));
  };

  return (
    <div className="absolute left-1/2 top-[calc(100%+0.75rem)] z-50 w-[min(640px,100%,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-slate-200/80 bg-white p-5 text-slate-900 shadow-[0_18px_45px_rgba(15,23,42,0.12)] select-none">
      <div className="min-w-0">
        <div className="mb-4 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={handlePrevMonth}
            className="grid size-8 shrink-0 place-items-center rounded-full text-slate-700 transition hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brand-green)]"
            aria-label="Previous month"
          >
            <ChevronLeft className="size-5" />
          </button>
          <h3 className="min-w-0 flex-1 truncate text-center text-base font-bold text-slate-900">
            {MONTH_NAMES[monthDate.getMonth()]} {monthDate.getFullYear()}
          </h3>
          <button
            type="button"
            onClick={handleNextMonth}
            className="grid size-8 shrink-0 place-items-center rounded-full text-slate-700 transition hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brand-green)]"
            aria-label="Next month"
          >
            <ChevronRight className="size-5" />
          </button>
        </div>

        <div className="mb-2 grid grid-cols-7 gap-y-1 text-center text-[11px] font-medium text-slate-500">
          {WEEKDAY_LABELS.map((day, index) => (
            <span key={`${day}-${index}`}>{day}</span>
          ))}
        </div>
        <div
          ref={gridRef}
          className="grid grid-cols-7 gap-y-1 touch-none text-center"
          onPointerMove={(e) => {
            if (!dragActiveRef.current) return;
            updateHoverFromClientPoint(e.clientX, e.clientY);
          }}
        >
          {monthDays.map(({ date, isCurrentMonth }) => {
            const isUnavailable = !isCurrentMonth || date < todayStart;
            const range = liveRange;
            const inRange = range ? isDayInInclusiveRange(date, range.start, range.end) : false;
            const t = dayTime(date);
            const lo = range ? Math.min(dayTime(range.start), dayTime(range.end)) : null;
            const hi = range ? Math.max(dayTime(range.start), dayTime(range.end)) : null;
            const multiDay = Boolean(range && lo !== hi);
            const isLow = range && t === lo;
            const isHigh = range && t === hi;
            const isMiddle = Boolean(multiDay && inRange && !isLow && !isHigh);
            const isEndpointBubble = Boolean(inRange && !isMiddle);

            return (
              <button
                key={`${monthDate.getFullYear()}-${monthDate.getMonth()}-${getDateKey(date)}`}
                type="button"
                tabIndex={isUnavailable ? -1 : 0}
                aria-disabled={isUnavailable}
                className={`relative mx-auto flex size-9 items-center justify-center text-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brand-green)] ${
                  isUnavailable ? "cursor-not-allowed text-slate-400" : "font-medium text-slate-900"
                } ${!isUnavailable ? "hover:bg-slate-100" : ""} `}
                {...(isUnavailable
                  ? { disabled: true }
                  : {
                      "data-cal-selectable": true,
                      "data-cal-day": getDateKey(date),
                      onPointerDown: (e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        dragActiveRef.current = true;
                        anchorRef.current = date;
                        hoverRef.current = date;
                        if (gridRef.current != null && typeof e.pointerId === "number") {
                          try {
                            gridRef.current.setPointerCapture(e.pointerId);
                            captureIdRef.current = e.pointerId;
                          } catch {
                            captureIdRef.current = null;
                          }
                        }
                        bump();
                      },
                      onPointerEnter: () => {
                        if (!dragActiveRef.current) return;
                        hoverRef.current = date;
                        bump();
                      },
                    })}
              >
                {isMiddle ? (
                  <span className="pointer-events-none absolute inset-y-px left-0 right-0 bg-emerald-100" aria-hidden />
                ) : null}
                <span
                  className={`relative z-[1] grid size-9 place-items-center rounded-md ${
                    isEndpointBubble ? "bg-[color:var(--brand-green)] font-semibold text-white" : ""
                  }`}
                >
                  {date.getDate()}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Mock data - In production, this would come from an API
const tourData = {
  name: "7D6N Private Tours - United Kingdom + London + Oxford + Cambridge + Windsor",
  price: 120,
  duration: "7 days / 6 nights",
  groupType: "Private tour",
  location: "London",
  language: "Mandarin and English",
  transferInfo: "Airport/station pick-up and drop-off included",
  summaryTags: ["Departure guaranteed", "Car-type options available", "Self-selected hotels"],
  imageCover: "https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?auto=format&fit=crop&w=1800&q=80",
  images: [
    "https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1505765050516-f72dcac9c60f?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1512706604291-210a56c3b6e9?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1543791184-6f160248f1f2?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1470252649378-9c29740c9fa8?auto=format&fit=crop&w=900&q=80",
  ],
  ratingsAverage: 4.8,
  ratingsQuantity: 685,
  highlight:
    "Enjoy exclusive 4-diamond hotel accommodations throughout your journey, dedicated car service, and concierge one-on-one service.",
  itinerary: [
    "Arrive in London - 24-hour pick-up service at the airport/station",
    "Hotel pick-up - Discover Windsor Castle (admission included) - Prestigious Oxford University - Return to hotel",
    "Pick-up from hotel - Explore historic Cambridge University - See the iconic Tower Bridge - Return to hotel",
    "London - Free day (Westminster area & The British Museum)",
    "London - Free day (Hyde Park, Natural History Museum & Notting Hill)",
    "London - Free day (National Gallery, London Eye & Thames cruise)",
    "Enjoy 24-hour dedicated car service for airport/train station transfer - End of the trip",
  ],
  includesByTraveler: {
    adults: {
      notice: "The following instructions only apply to adults (12 years or over).",
      included: [
        {
          title: "Accommodation",
          description:
            "Accommodation at your self-selected hotels. The number of guests allowed depends on room type and hotel policy.",
        },
        {
          title: "Meals",
          description:
            "Breakfast details are based on your selected hotel room. Adults are responsible for their own meals during free time.",
        },
        {
          title: "Tour staff",
          description:
            "Local Mandarin and English-speaking driver transportation is included throughout the itinerary.",
        },
        {
          title: "Tickets and activities",
          description:
            "Admission ticket to the main entrance of the attractions listed in the itinerary, including Windsor Castle.",
        },
        {
          title: "Pick-up and drop-off",
          description:
            "Private vehicle pick-up and drop-off service on the first and last day of your itinerary.",
        },
      ],
      excluded: [
        {
          title: "Transportation",
          description:
            "Round-trip transportation from your departure city to London is not included.",
        },
        {
          title: "Additional fees",
          description:
            "Personal expenses such as laundry, excess baggage charges, phone calls, and optional activities are excluded.",
        },
      ],
    },
    children: {
      notice: "Child pricing and inclusions apply to travelers aged 2-11 years.",
      included: [
        {
          title: "Accommodation",
          description:
            "Children can stay in selected room types according to each hotel's family occupancy policy.",
        },
        {
          title: "Tour staff",
          description:
            "Driver-assisted transfers and itinerary transport are included for children.",
        },
        {
          title: "Tickets and activities",
          description:
            "Included attractions follow package policy. Some attractions may require age-based upgrades at check-in.",
        },
      ],
      excluded: [
        {
          title: "Meals",
          description:
            "Children's meal inclusions vary by hotel and venue; extra meals are paid separately.",
        },
        {
          title: "Additional fees",
          description:
            "Optional experiences, personal purchases, and insurance are not included.",
        },
      ],
    },
  },
  startDates: [
    "2026-05-09T00:00:00.000Z",
    "2026-05-10T00:00:00.000Z",
    "2026-05-11T00:00:00.000Z",
    "2026-05-12T00:00:00.000Z",
    "2026-05-13T00:00:00.000Z",
    "2026-05-14T00:00:00.000Z",
    "2026-05-15T00:00:00.000Z",
    "2026-05-16T00:00:00.000Z",
    "2026-05-17T00:00:00.000Z",
    "2026-05-18T00:00:00.000Z",
    "2026-05-19T00:00:00.000Z",
    "2026-05-20T00:00:00.000Z",
    "2026-05-21T00:00:00.000Z",
    "2026-05-22T00:00:00.000Z",
    "2026-05-23T00:00:00.000Z",
    "2026-05-24T00:00:00.000Z",
    "2026-05-25T00:00:00.000Z",
    "2026-05-26T00:00:00.000Z",
    "2026-05-27T00:00:00.000Z",
    "2026-05-28T00:00:00.000Z",
    "2026-05-29T00:00:00.000Z",
    "2026-05-30T00:00:00.000Z",
    "2026-05-31T00:00:00.000Z",
  ],
};

/** Overview tab: Highlights + Full description (accordion bodies). */
const OVERVIEW_HIGHLIGHTS_DEFAULT = [
  "Explore Kakum National Park",
  "Discover Elmina Castle",
  "Explore Cape Coast Castle",
  "Walk on the Kakum Canopy Walkway Experience",
  "Experience the Culture and History of Cape Coast",
];

const OVERVIEW_FULL_DESCRIPTION_STEPS_DEFAULT = [
  {
    title: "Start Your Journey from Accra to Cape Coast:",
    body: "Set out from Accra on a scenic drive of approximately three hours along the coast. Along the way you’ll pass villages, palm-lined roads, and ocean views as you head toward one of Ghana’s most historic regions.",
  },
  {
    title: "Experience the Adventure of Kakum National Park:",
    body: "Trek through lush rainforest and cross the famous canopy walkway suspended high above the forest floor. Your guide will point out birds, butterflies, and the rich biodiversity that makes Kakum a highlight for nature lovers.",
  },
  {
    title: "Discover the History of Elmina Castle:",
    body: "Visit Elmina Castle (St. George’s Castle), a UNESCO World Heritage site and one of the oldest European buildings in sub-Saharan Africa. Learn about its role in trade and the trans-Atlantic slave trade with time to reflect on this powerful history.",
  },
  {
    title: "Explore Cape Coast Castle and Township:",
    body: "Continue to Cape Coast Castle to tour the chambers, courtyards, and museum exhibits. Your guide shares stories of resilience and remembrance before you have a chance to explore the surrounding township and coastal atmosphere.",
  },
  {
    title: "Drive Back to Accra:",
    body: "After a full day of culture, history, and nature, relax on the return drive to Accra with drop-off at your hotel or agreed meeting point, carrying memories of Ghana’s Central Region.",
  },
];

function TourDetailContent() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { toggleWishlist, isInWishlist } = useWishlist();
  const { convertPrice } = useCurrency();
  const { addToCart } = useCart();
  const { addToRecentlyViewed } = useRecentlyViewed();
  const fallbackImagePool = useMemo(
    () => dedupeImages([...tourData.images, ...EXTERNAL_FALLBACK_IMAGES, fallbackTourImage]),
    []
  );
  const mergedImages = useMemo(() => {
    return dedupeImages([...tourData.images, ...EXTERNAL_FALLBACK_IMAGES, fallbackTourImage]);
  }, []);
  const [selectedImage, setSelectedImage] = useState(0);
  const [isGalleryDialogOpen, setIsGalleryDialogOpen] = useState(false);
  const [galleryPreviewIndex, setGalleryPreviewIndex] = useState(0);
  const [gallerySlideDirection, setGallerySlideDirection] = useState(0);
  const [galleryModalView, setGalleryModalView] = useState("grid");
  const mainImageTouchStartXRef = useRef(null);
  const thumbnailStripImages = useMemo(
    () => mergedImages.slice(0, 4).map((image, index) => ({ image, index })),
    [mergedImages]
  );
  const selectedTourDuration = tourData.duration;
  const selectedTourPriceNumber = tourData.price;
  const selectedTourTitle = useMemo(() => safeDecodeRouteParam(id) || tourData.name, [id]);
  const currentTour = useMemo(() => getTourByTitle(selectedTourTitle), [selectedTourTitle]);
  const selectedTourRatingNumber = Number.parseFloat(currentTour?.rating) || tourData.ratingsAverage;
  const selectedTourReviewsNumber = parseReviewCount(currentTour?.reviews) || tourData.ratingsQuantity;
  const [bookingDateRange, setBookingDateRange] = useState(null);
  const [isDateCalendarOpen, setIsDateCalendarOpen] = useState(false);
  const [isTravelerPickerOpen, setIsTravelerPickerOpen] = useState(false);
  const [calendarMonthCursor, setCalendarMonthCursor] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [activeDetailTab, setActiveDetailTab] = useState("overview");
  const [isReplyDialogOpen, setIsReplyDialogOpen] = useState(false);
  const [replyTargetQuestion, setReplyTargetQuestion] = useState(null);
  const [replyMessage, setReplyMessage] = useState("");
  const [replyConfirmation, setReplyConfirmation] = useState("");
  const [reviewStarFilter, setReviewStarFilter] = useState(null);
  const [reviewSearchQuery, setReviewSearchQuery] = useState("");
  const [isWriteReviewOpen, setIsWriteReviewOpen] = useState(false);
  const [writeReviewDisplayName, setWriteReviewDisplayName] = useState("");
  const [writeReviewRating, setWriteReviewRating] = useState(5);
  const [writeReviewText, setWriteReviewText] = useState("");
  const [writeReviewFiles, setWriteReviewFiles] = useState([]);
  const [travelerSubmittedReviews, setTravelerSubmittedReviews] = useState([]);
  const persistedReviewPhotoUrlsRef = useRef(new Set());
  const [adults, setAdults] = useState(2);
  const [seniors, setSeniors] = useState(0);
  const [youths, setYouths] = useState(0);
  const [children, setChildren] = useState(0);
  const [infants, setInfants] = useState(0);
  const [_expandedDay, _setExpandedDay] = useState(0);
  const [expandedInfoSection, setExpandedInfoSection] = useState("included");
  const [_travelerType, _setTravelerType] = useState("adults");
  const [overviewAccordionOpen, setOverviewAccordionOpen] = useState({
    highlights: true,
    fullDescription: true,
  });
  const [fullDescriptionExpanded, setFullDescriptionExpanded] = useState(false);
  const reviewBreakdown = useMemo(
    () => buildReviewBreakdown(selectedTourRatingNumber, selectedTourReviewsNumber),
    [selectedTourRatingNumber, selectedTourReviewsNumber]
  );

  useEffect(() => {
    setSelectedImage(0);
  }, [id]);

  useEffect(() => {
    loadTawkScript();
  }, []);

  useEffect(() => {
    setReviewStarFilter(null);
    setReviewSearchQuery("");
    setOverviewAccordionOpen({ highlights: true, fullDescription: true });
    setFullDescriptionExpanded(false);
  }, [id]);

  useEffect(() => {
    // Only add to recently viewed once when the page loads
    // Try to get the actual tour data from homepage
    const tourImage = currentTour?.image || mergedImages[0] || tourData.imageCover;
    
    const recentTourData = {
      title: selectedTourTitle, // This is the actual tour title from URL
      duration: currentTour?.duration || selectedTourDuration,
      price: currentTour?.price || selectedTourPriceNumber,
      rating: currentTour?.rating || String(selectedTourRatingNumber),
      reviews: currentTour?.reviews || String(selectedTourReviewsNumber),
      image: tourImage,
    };

    addToRecentlyViewed(recentTourData);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]); // Only re-run when the tour ID changes

  const isFavorited = isInWishlist(selectedTourTitle);

  const handleWishlistToggle = () => {
    toggleWishlist({
      title: selectedTourTitle,
      duration: selectedTourDuration,
      price: selectedTourPriceNumber,
      rating: String(selectedTourRatingNumber),
      reviews: String(selectedTourReviewsNumber),
      image: mergedImages[0] || tourData.imageCover,
    });
  };

  const handleShare = async () => {
    const shareData = {
      title: selectedTourTitle,
      url: window.location.href,
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
        return;
      }

      await navigator.clipboard?.writeText(shareData.url);
    } catch {
      // Ignore cancelled share dialogs and unavailable clipboard permissions.
    }
  };

  const _selectedTravelerMeta = tourData.includesByTraveler[_travelerType];
  const totalTravelers = adults + seniors + youths + children + infants;
  const totalPrice = useMemo(
    () => (
      adults * selectedTourPriceNumber +
      seniors * 200 +
      youths * 140 +
      children * 120
    ),
    [adults, children, selectedTourPriceNumber, seniors, youths]
  );
  const convertedUnitPrice = convertPrice(selectedTourPriceNumber);
  const convertedTotalPrice = convertPrice(totalPrice);
  const today = useMemo(() => new Date(), []);
  const nextAvailableQuickPickDates = tourData.startDates.filter((iso) => (
    startOfLocalDay(new Date(iso)).getTime() > startOfLocalDay(new Date()).getTime()
  )).slice(0, 4);
  const selectedDateLabel = useMemo(() => {
    if (!bookingDateRange?.start || !bookingDateRange?.end) return "Select date";
    const { start, end } = bookingDateRange;
    if (isSameCalendarDay(start, end)) {
      return start.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
    }
    const sameYear = start.getFullYear() === end.getFullYear();
    const startPart = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const endPart = end.toLocaleDateString(
      "en-US",
      sameYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric", year: "numeric" }
    );
    return `${startPart} – ${endPart}`;
  }, [bookingDateRange]);
  const _selectedDateWarningLabel = useMemo(() => {
    if (!bookingDateRange?.start || !bookingDateRange?.end) return "your selected date";
    const { start, end } = bookingDateRange;
    if (isSameCalendarDay(start, end)) {
      return start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    }
    const startWarn = start.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const endWarn = end.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    return `${startWarn} – ${endWarn}`;
  }, [bookingDateRange]);

  const commitBookingRange = useCallback((start, end) => {
    const { start: normStart, end: normEnd } = normalizeBookingRange(start, end);
    setBookingDateRange({ start: normStart, end: normEnd });
    setCalendarMonthCursor(new Date(normStart.getFullYear(), normStart.getMonth(), 1));
    setIsDateCalendarOpen(false);
  }, []);

  const handleCheckAvailability = () => {
    if (!bookingDateRange?.start) return;

    const added = addToCart({
      tourId: id,
      title: selectedTourTitle,
      duration: selectedTourDuration,
      price: totalPrice,
      unitPrice: selectedTourPriceNumber,
      rating: String(selectedTourRatingNumber),
      reviews: String(selectedTourReviewsNumber),
      image: mergedImages[0] || tourData.imageCover,
      selectedDate: bookingDateRange.start.toISOString(),
      ...( !isSameCalendarDay(bookingDateRange.start, bookingDateRange.end) && {
        selectedDateEnd: bookingDateRange.end.toISOString(),
      }),
      adults,
      seniors,
      youths,
      children,
      infants,
    });

    if (added) {
      navigate("/cart");
    }
  };

  const handleOpenReplyDialog = (question) => {
    setReplyTargetQuestion(question);
    setReplyMessage("");
    setReplyConfirmation("");
    setIsReplyDialogOpen(true);
  };

  const handleSubmitReply = (event) => {
    event.preventDefault();
    if (!replyMessage.trim()) return;

    setReplyConfirmation("Your reply has been accepted and is ready to be sent to the customer.");
    setReplyMessage("");
  };

  const resetWriteReviewForm = () => {
    setWriteReviewDisplayName("");
    setWriteReviewRating(5);
    setWriteReviewText("");
    setWriteReviewFiles([]);
  };

  const handleWriteReviewFileInput = (event) => {
    const list = event.target.files;
    if (!list?.length) return;
    setWriteReviewFiles((prev) => [...prev, ...Array.from(list)].slice(0, 12));
    event.target.value = "";
  };

  const removeWriteReviewFileAt = (index) => {
    setWriteReviewFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmitTravelerReview = (event) => {
    event.preventDefault();
    const text = writeReviewText.trim();
    if (!text) return;

    const photoUrls = writeReviewFiles.map((file) => {
      const url = URL.createObjectURL(file);
      persistedReviewPhotoUrlsRef.current.add(url);
      return url;
    });

    const id = `traveler-${Date.now()}`;
    setTravelerSubmittedReviews((prev) => [
      ...prev,
      {
        id,
        name: writeReviewDisplayName.trim() || "You",
        tag: "Traveler",
        date: new Date().toLocaleDateString("en-US", { month: "short", year: "numeric" }),
        rating: writeReviewRating,
        text,
        photos: photoUrls,
      },
    ]);

    resetWriteReviewForm();
    setIsWriteReviewOpen(false);
  };

  const travelerOptions = [
    {
      label: "Adults",
      age: "Age 18 - 60",
      price: convertedUnitPrice.formatted,
      count: adults,
      decrement: () => setAdults((prev) => Math.max(1, prev - 1)),
      increment: () => setAdults((prev) => Math.min(9, prev + 1)),
    },
    {
      label: "Seniors",
      age: "Age 61 - 80",
      price: convertPrice(200).formatted,
      count: seniors,
      decrement: () => setSeniors((prev) => Math.max(0, prev - 1)),
      increment: () => setSeniors((prev) => Math.min(9, prev + 1)),
    },
    {
      label: "Youths",
      age: "Age 15 - 17",
      price: convertPrice(140).formatted,
      count: youths,
      decrement: () => setYouths((prev) => Math.max(0, prev - 1)),
      increment: () => setYouths((prev) => Math.min(9, prev + 1)),
    },
    {
      label: "Children",
      age: "Age 4 - 14",
      price: convertPrice(120).formatted,
      count: children,
      decrement: () => setChildren((prev) => Math.max(0, prev - 1)),
      increment: () => setChildren((prev) => Math.min(9, prev + 1)),
    },
    {
      label: "Infants",
      age: "Age 1 - 3",
      price: "Free",
      count: infants,
      decrement: () => setInfants((prev) => Math.max(0, prev - 1)),
      increment: () => setInfants((prev) => Math.min(9, prev + 1)),
    },
  ];

  const handleImageError = (event) => {
    const currentSrc = event.currentTarget.src;
    const startOffset = Number(event.currentTarget.dataset.fallbackOffset || 0);
    const triedKeys = new Set(
      String(event.currentTarget.dataset.triedKeys || "")
        .split("|")
        .filter(Boolean)
    );

    for (let step = 0; step < fallbackImagePool.length; step += 1) {
      const candidate = fallbackImagePool[(startOffset + step) % fallbackImagePool.length];
      const candidateKey = normalizeImageKey(candidate);
      const currentKey = normalizeImageKey(currentSrc);

      if (!candidateKey || triedKeys.has(candidateKey) || candidateKey === currentKey) continue;

      triedKeys.add(candidateKey);
      event.currentTarget.dataset.triedKeys = Array.from(triedKeys).join("|");
      event.currentTarget.src = candidate;
      return;
    }

    event.currentTarget.onerror = null;
    event.currentTarget.src = fallbackTourImage;
  };

  const handleOpenGallery = (index = selectedImage, view = "viewer") => {
    setGalleryPreviewIndex(index);
    setGallerySlideDirection(0);
    setGalleryModalView(view);
    setIsGalleryDialogOpen(true);
  };

  const handleCloseGallery = () => {
    setIsGalleryDialogOpen(false);
    setGalleryModalView("grid");
  };

  const handleGalleryDialogChange = (open) => {
    setIsGalleryDialogOpen(open);
    if (!open) {
      setGalleryModalView("grid");
    }
  };

  const handleOpenGalleryViewer = (index) => {
    setGallerySlideDirection(index > galleryPreviewIndex ? 1 : -1);
    setSelectedImage(index);
    setGalleryPreviewIndex(index);
    setGalleryModalView("viewer");
  };

  const showPreviousGalleryImage = () => {
    if (mergedImages.length === 0) return;
    const previousIndex = (galleryPreviewIndex - 1 + mergedImages.length) % mergedImages.length;
    setGallerySlideDirection(-1);
    setSelectedImage(previousIndex);
    setGalleryPreviewIndex(previousIndex);
  };

  const showNextGalleryImage = () => {
    if (mergedImages.length === 0) return;
    const nextIndex = (galleryPreviewIndex + 1) % mergedImages.length;
    setGallerySlideDirection(1);
    setSelectedImage(nextIndex);
    setGalleryPreviewIndex(nextIndex);
  };

  const showNextMainImage = () => {
    if (mergedImages.length === 0) return;
    setSelectedImage((prev) => (prev + 1) % mergedImages.length);
  };

  const showPreviousMainImage = () => {
    if (mergedImages.length === 0) return;
    setSelectedImage((prev) => (prev - 1 + mergedImages.length) % mergedImages.length);
  };

  const handleMainImageTouchStart = (event) => {
    mainImageTouchStartXRef.current = event.touches[0]?.clientX ?? null;
  };

  const handleMainImageTouchEnd = (event) => {
    const startX = mainImageTouchStartXRef.current;
    if (startX === null) return;
    const endX = event.changedTouches[0]?.clientX ?? startX;
    const deltaX = endX - startX;
    if (deltaX < -45) showNextMainImage();
    if (deltaX > 45) showPreviousMainImage();
    mainImageTouchStartXRef.current = null;
  };

  const handleMainImageTouchCancel = () => {
    mainImageTouchStartXRef.current = null;
  };

  const viewerSlideVariants = {
    enter: (direction) => ({
      x: direction > 0 ? 70 : -70,
      opacity: 0,
      scale: 0.985,
    }),
    center: {
      x: 0,
      opacity: 1,
      scale: 1,
    },
    exit: (direction) => ({
      x: direction > 0 ? -70 : 70,
      opacity: 0,
      scale: 0.985,
    }),
  };

  const ratingDots = Array.from({ length: 5 });
  const quickFacts = [
    { icon: Clock, label: "Duration", value: selectedTourDuration },
    { icon: Truck, label: "Start time", value: "Check availability" },
    { icon: MapPin, label: "Pickup", value: "Accra pickup included" },
    { icon: Languages, label: "Language", value: "English, French" },
  ];

  const infoSections = [
    {
      key: "included",
      title: "What's included",
      content: (
        <div className="space-y-4">
          <div>
            <h4 className="text-sm font-bold text-[#002b11]">What's included</h4>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-[#002b11]/85">
              <li>Bottled Water</li>
              <li>Private Tour Guide</li>
              <li>Hotel Pick up and Drop-off</li>
              <li>WiFi on board</li>
              <li>Air-conditioned vehicle</li>
              <li>Cost of activities in itinerary</li>
              <li>Entry/Admission - Cape Coast Castle</li>
              <li>Entry/Admission - Elmina Castle</li>
              <li>Entry/Admission - Kakum National Park</li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-bold text-[#002b11]">What's not included</h4>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-[#002b11]/85">
              <li>Accommodation</li>
              <li>Lunch</li>
            </ul>
          </div>
        </div>
      ),
    },
    {
      key: "expect",
      title: "What to expect",
      content: <p className="text-sm leading-7 text-[#002b11]/80">Explore Cape Coast Castle, Elmina Castle, and Kakum National Park on a private day tour from Accra with guided storytelling, cultural context, and flexible pacing.</p>,
    },
    {
      key: "pickup",
      title: "Meeting and pickup",
      content: <p className="text-sm leading-7 text-[#002b11]/80">Pickup is available from selected hotels and apartments in Accra. Exact pickup details are confirmed after booking.</p>,
    },
    {
      key: "accessibility",
      title: "Accessibility",
      content: <p className="text-sm leading-7 text-[#002b11]/80">Travelers should have a moderate physical fitness level. Kakum canopy walk may not be suitable for all mobility needs.</p>,
    },
    {
      key: "policy",
      title: "Cancellation policy",
      content: <p className="text-sm leading-7 text-[#002b11]/80">Free cancellation is available up to 24 hours before the experience starts local time.</p>,
    },
  ];

  const itineraryStops = [
    { label: "Start", title: "You'll start at Accra", meta: "Or, you can also get picked up" },
    { label: "1", title: "Cape Coast Castle", meta: "Stop: 60 minutes - Admission included" },
    { label: "2", title: "Elmina Castle", meta: "Stop: 60 minutes - Admission included" },
    { label: "3", title: "Kakum National Park", meta: "Stop: 2 hours - Admission included" },
    { label: "End", title: "You'll return to the starting point", meta: "" },
  ];

  const reviewCards = useMemo(
    () => [
      {
        id: "sample-avi",
        name: "Avi C",
        tag: "Friends",
        date: "May 2026",
        rating: 5,
        text: "The tour was great especially our guide Thompson was amazing. We liked working with him so much we requested him for our second tour we booked.",
        photos: [EXTERNAL_FALLBACK_IMAGES[0], EXTERNAL_FALLBACK_IMAGES[1]],
      },
      {
        id: "sample-juliette",
        name: "Juliette T",
        tag: "Solo",
        date: "Apr 2026",
        rating: 4,
        text: "It was an amazing experience. The logistics were spot on, the guides were really sweet, informative and professional.",
        photos: [EXTERNAL_FALLBACK_IMAGES[2]],
      },
      {
        id: "sample-rendolf",
        name: "Rendolf A",
        tag: "Families",
        date: "Apr 2026",
        rating: 5,
        text: "Great experience! The tour was great and my husband and I would highly recommend it.",
      },
    ],
    []
  );

  const allReviewCards = useMemo(
    () => [...reviewCards, ...travelerSubmittedReviews],
    [reviewCards, travelerSubmittedReviews]
  );

  const filteredReviewCards = useMemo(() => {
    const q = reviewSearchQuery.trim().toLowerCase();
    return allReviewCards.filter((review) => {
      if (reviewStarFilter !== null && review.rating !== reviewStarFilter) return false;
      if (!q) return true;
      return (
        review.text.toLowerCase().includes(q) ||
        review.name.toLowerCase().includes(q) ||
        review.tag.toLowerCase().includes(q)
      );
    });
  }, [allReviewCards, reviewSearchQuery, reviewStarFilter]);

  const travelerPhotoItems = useMemo(
    () =>
      filteredReviewCards.flatMap((review) =>
        (review.photos || []).map((url, index) => ({
          key: `${review.id}-p-${index}`,
          url,
          reviewer: review.name,
        }))
      ),
    [filteredReviewCards]
  );

  const writeReviewPreviewUrls = useMemo(() => writeReviewFiles.map((file) => URL.createObjectURL(file)), [writeReviewFiles]);

  useEffect(() => {
    return () => {
      writeReviewPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [writeReviewPreviewUrls]);

  useEffect(() => {
    const ref = persistedReviewPhotoUrlsRef;
    return () => {
      ref.current.forEach((url) => URL.revokeObjectURL(url));
      ref.current.clear();
    };
  }, []);

  const qaItems = [
    { asker: "Mish", question: "What is the pick up and drop off time? I land at 6am and have a 8pm returning flight.", answer: "Contact the operator to confirm shorter versions of the tour and custom pickup timing." },
    { asker: "Charlie B", question: "Hello what time is pick up and return from Accra?", answer: "Pickup is usually early morning and return timing depends on traffic and selected stops." },
  ];

  const assistanceAside = (
    <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50/80 p-3 sm:p-3.5">
      <p className="text-sm font-bold leading-snug text-[color:var(--brand-green)] sm:text-[0.9375rem]">
        {t("tourDetail.needFurtherAssistance")}
      </p>
      <button
        type="button"
        onClick={() => openTawkChat()}
        className="mt-2.5 inline-flex w-full items-center gap-2 text-left text-sm font-normal text-[color:var(--brand-green)] underline underline-offset-[3px] decoration-[color:var(--brand-green)] transition hover:opacity-85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brand-green)] sm:w-auto"
      >
        <MessageSquare className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
        {t("tourDetail.startChat")}
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-[color:var(--page-bg)]">
      <Navbar />
      
      {/* Navbar spacer */}
      <div className="h-[58px] sm:h-[96px] lg:h-[104px]" />

      <main className="mx-auto max-w-[1520px] px-4 pb-8 pt-6 text-[color:var(--brand-green)] sm:px-6 sm:pt-8 lg:px-8">
        <button
          onClick={() => navigate(-1)}
          className="group mb-5 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 shadow-sm transition hover:border-[color:var(--brand-green)]/30 hover:bg-[color:var(--brand-mist)] hover:text-[color:var(--brand-green)] hover:shadow-md"
        >
          <ArrowLeft className="size-4 text-[color:var(--brand-green)] transition group-hover:-translate-x-0.5" />
          {t("common.back")}
        </button>

        <header className="space-y-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-5xl">
              <h1 className="font-black leading-tight tracking-tight text-[color:var(--brand-green)]" style={{ fontSize: "clamp(1.35rem, 2vw + 0.9rem, 2rem)" }}>
                {selectedTourTitle}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-4 text-sm font-semibold text-slate-900">
                <span className="inline-flex items-center gap-0.5 text-[#00b67a]" aria-label={`${selectedTourRatingNumber} out of 5 rating`}>
                  {ratingDots.map((_, index) => (
                    <Star key={`rating-star-${index}`} className="size-4 fill-current" />
                  ))}
                </span>
                <button type="button" onClick={() => setActiveDetailTab("reviews")} className="-ml-3 underline-offset-2 hover:underline">
                  {selectedTourReviewsNumber} Reviews
                </button>
                <span className="h-5 w-px bg-slate-900/65" aria-hidden="true" />
                <span className="inline-flex items-center gap-2">
                  <span className="grid size-4 place-items-center rounded-full bg-[#e7583f] text-white">
                    <Check className="size-3 stroke-[3]" />
                  </span>
                  Recommended by 96% of travelers
                  <Info className="size-3.5 text-slate-700" />
                </span>
                <span className="h-5 w-px bg-slate-900/65" aria-hidden="true" />
                <span>Accra, Ghana</span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsWriteReviewOpen(true)}
              className="inline-flex w-fit items-center rounded-full border border-[color:var(--brand-green)] px-4 py-2 text-sm font-bold transition hover:bg-[color:var(--brand-mist)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brand-green)]"
            >
              Review
            </button>
          </div>
        </header>

        <div className="mt-5 grid gap-6 xl:grid-cols-[minmax(0,1fr)_370px]">
        <section className="grid min-w-0 gap-2 lg:grid-cols-[130px_minmax(0,1fr)] 2xl:grid-cols-[150px_minmax(0,1fr)]">
          <div className="hidden h-[520px] grid-rows-4 gap-2 lg:grid">
            {thumbnailStripImages.map(({ image, index }, thumbnailIndex) => {
              const isSelected = index === selectedImage;
              const isLastVisibleThumbnail = thumbnailIndex === thumbnailStripImages.length - 1;

              return (
                <button
                  key={`gallery-strip-${index}`}
                  type="button"
                  onClick={() => (isLastVisibleThumbnail ? handleOpenGallery(index, "grid") : setSelectedImage(index))}
                  className={`group relative overflow-hidden rounded-lg bg-slate-100 ring-offset-2 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brand-green)] ${isSelected ? "ring-2 ring-[color:var(--brand-green)]" : ""}`}
                  aria-label={isLastVisibleThumbnail ? "See more tour photos" : `Show tour image ${index + 1}`}
                >
                  <img
                    src={image || fallbackTourImage}
                    alt={`Tour gallery thumbnail ${index + 1}`}
                    data-fallback-offset={index}
                    onError={handleImageError}
                    className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                  />
                  {isLastVisibleThumbnail && (
                    <span className="absolute inset-0 grid place-items-center bg-black/45 px-3 text-sm font-black text-white">
                      See More
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div
            className="relative h-[300px] overflow-hidden rounded-lg bg-slate-100 sm:h-[430px] lg:h-[520px]"
            onTouchStart={handleMainImageTouchStart}
            onTouchEnd={handleMainImageTouchEnd}
            onTouchCancel={handleMainImageTouchCancel}
          >
            <div className="flex h-full w-full transition-transform duration-300 ease-out" style={{ transform: `translateX(-${selectedImage * 100}%)` }}>
              {mergedImages.map((image, index) => (
                <img
                  key={`featured-slide-${index}`}
                  src={image || fallbackTourImage}
                  alt={`Tour gallery featured image ${index + 1}`}
                  data-fallback-offset={index}
                  onError={handleImageError}
                  className="h-full w-full shrink-0 object-cover"
                />
              ))}
            </div>

            <div className="absolute right-4 top-4 z-10 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={handleShare}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-white px-4 text-sm font-black text-slate-950 shadow-[0_2px_10px_rgba(15,23,42,0.18)] transition hover:bg-white/95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                <Share2 className="size-4" />
                Share
              </button>
              <button
                type="button"
                onClick={handleWishlistToggle}
                aria-label={isFavorited ? "Remove from wishlist" : "Add to wishlist"}
                aria-pressed={isFavorited}
                className="inline-grid size-11 shrink-0 place-items-center rounded-full bg-white text-slate-950 shadow-[0_2px_10px_rgba(15,23,42,0.18)] transition hover:bg-white/95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white active:scale-[0.98] touch-manipulation"
              >
                <Heart
                  className={`size-6 ${isFavorited ? "fill-[color:var(--brand-green)] text-[color:var(--brand-green)]" : "fill-none text-slate-900"}`}
                  aria-hidden
                />
              </button>
            </div>

            <button
              type="button"
              onClick={showPreviousMainImage}
              className="absolute left-4 top-1/2 z-10 hidden size-10 -translate-y-1/2 place-items-center rounded-full bg-white/90 text-slate-950 shadow-[0_2px_10px_rgba(15,23,42,0.18)] transition hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white lg:grid"
              aria-label="Show previous image"
            >
              <ChevronLeft className="size-6" />
            </button>
            <button
              type="button"
              onClick={showNextMainImage}
              className="absolute right-4 top-1/2 z-10 hidden size-10 -translate-y-1/2 place-items-center rounded-full bg-white/90 text-slate-950 shadow-[0_2px_10px_rgba(15,23,42,0.18)] transition hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white lg:grid"
              aria-label="Show next image"
            >
              <ChevronRight className="size-6" />
            </button>

            <button
              type="button"
              onClick={() => handleOpenGallery(selectedImage, "grid")}
              className="absolute bottom-3 right-3 rounded-md bg-slate-950/85 px-3 py-1.5 text-xs font-bold text-white shadow-sm lg:hidden"
            >
              View all photos
            </button>
          </div>

          <div className="grid h-24 grid-cols-4 gap-2 lg:hidden">
            {thumbnailStripImages.map(({ image, index }, thumbnailIndex) => {
              const isLastVisibleThumbnail = thumbnailIndex === thumbnailStripImages.length - 1;

              return (
                <button
                  key={`gallery-mobile-strip-${index}`}
                  type="button"
                  onClick={() => (isLastVisibleThumbnail ? handleOpenGallery(index, "grid") : setSelectedImage(index))}
                  className="relative overflow-hidden rounded-md bg-slate-100"
                  aria-label={isLastVisibleThumbnail ? "See more tour photos" : `Show tour image ${index + 1}`}
                >
                  <img
                    src={image || fallbackTourImage}
                    alt={`Tour gallery thumbnail ${index + 1}`}
                    data-fallback-offset={index}
                    onError={handleImageError}
                    className="h-full w-full object-cover transition hover:scale-[1.02]"
                  />
                  {isLastVisibleThumbnail && (
                    <span className="absolute inset-0 grid place-items-center bg-black/45 px-2 text-xs font-black text-white">
                      See More
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>

          <aside className="h-fit rounded-lg border border-slate-200 bg-white p-4 shadow-[0_2px_18px_rgba(15,23,42,0.08)] xl:sticky xl:top-36 xl:z-40">
            <div className="text-sm text-[color:var(--brand-green)]">
              <p><span className="font-black">From {convertedUnitPrice.formatted}</span> per adult <span className="text-xs">(price varies by group size)</span></p>
              <p className="mt-4 font-black">Select date and travelers</p>

              <div className="relative mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsDateCalendarOpen((isOpen) => !isOpen);
                    setIsTravelerPickerOpen(false);
                  }}
                  className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[color:var(--brand-green)] bg-white px-4 text-xs font-black text-[color:var(--brand-green)] transition hover:bg-emerald-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brand-green)]"
                  aria-expanded={isDateCalendarOpen}
                >
                  <CalendarDays className="size-4" />
                  {selectedDateLabel}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsTravelerPickerOpen((isOpen) => !isOpen);
                    setIsDateCalendarOpen(false);
                  }}
                  className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[color:var(--brand-green)] bg-white px-4 text-xs font-black text-[color:var(--brand-green)] transition hover:bg-emerald-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brand-green)]"
                  aria-expanded={isTravelerPickerOpen}
                >
                  <Users className="size-4" />
                  {totalTravelers}
                </button>

                {isDateCalendarOpen && (
                  <BookingCalendarPopover
                    monthCursor={calendarMonthCursor}
                    onMonthChange={setCalendarMonthCursor}
                    onCommitRange={commitBookingRange}
                    selectedRange={bookingDateRange}
                    today={today}
                  />
                )}

                {isTravelerPickerOpen && (
                  <div className="absolute left-0 top-[calc(100%+0.75rem)] z-50 w-[min(360px,calc(100vw-2rem))] rounded-sm border border-slate-100 bg-white p-5 text-[color:var(--brand-green)] shadow-[0_18px_45px_rgba(15,23,42,0.18)] xl:right-0 xl:left-auto">
                    <div className="space-y-6">
                      {travelerOptions.map((option) => {
                        const canDecrement = option.label === "Adults" ? option.count > 1 : option.count > 0;

                        return (
                          <div key={option.label} className="flex items-center justify-between gap-4">
                            <div className="min-w-0">
                              <p className="leading-tight">
                                <span className="text-base font-black">{option.label}</span>{" "}
                                <span className="text-sm font-medium text-[color:var(--brand-green)]/70">{option.age}</span>
                              </p>
                              <p className="mt-1 text-sm font-semibold">{option.price}</p>
                            </div>
                            <div className="flex shrink-0 items-center gap-4">
                              <button
                                type="button"
                                onClick={option.decrement}
                                disabled={!canDecrement}
                                className="grid size-9 place-items-center rounded-full bg-[color:var(--brand-green)] text-white transition hover:bg-[color:var(--brand-green)]/90 disabled:bg-[color:var(--brand-green)]/35"
                                aria-label={`Remove one ${option.label}`}
                              >
                                <Minus className="size-5" />
                              </button>
                              <span className="w-5 text-center text-base font-black">{option.count}</span>
                              <button
                                type="button"
                                onClick={option.increment}
                                className="grid size-9 place-items-center rounded-full bg-[color:var(--brand-green)] text-white transition hover:bg-[color:var(--brand-green)]/90"
                                aria-label={`Add one ${option.label}`}
                              >
                                <Plus className="size-5" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <Button
                      type="button"
                      onClick={() => setIsTravelerPickerOpen(false)}
                      className="mt-8 h-12 w-full rounded-full bg-[#1A4530] text-sm font-black !text-white hover:bg-[#163b29]"
                    >
                      Update search
                    </Button>
                  </div>
                )}
              </div>

              {totalTravelers > 0 && (
                <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4">
                  <span className="text-sm font-medium text-slate-600">Total ({totalTravelers} {totalTravelers === 1 ? "traveler" : "travelers"})</span>
                  <span className="text-xl font-bold text-[color:var(--brand-green)]">{convertedTotalPrice.formatted}</span>
                </div>
              )}

              <Button
                onClick={handleCheckAvailability}
                disabled={!bookingDateRange}
                className="mt-4 h-12 w-full rounded-full bg-[color:var(--brand-green)] text-base font-black !text-white hover:bg-[color:var(--brand-green)]/90 disabled:opacity-60"
              >
                Check availability
              </Button>

              {nextAvailableQuickPickDates.length > 0 && (
                <>
                  <p className="mt-4 font-black">Next Available Dates:</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {nextAvailableQuickPickDates.map((date) => {
                      const availableDate = new Date(date);
                      const label = availableDate.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });

                      return (
                        <button
                          key={date}
                          type="button"
                          onClick={() => commitBookingRange(availableDate, availableDate)}
                          className="rounded-full border border-[color:var(--brand-green)] px-3 py-1.5 text-xs font-bold transition hover:bg-emerald-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brand-green)]"
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {assistanceAside}
            </div>
          </aside>
        </div>

        <nav className="sticky top-[58px] z-30 -mx-4 mt-5 overflow-x-auto bg-white px-4 sm:-mx-6 sm:px-6 lg:top-[104px] lg:-mx-8 lg:px-8">
          <div className="flex min-w-max gap-7 text-sm font-bold text-[color:var(--brand-green)]">
            {TOUR_DETAIL_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveDetailTab(tab.key)}
                className={`border-b-2 py-3 transition ${
                  activeDetailTab === tab.key
                    ? "border-[color:var(--brand-green)]"
                    : "border-transparent hover:border-[color:var(--brand-green)]/50"
                }`}
                aria-pressed={activeDetailTab === tab.key}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </nav>

        <div className="mt-5">
          <div className="min-w-0">
            {activeDetailTab === "overview" && (
            <section id="overview" className="pb-6">
              <h2 className="text-lg font-black text-[color:var(--brand-green)]">About</h2>
              <p className="mt-4 max-w-3xl text-sm leading-7 text-[color:var(--brand-green)]/85">
                Visit the castles of Cape Coast and explore the adventures of Kakum National Park with this guided tour from Accra. You'll learn and discover the history of Cape Coast Castle and Elmina Castle and also undertake the canopy walkway experience.
              </p>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {quickFacts.map(({ icon: Icon, label, value }) => (
                  <div key={label} className="flex items-start gap-3 text-sm text-[color:var(--brand-green)]">
                    <Icon className="mt-0.5 size-4 shrink-0" />
                    <div>
                      <p className="font-bold">{label}</p>
                      <p className="text-[color:var(--brand-green)]/75">{value}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-8 space-y-2 pt-6">
                <div>
                  <button
                    type="button"
                    onClick={() =>
                      setOverviewAccordionOpen((p) => ({ ...p, highlights: !p.highlights }))
                    }
                    className="flex w-full items-center justify-between gap-4 py-4 text-left"
                    aria-expanded={overviewAccordionOpen.highlights}
                  >
                    <span className="text-sm font-bold text-slate-900">{t("tourDetail.highlights")}</span>
                    <span className="flex shrink-0 justify-end">
                      {overviewAccordionOpen.highlights ? (
                        <ChevronUp className="size-4 text-[color:var(--brand-green)]" aria-hidden />
                      ) : (
                        <ChevronDown className="size-4 text-[color:var(--brand-green)]" aria-hidden />
                      )}
                    </span>
                  </button>
                  {overviewAccordionOpen.highlights && (
                    <div className="pb-5">
                      <ul className="list-disc space-y-1.5 pl-5 text-sm leading-7 text-slate-700">
                        {OVERVIEW_HIGHLIGHTS_DEFAULT.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                <div>
                  <button
                    type="button"
                    onClick={() =>
                      setOverviewAccordionOpen((p) => ({ ...p, fullDescription: !p.fullDescription }))
                    }
                    className="flex w-full items-center justify-between gap-4 py-4 text-left"
                    aria-expanded={overviewAccordionOpen.fullDescription}
                  >
                    <span className="text-sm font-bold text-slate-900">{t("tourDetail.fullDescription")}</span>
                    <span className="flex shrink-0 justify-end">
                      {overviewAccordionOpen.fullDescription ? (
                        <ChevronUp className="size-4 text-[color:var(--brand-green)]" aria-hidden />
                      ) : (
                        <ChevronDown className="size-4 text-[color:var(--brand-green)]" aria-hidden />
                      )}
                    </span>
                  </button>
                  {overviewAccordionOpen.fullDescription && (
                    <div className="pb-5">
                      <div className="min-w-0">
                        <ol className="list-none space-y-4 pl-0">
                          {(fullDescriptionExpanded
                            ? OVERVIEW_FULL_DESCRIPTION_STEPS_DEFAULT
                            : OVERVIEW_FULL_DESCRIPTION_STEPS_DEFAULT.slice(0, 2)
                          ).map((step, index) => (
                            <li key={step.title} className="flex gap-3">
                              <span className="mt-0.5 shrink-0 text-sm font-bold text-slate-900">{index + 1}.</span>
                              <div className="min-w-0 flex-1 text-sm leading-7 text-slate-700">
                                <p className="font-bold text-slate-900">{step.title}</p>
                                <p className="mt-1.5">{step.body}</p>
                              </div>
                            </li>
                          ))}
                        </ol>
                        {OVERVIEW_FULL_DESCRIPTION_STEPS_DEFAULT.length > 2 && (
                          <button
                            type="button"
                            onClick={() => setFullDescriptionExpanded((v) => !v)}
                            className="mt-4 text-sm font-semibold text-blue-600 underline decoration-blue-600 underline-offset-2 hover:text-blue-700"
                          >
                            {fullDescriptionExpanded ? t("tourDetail.seeLess") : t("tourDetail.seeMore")}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>
            )}

            {activeDetailTab === "details" && (
            <section id="details" className="pb-6">
              <h2 className="text-lg font-black text-[color:var(--brand-green)]">Details</h2>
              <div className="mt-4 space-y-3">
                {infoSections.map((section) => {
                  const isOpen = expandedInfoSection === section.key;
                  return (
                    <div key={section.key}>
                      <button
                        type="button"
                        onClick={() => setExpandedInfoSection(isOpen ? "" : section.key)}
                        className="flex w-full items-center justify-between py-4 text-left text-sm font-black text-[color:var(--brand-green)]"
                      >
                        {section.title}
                        {isOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                      </button>
                      {isOpen && <div className="pb-5">{section.content}</div>}
                    </div>
                  );
                })}
              </div>
            </section>
            )}

            {activeDetailTab === "itinerary" && (
            <section id="itinerary" className="pb-8">
              <h2 className="text-lg font-black text-[color:var(--brand-green)]">Itinerary</h2>
              <div className="mt-5 grid gap-6 lg:grid-cols-[330px_minmax(0,1fr)]">
                <div className="space-y-0">
                  {itineraryStops.map((stop, index) => (
                    <div key={stop.title} className="relative flex gap-3 pb-5 last:pb-0">
                      {index < itineraryStops.length - 1 && <span className="absolute left-[15px] top-8 h-full w-px bg-[color:var(--brand-green)]" />}
                      <span className="z-10 grid size-8 shrink-0 place-items-center rounded-full bg-[color:var(--brand-green)] text-[10px] font-black text-white">
                        {stop.label}
                      </span>
                      <div>
                        <p className="text-sm font-black text-[color:var(--brand-green)]">{stop.title}</p>
                        {stop.meta && <p className="mt-1 text-xs text-[color:var(--brand-green)]/70">{stop.meta}</p>}
                        {index > 0 && index < itineraryStops.length - 1 && <button className="mt-1 text-xs font-bold underline">See details & photo</button>}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="relative min-h-[320px] overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                  <iframe
                    title="Google map showing Accra, Cape Coast Castle, Elmina Castle, and Kakum National Park"
                    src="https://www.google.com/maps?q=Accra%20Cape%20Coast%20Castle%20Elmina%20Castle%20Kakum%20National%20Park%20Ghana&output=embed"
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                    className="h-full min-h-[320px] w-full"
                  />
                  <div className="absolute right-4 top-4 rounded-full bg-white px-3 py-1 text-xs font-bold text-[color:var(--brand-green)] shadow">
                    Tour route map
                  </div>
                </div>
              </div>
            </section>
            )}

            {activeDetailTab === "reviews" && (
            <>
            <section id="reviews" className="pb-8">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <h2 className="text-2xl font-black text-slate-950">Reviews</h2>
                <button
                  type="button"
                  onClick={() => setIsWriteReviewOpen(true)}
                  className="rounded-full border border-[color:var(--brand-green)] bg-white px-5 py-2.5 text-sm font-black text-[color:var(--brand-green)] transition hover:bg-[color:var(--brand-mist)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brand-green)]"
                >
                  Write a review
                </button>
              </div>
              <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1fr)_370px]">
                <div className="min-w-0">
                  <div className="grid gap-8 lg:grid-cols-[260px_minmax(0,1fr)] lg:items-center">
                    <div className="text-center">
                      <p className="text-4xl font-black text-slate-950">{selectedTourRatingNumber.toFixed(1)}</p>
                      <div className="mt-3 flex justify-center gap-1 text-[#00b67a]">
                        {ratingDots.map((_, i) => (
                          <Star key={i} className="size-6 fill-current" />
                        ))}
                      </div>
                      <p className="mt-2 text-sm font-bold text-slate-950">
                        based on {selectedTourReviewsNumber} reviews
                      </p>
                    </div>

                    <div>
                      <p className="mb-5 text-sm font-semibold text-slate-950">Total reviews and rating from Viator & Tripadvisor</p>
                      <div className="space-y-3">
                        {reviewBreakdown.map((item) => {
                          const isActive = reviewStarFilter === item.stars;
                          return (
                          <button
                            key={item.label}
                            type="button"
                            onClick={() => setReviewStarFilter((prev) => (prev === item.stars ? null : item.stars))}
                            className={`grid w-full grid-cols-[70px_minmax(0,1fr)_42px] items-center gap-4 rounded-lg py-1 pl-1 text-left text-sm font-semibold text-slate-950 transition ${
                              isActive ? "bg-emerald-50 ring-2 ring-[#00b67a]/35" : "hover:bg-slate-50"
                            }`}
                            aria-label={`Filter reviews by ${item.label}`}
                            aria-pressed={isActive}
                          >
                            <span>{item.label}</span>
                            <span className="h-3 overflow-hidden rounded-full bg-slate-300">
                              <span className="block h-full rounded-full bg-[#00b67a]" style={{ width: `${item.percentage}%` }} />
                            </span>
                            <span className="text-right">{item.count}</span>
                          </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="mt-8 space-y-6">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                      <input
                        value={reviewSearchQuery}
                        onChange={(e) => setReviewSearchQuery(e.target.value)}
                        className="min-w-0 flex-1 rounded-full border border-[color:var(--brand-green)] px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--brand-green)]"
                        placeholder="Search reviews..."
                      />
                      {reviewStarFilter !== null && (
                        <button
                          type="button"
                          onClick={() => setReviewStarFilter(null)}
                          className="shrink-0 text-sm font-bold text-[color:var(--brand-green)] underline-offset-2 hover:underline"
                        >
                          Clear star filter
                        </button>
                      )}
                    </div>
                    {filteredReviewCards.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-600">
                        No reviews match{reviewStarFilter !== null ? ` ${reviewStarFilter}-star` : ""} ratings{reviewSearchQuery.trim() ? " and your search" : ""}. Try another rating or adjust your search.
                      </p>
                    ) : (
                    filteredReviewCards.map((review) => (
                      <article key={`review-${review.id}`}>
                        <p className="font-black">{review.name}</p>
                        <p className="text-xs text-[color:var(--brand-green)]/65">{review.date} • {review.tag}</p>
                        <div className="mt-2 flex gap-0.5 text-emerald-600" aria-hidden="true">
                          {ratingDots.map((_, i) => (
                            <Star key={i} className={`size-2.5 ${i < review.rating ? "fill-current" : "fill-none text-slate-300"}`} />
                          ))}
                        </div>
                        <p className="mt-3 text-sm leading-7 text-[color:var(--brand-green)]/85">{review.text}</p>
                        {(review.photos || []).length > 0 && (
                          <div className="mt-4 flex flex-wrap gap-2">
                            {(review.photos || []).map((photoUrl, i) => (
                              <img
                                key={`${review.id}-inline-${i}`}
                                src={photoUrl}
                                alt=""
                                className="h-28 w-28 rounded-lg border border-slate-200 object-cover"
                                data-fallback-offset={i}
                                onError={handleImageError}
                              />
                            ))}
                          </div>
                        )}
                      </article>
                    ))
                    )}
                  </div>
                </div>

                <aside className="h-fit rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_2px_18px_rgba(15,23,42,0.08)]">
                  <div>
                    <h3 className="text-lg font-black text-slate-950">Traveler photos</h3>
                    <p className="mt-1 text-xs leading-5 text-[color:var(--brand-green)]/70">
                      Only photos travelers attach when they write a review are shown here.
                    </p>
                  </div>

                  {travelerPhotoItems.length === 0 ? (
                    <p className="mt-4 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-6 text-center text-xs leading-5 text-slate-600">
                      No traveler photos yet. Write a review and add photos there.
                    </p>
                  ) : (
                    <div className="mt-4 grid grid-cols-2 gap-2">
                      {travelerPhotoItems.map((item) => (
                        <div key={item.key} className="overflow-hidden rounded-lg">
                          <img
                            src={item.url}
                            alt={`Photo from ${item.reviewer}`}
                            className="aspect-square w-full object-cover"
                            data-fallback-offset={0}
                            onError={handleImageError}
                          />
                          <p className="truncate px-0.5 pt-1 text-[10px] font-semibold text-slate-600">{item.reviewer}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </aside>
              </div>
            </section>

            <section id="qa" className="pb-8">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-black text-[color:var(--brand-green)]">Q&A</h2>
                <button
                  type="button"
                  onClick={() => handleOpenReplyDialog(qaItems[0])}
                  className="rounded-full border border-[color:var(--brand-green)] px-5 py-2 text-sm font-bold transition hover:bg-emerald-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brand-green)]"
                >
                  Ask a question
                </button>
              </div>
              <div className="mt-5 space-y-8">
                {qaItems.map((item) => (
                  <article key={item.question}>
                    <p className="text-sm font-black">{item.asker}</p>
                    <p className="mt-2 text-sm leading-6">{item.question}</p>
                    <p className="mt-4 pl-6 text-sm leading-6 text-[color:var(--brand-green)]/80">{item.answer}</p>
                    <button
                      type="button"
                      onClick={() => handleOpenReplyDialog(item)}
                      className="mt-4 text-xs font-bold underline"
                    >
                      Answer
                    </button>
                  </article>
                ))}
              </div>
            </section>

            <section id="operator" className="pb-8">
              <h2 className="text-lg font-black text-[color:var(--brand-green)]">About the operator</h2>
              <p className="mt-2 text-sm text-[color:var(--brand-green)]/75">Don't take it from us - here's what people have to say about this operator.</p>
              <div className="mt-4 flex gap-4 overflow-x-auto pb-2">
                <div className="min-w-[190px] rounded-lg border border-slate-200 p-4 text-center">
                  <div className="mx-auto grid size-16 place-items-center rounded-full border border-slate-200 text-xs font-black">EXP</div>
                  <p className="mt-3 text-sm font-black">Expedition-Go Tours Ltd</p>
                  <p className="mt-2 text-xs">4.9 • Accra, Ghana</p>
                </div>
                {reviewCards.map((review) => (
                  <article key={`operator-${review.name}`} className="min-w-[210px] rounded-lg border border-slate-200 p-4">
                    <p className="text-sm font-black">{review.name}</p>
                    <div className="mt-2 flex gap-1 text-emerald-600">{ratingDots.map((_, i) => <Star key={i} className="size-2.5 fill-current" />)}</div>
                    <p className="mt-2 line-clamp-4 text-xs leading-5">{review.text}</p>
                  </article>
                ))}
              </div>
              <button type="button" className="mt-2 text-xs font-bold underline">See all 853 reviews</button>
            </section>
            </>
            )}
          </div>
        </div>

        <SimilarExperiencesCarousel excludeTitle={selectedTourTitle} onImageError={handleImageError} />

          <aside className="hidden">
            <div className="text-sm text-[color:var(--brand-green)]">
              <p><span className="font-black">From {convertedUnitPrice.formatted}</span> per adult <span className="text-xs">(price varies by group size)</span></p>
              <p className="mt-4 font-black">Select date and travelers</p>

              <div className="relative mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsDateCalendarOpen((isOpen) => !isOpen);
                    setIsTravelerPickerOpen(false);
                  }}
                  className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[color:var(--brand-green)] bg-white px-4 text-xs font-black text-[color:var(--brand-green)] transition hover:bg-emerald-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brand-green)]"
                  aria-expanded={isDateCalendarOpen}
                >
                  <CalendarDays className="size-4" />
                  {selectedDateLabel}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsTravelerPickerOpen((isOpen) => !isOpen);
                    setIsDateCalendarOpen(false);
                  }}
                  className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[color:var(--brand-green)] bg-white px-4 text-xs font-black text-[color:var(--brand-green)] transition hover:bg-emerald-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brand-green)]"
                  aria-expanded={isTravelerPickerOpen}
                >
                  <Users className="size-4" />
                  {totalTravelers}
                </button>

                {isDateCalendarOpen && (
                  <BookingCalendarPopover
                    monthCursor={calendarMonthCursor}
                    onMonthChange={setCalendarMonthCursor}
                    onCommitRange={commitBookingRange}
                    selectedRange={bookingDateRange}
                    today={today}
                  />
                )}

                {isTravelerPickerOpen && (
                  <div className="absolute left-0 top-[calc(100%+0.75rem)] z-50 w-[min(360px,calc(100vw-2rem))] rounded-sm border border-slate-100 bg-white p-5 text-[color:var(--brand-green)] shadow-[0_18px_45px_rgba(15,23,42,0.18)] lg:right-0 lg:left-auto">
                    <div className="space-y-6">
                      {travelerOptions.map((option) => {
                        const canDecrement = option.label === "Adults" ? option.count > 1 : option.count > 0;

                        return (
                          <div key={option.label} className="flex items-center justify-between gap-4">
                            <div className="min-w-0">
                              <p className="leading-tight">
                                <span className="text-base font-black">{option.label}</span>{" "}
                                <span className="text-sm font-medium text-[color:var(--brand-green)]/70">{option.age}</span>
                              </p>
                              <p className="mt-1 text-sm font-semibold">{option.price}</p>
                            </div>
                            <div className="flex shrink-0 items-center gap-4">
                              <button
                                type="button"
                                onClick={option.decrement}
                                disabled={!canDecrement}
                                className="grid size-9 place-items-center rounded-full bg-[color:var(--brand-green)] text-white transition hover:bg-[color:var(--brand-green)]/90 disabled:bg-[color:var(--brand-green)]/35"
                                aria-label={`Remove one ${option.label}`}
                              >
                                <Minus className="size-5" />
                              </button>
                              <span className="w-5 text-center text-base font-black">{option.count}</span>
                              <button
                                type="button"
                                onClick={option.increment}
                                className="grid size-9 place-items-center rounded-full bg-[color:var(--brand-green)] text-white transition hover:bg-[color:var(--brand-green)]/90"
                                aria-label={`Add one ${option.label}`}
                              >
                                <Plus className="size-5" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <Button
                      type="button"
                      onClick={() => setIsTravelerPickerOpen(false)}
                      className="mt-8 h-12 w-full rounded-full bg-[#1A4530] text-sm font-black !text-white hover:bg-[#163b29]"
                    >
                      Update search
                    </Button>
                  </div>
                )}
              </div>

              {/* <p className="mt-4 rounded-md bg-rose-50 p-3 text-xs leading-5 text-rose-700">
                We're sorry, the option you've selected is unavailable on {selectedDateWarningLabel}. Try changing the date or number of travelers to find availability.
              </p> */}

              <Button
                onClick={handleCheckAvailability}
                disabled={!bookingDateRange}
                className="mt-4 h-12 w-full rounded-full bg-[color:var(--brand-green)] text-base font-black !text-white hover:bg-[color:var(--brand-green)]/90 disabled:opacity-60"
              >
                Check availability
              </Button>

              {nextAvailableQuickPickDates.length > 0 && (
                <>
                  <p className="mt-4 font-black">Next Available Dates:</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {nextAvailableQuickPickDates.map((date) => {
                      const availableDate = new Date(date);
                      const label = availableDate.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });

                      return (
                        <button
                          key={date}
                          type="button"
                          onClick={() => commitBookingRange(availableDate, availableDate)}
                          className="rounded-full border border-[color:var(--brand-green)] px-3 py-1.5 text-xs font-bold transition hover:bg-emerald-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brand-green)]"
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {assistanceAside}
            </div>
          </aside>

        <Dialog open={isReplyDialogOpen} onOpenChange={setIsReplyDialogOpen}>
          <DialogContent className="max-w-[560px] text-[color:var(--brand-green)]">
            <DialogTitle className="pr-8 text-xl font-black text-[color:var(--brand-green)]">
              Reply to customer comment
            </DialogTitle>
            {replyTargetQuestion && (
              <div className="mt-4 rounded-xl border border-slate-200 bg-emerald-50/45 p-4">
                <p className="text-sm font-black">{replyTargetQuestion.asker}</p>
                <p className="mt-2 text-sm leading-6 text-[color:var(--brand-green)]/85">
                  {replyTargetQuestion.question}
                </p>
              </div>
            )}

            <form onSubmit={handleSubmitReply} className="mt-5 space-y-4">
              <label className="block text-sm font-black" htmlFor="customer-reply">
                Your reply
              </label>
              <textarea
                id="customer-reply"
                value={replyMessage}
                onChange={(event) => {
                  setReplyMessage(event.target.value);
                  setReplyConfirmation("");
                }}
                rows={5}
                placeholder="Write a helpful reply for the customer..."
                className="w-full resize-none rounded-xl border border-slate-300 bg-white p-3 text-sm leading-6 text-[color:var(--brand-green)] outline-none transition focus:border-[color:var(--brand-green)] focus:ring-2 focus:ring-[color:var(--brand-green)]/20"
              />
              {replyConfirmation && (
                <p className="rounded-lg bg-emerald-50 p-3 text-sm font-semibold text-[color:var(--brand-green)]">
                  {replyConfirmation}
                </p>
              )}
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsReplyDialogOpen(false)}
                  className="rounded-full border-slate-300 px-5 text-[color:var(--brand-green)]"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!replyMessage.trim()}
                  className="rounded-full bg-[#1A4530] px-5 font-black !text-white hover:bg-[#163b29] disabled:opacity-50"
                >
                  Accept reply
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog
          open={isWriteReviewOpen}
          onOpenChange={(open) => {
            setIsWriteReviewOpen(open);
            if (!open) resetWriteReviewForm();
          }}
        >
          <DialogContent className="max-h-[90vh] max-w-[560px] overflow-y-auto text-[color:var(--brand-green)]">
            <DialogTitle className="pr-8 text-xl font-black text-[color:var(--brand-green)]">Write a review</DialogTitle>
            <p className="mt-2 text-sm leading-6 text-[color:var(--brand-green)]/80">
              Share your experience. You can add photos only as part of this review—not from the Traveler photos panel.
            </p>

            <form onSubmit={handleSubmitTravelerReview} className="mt-5 space-y-4">
              <div>
                <label className="block text-sm font-black" htmlFor="write-review-name">
                  Your name <span className="font-normal text-[color:var(--brand-green)]/65">(optional)</span>
                </label>
                <input
                  id="write-review-name"
                  type="text"
                  value={writeReviewDisplayName}
                  onChange={(e) => setWriteReviewDisplayName(e.target.value)}
                  placeholder="e.g. Alex M."
                  className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-[color:var(--brand-green)] focus:ring-2 focus:ring-[color:var(--brand-green)]/20"
                />
              </div>

              <div>
                <p className="text-sm font-black">Your rating</p>
                <div className="mt-2 flex gap-1" role="group" aria-label="Star rating">
                  {[1, 2, 3, 4, 5].map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setWriteReviewRating(value)}
                      className="rounded p-0.5 text-emerald-600 transition hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brand-green)]"
                      aria-label={`${value} out of 5 stars`}
                    >
                      <Star className={`size-9 ${value <= writeReviewRating ? "fill-current" : "fill-none text-slate-300"}`} />
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-black" htmlFor="write-review-text">
                  Your review
                </label>
                <textarea
                  id="write-review-text"
                  value={writeReviewText}
                  onChange={(e) => setWriteReviewText(e.target.value)}
                  rows={5}
                  required
                  placeholder="Tell travelers what stood out…"
                  className="mt-2 w-full resize-none rounded-xl border border-slate-300 bg-white p-3 text-sm leading-6 outline-none transition focus:border-[color:var(--brand-green)] focus:ring-2 focus:ring-[color:var(--brand-green)]/20"
                />
              </div>

              <div>
                <p className="text-sm font-black">Photos</p>
                <p className="mt-1 text-xs text-[color:var(--brand-green)]/70">Optional. Images are shown with your review and in Traveler photos.</p>
                <label className="mt-3 flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-[color:var(--brand-green)]/40 bg-emerald-50/50 px-4 py-4 text-center transition hover:bg-emerald-50">
                  <span className="text-sm font-black text-[color:var(--brand-green)]">Add photos to this review</span>
                  <span className="mt-1 text-xs text-[color:var(--brand-green)]/70">JPG, PNG, or WebP · up to 12 images</span>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="sr-only"
                    onChange={handleWriteReviewFileInput}
                  />
                </label>
                {writeReviewPreviewUrls.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {writeReviewPreviewUrls.map((url, index) => (
                      <div key={`write-preview-${index}`} className="relative h-16 w-16 shrink-0">
                        <img src={url} alt="" className="size-full rounded-lg border border-slate-200 object-cover" />
                        <button
                          type="button"
                          onClick={() => removeWriteReviewFileAt(index)}
                          className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:bg-slate-50"
                          aria-label="Remove photo"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsWriteReviewOpen(false)}
                  className="rounded-full border-slate-300 px-5 text-[color:var(--brand-green)]"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!writeReviewText.trim()}
                  className="rounded-full bg-[#1A4530] px-5 font-black !text-white hover:bg-[#163b29] disabled:opacity-50"
                >
                  Post review
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog open={isGalleryDialogOpen} onOpenChange={handleGalleryDialogChange}>
          <DialogContent
            hideCloseButton
            className="left-0 top-0 h-[100dvh] max-h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 bg-slate-200 p-0 shadow-none"
          >
            <DialogTitle className="sr-only">Tour image gallery</DialogTitle>
            <button
              type="button"
              onClick={handleCloseGallery}
              className="absolute left-3 top-3 z-20 grid size-9 place-items-center rounded-full bg-white/95 text-slate-700 shadow-sm transition hover:bg-white sm:left-4 sm:top-4"
              aria-label="Close gallery"
            >
              <X className="size-4" />
            </button>

            <AnimatePresence mode="wait">
              {galleryModalView === "grid" ? (
                <motion.div
                  key="gallery-grid-view"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                  className="mx-auto h-[100dvh] max-w-[690px] overflow-y-auto px-3 pb-6 pt-14 sm:px-4 sm:pt-16"
                >
                  <div className="columns-2 gap-2.5 sm:columns-3 sm:gap-3">
                    {mergedImages.map((image, index) => (
                      <button
                        key={`dialog-gallery-grid-${index}`}
                        type="button"
                        onClick={() => handleOpenGalleryViewer(index)}
                        className="mb-2.5 block w-full break-inside-avoid overflow-hidden rounded-md bg-slate-100 sm:mb-3"
                      >
                        <img
                          src={image || fallbackTourImage}
                          alt={`Tour gallery grid image ${index + 1}`}
                          data-fallback-offset={index}
                          onError={handleImageError}
                          className="w-full object-cover transition hover:scale-[1.01] active:scale-100"
                        />
                      </button>
                    ))}
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="gallery-viewer-mode"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.2, ease: "easeOut" }}
                  className="relative h-[100dvh] bg-white px-3 pb-4 pt-12 sm:px-4 sm:pt-14"
                >
                  <p className="absolute left-1/2 top-5 z-10 -translate-x-1/2 text-xs font-semibold text-slate-700 sm:top-6">
                    {galleryPreviewIndex + 1} / {mergedImages.length}
                  </p>
                  <button
                    type="button"
                    onClick={() => setGalleryModalView("grid")}
                    className="absolute right-5 top-5 z-10 grid size-9 place-items-center rounded-full bg-white/95 text-slate-700 shadow-sm transition hover:bg-white sm:right-6 sm:top-6"
                    aria-label="Back to gallery grid"
                  >
                    <Grid3X3 className="size-4" />
                  </button>
                  <div className="relative mx-auto h-full w-full max-w-[1000px] overflow-hidden px-9 sm:px-12">
                    <button type="button" onClick={showPreviousGalleryImage} className="absolute -left-2 top-1/2 z-10 hidden size-9 -translate-y-1/2 place-items-center rounded-full bg-white/95 text-slate-700 shadow-sm transition hover:bg-white sm:grid sm:-left-3" aria-label="Show previous image">
                      <ChevronLeft className="size-5" />
                    </button>
                    <AnimatePresence custom={gallerySlideDirection} initial={false} mode="wait">
                      <motion.div
                        key={`modal-image-${galleryPreviewIndex}`}
                        custom={gallerySlideDirection}
                        variants={viewerSlideVariants}
                        initial="enter"
                        animate="center"
                        exit="exit"
                        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                        drag="x"
                        dragConstraints={{ left: 0, right: 0 }}
                        dragElastic={0.18}
                        onDragEnd={(_, info) => {
                          if (info.offset.x < -70) showNextGalleryImage();
                          if (info.offset.x > 70) showPreviousGalleryImage();
                        }}
                        className="absolute inset-0 flex items-center justify-center"
                      >
                        <img src={mergedImages[galleryPreviewIndex] || fallbackTourImage} alt={`Tour gallery image ${galleryPreviewIndex + 1}`} data-fallback-offset={galleryPreviewIndex} onError={handleImageError} className="max-h-[80vh] max-w-full rounded-sm object-contain" />
                      </motion.div>
                    </AnimatePresence>
                    <button type="button" onClick={showNextGalleryImage} className="absolute -right-2 top-1/2 z-10 hidden size-9 -translate-y-1/2 place-items-center rounded-full bg-white/95 text-slate-700 shadow-sm transition hover:bg-white sm:grid sm:-right-3" aria-label="Show next image">
                      <ChevronRight className="size-5" />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </DialogContent>
        </Dialog>
      </main>

      <Footer />
    </div>
  );
}

function TourDetailPage() {
  return (
    <AuthModalProvider>
      <RecentlyViewedProvider>
        <TourDetailContent />
      </RecentlyViewedProvider>
    </AuthModalProvider>
  );
}

export default TourDetailPage;
