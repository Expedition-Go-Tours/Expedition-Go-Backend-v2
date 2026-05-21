import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";
import { X, Search } from "lucide-react";
import { destinations } from "./data";
import { DestinationCard } from "./DestinationCard";

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function useFocusTrap(containerRef, isOpen) {
  useEffect(() => {
    if (!isOpen || !containerRef.current) return;

    const container = containerRef.current;
    const focusable = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    // Focus search input if present, otherwise first focusable
    const searchInput = container.querySelector('input[type="text"]');
    (searchInput || first)?.focus();

    const handleKeyDown = (e) => {
      if (e.key !== "Tab") return;

      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (active === last || !container.contains(active)) {
          e.preventDefault();
          first?.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, containerRef]);
}

const cardVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0 },
};

const containerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.05,
    },
  },
};

function DestinationGrid({ items, onNavigate }) {
  return (
    <motion.div
      className="grid grid-cols-2 gap-4"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {items.map((dest, index) => (
        <motion.div
          key={`${dest.title}-${index}`}
          variants={cardVariants}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className="cursor-pointer"
          onClick={() => onNavigate(dest.title)}
        >
          <DestinationCard {...dest} />
        </motion.div>
      ))}
    </motion.div>
  );
}

function ModalBody({ onClose }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRegion, setSelectedRegion] = useState("all");

  const regions = useMemo(() => {
    const set = new Set(destinations.map((d) => d.region));
    return ["all", ...Array.from(set).sort()];
  }, []);

  const filtered = useMemo(() => {
    let result = destinations;
    if (selectedRegion !== "all") {
      result = result.filter((d) => d.region === selectedRegion);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((d) => d.title.toLowerCase().includes(q));
    }
    return result;
  }, [selectedRegion, searchQuery]);

  const popularVisible = filtered.slice(0, 5);

  const handleNavigate = useCallback(
    (title) => {
      onClose();
      navigate(`/tours?search=${encodeURIComponent(title)}`);
    },
    [navigate, onClose]
  );

  const handleExploreRegion = useCallback(
    (region) => {
      onClose();
      navigate(`/tours?search=${encodeURIComponent(region)}`);
    },
    [navigate, onClose]
  );

  // Group by region when "All Regions" is selected and no search
  const groupedByRegion = useMemo(() => {
    if (selectedRegion !== "all" || searchQuery.trim()) return null;
    const map = new Map();
    destinations.forEach((d) => {
      if (!map.has(d.region)) map.set(d.region, []);
      map.get(d.region).push(d);
    });
    return Array.from(map.entries()).map(([region, items]) => ({
      region,
      items: items.slice(0, 2),
    }));
  }, [selectedRegion, searchQuery]);

  return (
    <>
      {/* Search */}
      <div className="px-6 pt-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("modal.searchPlaceholder")}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-4 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[color:var(--brand-green)] focus:bg-white focus:ring-2 focus:ring-[color:var(--brand-green)]/20"
          />
        </div>
      </div>

      {/* Region chips */}
      <div className="px-6 pt-4">
        <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1 sm:flex-wrap sm:overflow-visible">
          {regions.map((region) => (
            <button
              key={region}
              onClick={() => {
                setSelectedRegion(region);
              }}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-medium transition sm:text-sm ${
                selectedRegion === region
                  ? "bg-[color:var(--brand-green)] text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              {region === "all" ? t("modal.allRegions") : region}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto modal-scrollbar px-6 py-6">
        {/* Popular / Filtered grid */}
        <div className="mb-8">
          <h3 className="mb-4 text-sm font-medium text-slate-900 sm:text-base">
            {searchQuery.trim()
              ? `${filtered.length} ${t("common.destinations")}`
              : t("modal.popularDestinations")}
          </h3>

          {filtered.length > 0 ? (
            <DestinationGrid
              items={popularVisible}
              onNavigate={handleNavigate}
            />
          ) : (
            <div className="py-12 text-center text-sm text-slate-500">
              No destinations match your search.
            </div>
          )}
        </div>

        {/* Region groups — only when All Regions and no search */}
        {groupedByRegion &&
          groupedByRegion.map(({ region, items }) => (
            <div key={region} className="mb-10">
              <div className="mb-4 flex items-center justify-between">
                <h4 className="text-base font-semibold text-slate-900 sm:text-lg">
                  {region}
                </h4>
                <button
                  onClick={() => handleExploreRegion(region)}
                  className="text-sm font-medium text-[color:var(--brand-green)] hover:underline"
                >
                  {t("modal.explore")}
                </button>
              </div>
              <DestinationGrid items={items} onNavigate={handleNavigate} />
            </div>
          ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Slide-out panel (Framer Motion) — used on all screen sizes         */
/* ------------------------------------------------------------------ */
function SlideOutPanel({ isOpen, onClose, children }) {
  const panelRef = useRef(null);
  useFocusTrap(panelRef, isOpen);

  return (
    <AnimatePresence>
      {isOpen ? (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 z-[70] bg-black/50"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          />

          {/* Panel */}
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            className="fixed right-0 top-0 z-[80] flex h-screen w-full max-w-2xl flex-col bg-white shadow-2xl"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{
              duration: 0.34,
              ease: [0.22, 1, 0.36, 1],
              delay: 0.06,
            }}
          >
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
              <h2
                id="modal-title"
                className="text-lg font-bold text-slate-900 sm:text-2xl"
              >
                Where to next?
              </h2>
              <button
                onClick={onClose}
                className="grid size-10 place-items-center rounded-full transition hover:bg-slate-100"
                aria-label="Close"
              >
                <X className="size-6 text-slate-600" />
              </button>
            </div>

            {children}
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------ */
/* Main export                                                          */
/* ------------------------------------------------------------------ */
export function DestinationsModal({ isOpen, onClose, triggerRef }) {
  const wasOpenRef = useRef(false);

  // Body scroll lock
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "unset";
    }
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [isOpen]);

  // Escape to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  // Do not return focus to trigger on close
  useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
    }
    if (!isOpen) {
      wasOpenRef.current = false;
    }
  }, [isOpen]);

  return (
    <SlideOutPanel isOpen={isOpen} onClose={onClose}>
      <ModalBody onClose={onClose} />
    </SlideOutPanel>
  );
}
