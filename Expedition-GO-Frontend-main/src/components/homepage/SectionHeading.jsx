import { ChevronLeft, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

export function SectionHeading({ title, subtitle, categoryId, onScrollLeft, onScrollRight }) {
  const { t } = useTranslation();
  const hasScrollButtons = onScrollLeft && onScrollRight;

  return (
    <div className="relative z-30 isolate mb-[0.6375rem] flex items-start justify-between gap-4 md:mb-2.5 xl:mb-3">
      <div className="min-w-0 flex-1">
        <h2
          className="truncate font-bold tracking-tight text-slate-900 leading-[1.15]"
          style={{ fontSize: 'clamp(1.2rem, 1.2vw + 0.5rem, 1.375rem)' }}
          title={title}
        >
          {title}
        </h2>

        {subtitle ? (
          <p className="mt-1 max-w-full leading-snug text-slate-500" style={{ fontSize: 'clamp(0.75rem, 0.5vw + 0.5rem, 0.875rem)' }}>
            {subtitle}
          </p>
        ) : null}
      </div>

      <div className="relative z-[1] flex shrink-0 items-center gap-3">
        <Link
          to={`/tours?category=${encodeURIComponent(categoryId || "all")}`}
          onClick={() => window.scrollTo({ top: 0, behavior: "auto" })}
          className="group relative inline-flex min-h-[44px] min-w-[44px] shrink-0 touch-manipulation items-center justify-center gap-1 whitespace-nowrap rounded-md py-2 pl-2 pr-2 text-[13px] font-semibold text-slate-700 transition hover:bg-slate-100/90 hover:text-slate-950 sm:text-[13px] xl:text-[14px]"
        >
          <span className="relative">
            {t("sections.viewAll")}
            <span className="absolute bottom-0 left-0 h-0.5 w-0 bg-[color:var(--brand-green)] transition-all duration-300 group-hover:w-full" />
          </span>
          <ChevronRight className="size-4 text-slate-500 transition group-hover:text-[color:var(--brand-green)]" />
        </Link>

        {hasScrollButtons && (
          <div className="hidden items-center gap-2 xl:flex">
            <button
              onClick={onScrollLeft}
              className="grid size-8 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-[color:var(--brand-green)] hover:text-[color:var(--brand-green)]"
              aria-label="Scroll left"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              onClick={onScrollRight}
              className="grid size-8 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-[color:var(--brand-green)] hover:text-[color:var(--brand-green)]"
              aria-label="Scroll right"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}