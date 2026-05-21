import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";

import { useVisitorCountry } from "@/hooks/useVisitorCountry";
import { getAttractionsForCountry, hasAttractionPack } from "@/lib/topAttractionsByCountry";

const LG_QUERY = "(min-width: 1024px)";

function subscribeToMinWidthLg(callback) {
  const mq = window.matchMedia(LG_QUERY);
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}

function getMinWidthLgSnapshot() {
  return window.matchMedia(LG_QUERY).matches;
}

function getMinWidthLgServerSnapshot() {
  return false;
}

function useIsMinLg() {
  return useSyncExternalStore(
    subscribeToMinWidthLg,
    getMinWidthLgSnapshot,
    getMinWidthLgServerSnapshot,
  );
}

export function ExploreMoreSection() {
  const { t } = useTranslation();
  const { countryCode, countryName } = useVisitorCountry();
  const listId = useId();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isLg = useIsMinLg();

  const { attractions, displayCountry } = useMemo(() => {
    const pack = getAttractionsForCountry(countryCode);
    const name = typeof countryName === "string" ? countryName.trim() : "";
    const displayCountry =
      hasAttractionPack(countryCode) && name.length > 1 ? name : pack.countryName;
    return { attractions: pack.attractions, displayCountry };
  }, [countryCode, countryName]);

  useEffect(() => {
    setMobileOpen(false);
  }, [countryCode, displayCountry]);

  const toggleList = () => setMobileOpen((open) => !open);

  const headerInteractiveProps = !isLg
    ? {
        role: "button",
        tabIndex: 0,
        "aria-expanded": mobileOpen,
        "aria-controls": listId,
        "aria-labelledby": "explore-more-heading explore-more-subtitle",
        onClick: toggleList,
        onKeyDown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleList();
          }
        },
      }
    : {};

  return (
    <section
      className="bg-[color:var(--page-bg)] py-4 md:py-9 lg:py-10"
      aria-labelledby="explore-more-heading"
    >
      <div className="mx-auto max-w-[1520px] px-4 sm:px-6">
        <div
          className={`flex w-full items-start justify-between gap-3 sm:gap-4 ${!isLg ? "max-lg:min-h-[44px] max-lg:cursor-pointer max-lg:touch-manipulation max-lg:rounded-lg max-lg:py-1 max-lg:pl-1 max-lg:pr-1 max-lg:-mx-1 max-lg:active:bg-slate-50/90" : ""}`}
          {...headerInteractiveProps}
        >
          <div className="min-w-0 flex-1">
            <h2
              id="explore-more-heading"
              className="font-bold tracking-tight text-slate-900"
              style={{ fontSize: "clamp(1.25rem, 2vw + 0.5rem, 1.75rem)" }}
            >
              {t("exploreMore.title")}
            </h2>
            <p
              id="explore-more-subtitle"
              className="mt-2 font-bold text-slate-900"
              style={{ fontSize: "clamp(0.9375rem, 1.1vw + 0.45rem, 1.125rem)" }}
            >
              {t("exploreMore.topAttractions", { country: displayCountry })}
            </p>
          </div>
          <ChevronDown
            className={`mt-0.5 size-6 shrink-0 text-slate-700 transition-transform duration-200 lg:hidden ${mobileOpen ? "rotate-180" : ""}`}
            aria-hidden
            strokeWidth={2}
          />
        </div>

        <ul
          id={listId}
          className={`mt-4 flex list-none flex-row flex-wrap gap-2.5 sm:mt-5 sm:gap-3 md:gap-3.5 lg:mt-6 lg:gap-3.5 ${mobileOpen ? "" : "max-lg:hidden"}`}
          role="list"
        >
          {attractions.map((name, index) => (
            <li key={`${name}-${index}`} className="min-w-0">
              <div
                className="inline-flex max-w-[100%] min-h-[2.5rem] cursor-pointer overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06)] sm:min-h-[2.625rem]"
                aria-label={`${index + 1}. ${name}`}
              >
                <span className="flex w-10 shrink-0 items-center justify-center bg-[color:var(--brand-green)] text-[13px] font-bold tabular-nums text-white sm:w-11 sm:text-sm">
                  {index + 1}
                </span>
                <span className="flex min-w-0 items-center border-l border-slate-200 bg-white px-2.5 py-1.5 text-left text-[13px] font-medium leading-snug text-slate-900 sm:px-3 sm:text-sm">
                  {name}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
