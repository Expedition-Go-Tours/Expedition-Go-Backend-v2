import { useState, useEffect, useMemo } from "react";
import {
  pickupTours,
  recommendedTours,
  topRatedTours,
  leisureTours,
  destinations,
} from "@/components/homepage/data";

/**
 * Search autocomplete hook with fuzzy matching
 * Returns matching tours and destinations as user types
 */
export function useSearchAutocomplete(query) {
  const [results, setResults] = useState({ tours: [], destinations: [], total: 0 });

  // Combine all searchable data
  const allTours = useMemo(
    () => [...pickupTours, ...recommendedTours, ...topRatedTours, ...leisureTours],
    []
  );

  const allDestinations = useMemo(() => destinations, []);

  useEffect(() => {
    const trimmedQuery = query.trim().toLowerCase();

    if (!trimmedQuery || trimmedQuery.length < 2) {
      setResults({ tours: [], destinations: [], total: 0 });
      return;
    }

    // Search tours
    const matchingTours = allTours
      .filter((tour) => {
        const searchableText = `${tour.title} ${tour.duration} ${tour.price}`.toLowerCase();
        return searchableText.includes(trimmedQuery);
      })
      .slice(0, 5); // Limit to 5 results

    // Search destinations
    const matchingDestinations = allDestinations
      .filter((dest) => {
        const searchableText = `${dest.title} ${dest.tours}`.toLowerCase();
        return searchableText.includes(trimmedQuery);
      })
      .slice(0, 3); // Limit to 3 results

    setResults({
      tours: matchingTours,
      destinations: matchingDestinations,
      total: matchingTours.length + matchingDestinations.length,
    });
  }, [query, allTours, allDestinations]);

  return results;
}
