import { useState, useRef, useCallback } from "react";

/**
 * In-memory LRU cache for geocoding results.
 * Prevents duplicate API calls for the same query.
 */
const cache = new Map();
const MAX_CACHE_SIZE = 50;

function getCached(query) {
  const key = query.trim().toLowerCase();
  if (cache.has(key)) {
    const entry = cache.get(key);
    // Move to end (most recently used)
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }
  return null;
}

function setCached(query, data) {
  const key = query.trim().toLowerCase();
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= MAX_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, data);
}

/**
 * Normalize Geoapify result to our standard format
 */
function normalizeGeoapifyResult(feature) {
  const props = feature.properties;
  const coords = feature.geometry?.coordinates;

  return {
    formatted: props.formatted || props.name || "",
    city: props.city || props.town || props.village || props.county || "",
    country: props.country || "",
    region: props.state || props.district || props.region || "",
    latitude: coords ? coords[1] : null,
    longitude: coords ? coords[0] : null,
    source: "geoapify",
  };
}

/**
 * Normalize Nominatim result to our standard format
 */
function normalizeNominatimResult(result) {
  const addr = result.address || {};
  const lat = result.lat ? Number(result.lat) : null;
  const lon = result.lon ? Number(result.lon) : null;

  return {
    formatted: result.display_name || "",
    city: addr.city || addr.town || addr.village || addr.county || "",
    country: addr.country || "",
    region: addr.state || addr.region || addr.district || "",
    latitude: lat,
    longitude: lon,
    source: "nominatim",
  };
}

/**
 * Fetch from Geoapify
 */
async function fetchGeoapify(query, apiKey, signal) {
  const url = `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(query)}&apiKey=${apiKey}&limit=5`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Geoapify HTTP ${res.status}`);
  const data = await res.json();
  return (data.features || []).map(normalizeGeoapifyResult);
}

/**
 * Fetch from Nominatim (OpenStreetMap) — free fallback
 */
async function fetchNominatim(query, signal) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1`;
  const res = await fetch(url, {
    signal,
    headers: { "Accept-Language": "en" },
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map(normalizeNominatimResult);
}

/**
 * useGeocoding hook
 *
 * Debounced geocoding with dual-provider fallback.
 * Tries Geoapify first, falls back to Nominatim on failure or missing key.
 *
 * @param {string} apiKey — Geoapify API key (optional)
 * @returns {{ search: (q: string) => void, results: Array, loading: boolean, error: string|null }}
 */
export function useGeocoding(apiKey = "") {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const abortRef = useRef(null);
  const timerRef = useRef(null);

  const search = useCallback(
    (query) => {
      // Cancel any in-flight request and pending timer
      if (abortRef.current) {
        abortRef.current.abort();
      }
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      const trimmed = query.trim();
      if (!trimmed) {
        setResults([]);
        setLoading(false);
        setError(null);
        return;
      }

      // Check cache
      const cached = getCached(trimmed);
      if (cached) {
        setResults(cached);
        setLoading(false);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);

      timerRef.current = setTimeout(async () => {
        const controller = new AbortController();
        abortRef.current = controller;

        try {
          let data = [];
          const hasKey = apiKey && apiKey.length > 10;

          if (hasKey) {
            try {
              data = await fetchGeoapify(trimmed, apiKey, controller.signal);
            } catch (geoErr) {
              // Geoapify failed — try Nominatim once
              if (!controller.signal.aborted) {
                data = await fetchNominatim(trimmed, controller.signal);
              } else {
                throw geoErr;
              }
            }
          } else {
            // No key — use Nominatim directly
            data = await fetchNominatim(trimmed, controller.signal);
          }

          setCached(trimmed, data);
          setResults(data);
        } catch (err) {
          if (err.name !== "AbortError") {
            setError(err.message || "Failed to fetch location suggestions");
            setResults([]);
          }
        } finally {
          setLoading(false);
        }
      }, 400); // 400ms debounce
    },
    [apiKey],
  );

  const clear = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    setResults([]);
    setLoading(false);
    setError(null);
  }, []);

  return { search, clear, results, loading, error };
}
