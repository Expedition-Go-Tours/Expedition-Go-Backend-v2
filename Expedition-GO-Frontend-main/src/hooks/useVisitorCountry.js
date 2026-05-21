import { useEffect, useState } from "react";

const CACHE_KEY = "expedition-go-visitor-country-v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve visitor country via ipapi.co (HTTPS, browser CORS).
 * Falls back to Ghana (GH) when offline, blocked, or invalid.
 */
export function useVisitorCountry() {
  const [state, setState] = useState(() => {
    if (typeof window === "undefined") {
      return { countryCode: "GH", countryName: "Ghana", source: "default" };
    }
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) {
        return { countryCode: "GH", countryName: "Ghana", source: "default" };
      }
      const parsed = JSON.parse(raw);
      if (
        typeof parsed.t === "number" &&
        Date.now() - parsed.t < CACHE_TTL_MS &&
        typeof parsed.code === "string" &&
        parsed.code.length === 2
      ) {
        return {
          countryCode: parsed.code.toUpperCase(),
          countryName: typeof parsed.name === "string" ? parsed.name : parsed.code,
          source: "cache",
        };
      }
    } catch {
      /* ignore */
    }
    return { countryCode: "GH", countryName: "Ghana", source: "default" };
  });

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    (async () => {
      try {
        try {
          const raw = sessionStorage.getItem(CACHE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (
              typeof parsed.t === "number" &&
              Date.now() - parsed.t < CACHE_TTL_MS &&
              typeof parsed.code === "string" &&
              parsed.code.length === 2
            ) {
              return;
            }
          }
        } catch {
          /* fetch below */
        }

        const res = await fetch("https://ipapi.co/json/", {
          signal: ctrl.signal,
          headers: { Accept: "application/json" },
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled || !data || data.error) return;

        const code = String(data.country_code || "").trim().toUpperCase();
        const name = String(data.country_name || data.country || "").trim() || "Ghana";
        if (code.length !== 2) return;

        const next = { countryCode: code, countryName: name, source: "geo" };
        setState(next);
        try {
          sessionStorage.setItem(
            CACHE_KEY,
            JSON.stringify({ code, name, t: Date.now() }),
          );
        } catch {
          /* ignore */
        }
      } catch {
        if (!cancelled) {
          setState((prev) =>
            prev.source === "cache" ? prev : { countryCode: "GH", countryName: "Ghana", source: "fallback" },
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, []);

  return state;
}
