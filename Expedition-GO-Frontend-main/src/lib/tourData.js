import {
  pickupTours,
  recommendedTours,
  topRatedTours,
  leisureTours,
  lastMinuteDeals,
  sidebarTopRated,
} from "@/components/homepage/data";

/** Homepage main + sidebar tour strips, in rough page order (for round-robin mixing). */
const HOME_TOUR_SECTIONS = [
  () => pickupTours,
  () => recommendedTours,
  () => topRatedTours,
  () => leisureTours,
  () => lastMinuteDeals,
  () => sidebarTopRated,
];

/** Matches HOME_TOUR_SECTIONS: top-left badge style on similar-experience cards. */
const SECTION_SIMILAR_BADGE = ["duration", "duration", "duration", "duration", "deal", "new"];

/**
 * Get all tours from all categories
 */
export function getAllTours() {
  return [
    ...pickupTours,
    ...recommendedTours,
    ...topRatedTours,
    ...leisureTours,
    ...lastMinuteDeals,
  ];
}

/**
 * Find a tour by title
 */
export function getTourByTitle(title) {
  const trimmed = String(title ?? "").trim();
  if (!trimmed) return undefined;

  const allTours = getAllTours();
  const exact = allTours.find((tour) => tour.title === trimmed);
  if (exact) return exact;

  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    decoded = trimmed;
  }
  if (decoded !== trimmed) {
    return allTours.find((tour) => tour.title === decoded);
  }
  return undefined;
}

/**
 * Merge a homepage-section item with catalog data when the title matches,
 * so deal/sidebar rows still get duration/rating when available.
 */
function normalizeTourForSimilar(raw) {
  const fromCat = getTourByTitle(raw.title);
  const merged = fromCat ? { ...fromCat, ...raw } : { ...raw };
  return {
    ...merged,
    duration: merged.duration ?? "Flexible",
    rating: merged.rating != null ? String(merged.rating) : "4.8",
    reviews: merged.reviews ?? 120,
  };
}

/**
 * Round-robin across homepage carousel sources so the similar strip feels varied
 * (featured → recommended → top rated → leisure → last-minute → sidebar picks).
 */
export function getMixedHomeSectionToursForSimilar({ excludeTitle, limit = 16 } = {}) {
  const excludeNorm = String(excludeTitle ?? "").trim();
  const sections = HOME_TOUR_SECTIONS.map((get) =>
    get().filter((t) => t && t.title && t.title !== excludeNorm),
  );
  const cursors = sections.map(() => 0);
  const used = new Set();
  const out = [];

  const takeNext = (sectionIndex) => {
    const arr = sections[sectionIndex];
    while (cursors[sectionIndex] < arr.length) {
      const t = arr[cursors[sectionIndex]++];
      if (!used.has(t.title)) {
        used.add(t.title);
        return t;
      }
    }
    return null;
  };

  while (out.length < limit) {
    let progressed = false;
    for (let si = 0; si < sections.length; si++) {
      const next = takeNext(si);
      if (next) {
        out.push({
          ...normalizeTourForSimilar(next),
          similarExperienceBadge: SECTION_SIMILAR_BADGE[si] ?? "duration",
        });
        progressed = true;
        if (out.length >= limit) break;
      }
    }
    if (!progressed) break;
  }

  return out;
}
