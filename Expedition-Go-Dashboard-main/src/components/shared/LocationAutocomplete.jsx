import { useState, useRef, useEffect, useCallback } from "react";
import { MapPin, Loader2, Search, X } from "lucide-react";
import { useGeocoding } from "@/hooks/useGeocoding";
import { config } from "@/config";

/**
 * LocationAutocomplete
 *
 * Accessible autocomplete for location search.
 * Uses Geoapify (free tier) with Nominatim fallback.
 * Auto-fills city, country, region, latitude, longitude on selection.
 */
export default function LocationAutocomplete({ onSelect, disabled = false }) {
  const apiKey = config.maps?.geoapifyApiKey || "";
  const { search, clear, results, loading, error } = useGeocoding(apiKey);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const inputRef = useRef(null);
  const listRef = useRef(null);
  const containerRef = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleInputChange = (e) => {
    const value = e.target.value;
    setQuery(value);
    setHighlightedIndex(-1);
    if (value.trim().length >= 2) {
      search(value);
      setOpen(true);
    } else {
      clear();
      setOpen(false);
    }
  };

  const handleSelect = useCallback(
    (result) => {
      setQuery(result.formatted);
      setOpen(false);
      setHighlightedIndex(-1);
      onSelect(result);
    },
    [onSelect],
  );

  const handleClear = () => {
    setQuery("");
    clear();
    setOpen(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (!open || results.length === 0) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev < results.length - 1 ? prev + 1 : 0,
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev > 0 ? prev - 1 : results.length - 1,
        );
        break;
      case "Enter":
        e.preventDefault();
        if (highlightedIndex >= 0) {
          handleSelect(results[highlightedIndex]);
        }
        break;
      case "Escape":
        setOpen(false);
        setHighlightedIndex(-1);
        break;
      default:
        break;
    }
  };

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex >= 0 && listRef.current) {
      const item = listRef.current.children[highlightedIndex];
      if (item) {
        item.scrollIntoView({ block: "nearest" });
      }
    }
  }, [highlightedIndex]);

  return (
    <div ref={containerRef} className="relative">
      <label className="block text-sm font-medium text-[#1e293b] mb-2">
        <span className="flex items-center gap-1.5">
          <MapPin size={14} className="text-[#64748b]" />
          Location Search
        </span>
      </label>

      <div className="relative">
        <Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9e9e9e]"
        />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (results.length > 0) setOpen(true);
          }}
          disabled={disabled}
          placeholder="Start typing a location (e.g., Arusha, Tanzania)"
          className="w-full pl-10 pr-10 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] disabled:opacity-50 disabled:cursor-not-allowed"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={open ? "location-listbox" : undefined}
          aria-activedescendant={
            highlightedIndex >= 0 ? `location-option-${highlightedIndex}` : undefined
          }
        />
        {query && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9e9e9e] hover:text-[#64748b]"
            aria-label="Clear location search"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {open && (
        <div
          id="location-listbox"
          role="listbox"
          className="absolute z-50 mt-1 w-full bg-white border border-[#eaeaea] rounded-lg shadow-lg max-h-64 overflow-y-auto"
        >
          {loading && (
            <div className="flex items-center gap-2 px-4 py-3 text-sm text-[#64748b]">
              <Loader2 size={14} className="animate-spin" />
              Searching locations...
            </div>
          )}

          {!loading && error && (
            <div className="px-4 py-3 text-sm text-[#dc3545]">
              {error}
              <p className="text-xs text-[#9e9e9e] mt-1">
                You can still enter location details manually below.
              </p>
            </div>
          )}

          {!loading && !error && results.length === 0 && query.trim().length >= 2 && (
            <div className="px-4 py-3 text-sm text-[#64748b]">
              No locations found.
              <p className="text-xs text-[#9e9e9e] mt-1">
                Try a different search or enter details manually.
              </p>
            </div>
          )}

          {!loading &&
            results.map((result, index) => (
              <div
                key={`${result.source}-${index}`}
                id={`location-option-${index}`}
                role="option"
                aria-selected={index === highlightedIndex}
                onClick={() => handleSelect(result)}
                onMouseEnter={() => setHighlightedIndex(index)}
                className={`px-4 py-2.5 cursor-pointer text-sm border-b border-[#f1f5f9] last:border-0 ${
                  index === highlightedIndex
                    ? "bg-[#f0fdf4] text-[#044b3b]"
                    : "text-[#1e293b] hover:bg-[#f8fafc]"
                }`}
              >
                <div className="font-medium truncate">{result.formatted}</div>
                <div className="text-xs text-[#64748b] truncate">
                  {[result.city, result.region, result.country]
                    .filter(Boolean)
                    .join(", ")}
                </div>
              </div>
            ))}
        </div>
      )}

      {/* Attribution (required by Nominatim terms) */}
      <p className="text-[10px] text-[#9e9e9e] mt-1">
        Location data ©{" "}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-[#64748b]"
        >
          OpenStreetMap
        </a>{" "}
        contributors
      </p>
    </div>
  );
}
