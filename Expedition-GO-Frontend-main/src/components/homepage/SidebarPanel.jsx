import { BadgeCheck, CircleDollarSign, Handshake, ShieldCheck, Star, WalletCards } from "lucide-react";
import { useRef } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { CompactTourCard } from "./CompactTourCard";
import { SidebarDealCard } from "./SidebarDealCard";
import { lastMinuteDeals, sidebarTopRated } from "./data";

const _icons = [BadgeCheck, CircleDollarSign, ShieldCheck, Handshake, WalletCards, Star];

function PanelHeading({ title, linkTo }) {
  const { t } = useTranslation();
  
  return (
    <div className="relative z-30 isolate mb-[0.6375rem] flex items-center justify-between gap-2 md:mb-2.5 xl:mb-3">
      <h3 
        className="font-bold tracking-tight text-slate-900 leading-[1.15]"
        style={{ fontSize: 'clamp(1.2rem, 1.2vw + 0.5rem, 1.375rem)' }}
      >
        {title}
      </h3>
      <Link
        to={linkTo}
        onClick={() => window.scrollTo({ top: 0, behavior: "auto" })}
        className="group relative inline-flex min-h-[44px] min-w-[44px] shrink-0 touch-manipulation items-center justify-center gap-1 whitespace-nowrap rounded-md px-3 py-2 text-[13px] font-semibold text-slate-700 transition hover:bg-slate-100/90 hover:text-slate-950 sm:text-[13px] xl:text-[14px]"
      >
        <span className="relative">
          {t('sections.viewAll')}
          <span className="absolute bottom-0 left-0 h-0.5 w-0 bg-[color:var(--brand-green)] transition-all duration-300 group-hover:w-full" />
        </span>
      </Link>
    </div>
  );
}

function SwipeableSection({ children, _itemCount, originalChildren, className, scrollClassName }) {
  const scrollRef = useRef(null);

  return (
    <>
      {/* Desktop: Grid layout - show original items only */}
      <div className={cn("hidden xl:grid xl:grid-cols-2 xl:gap-3", className)}>
        {originalChildren}
      </div>

      {/* Mobile/Tablet: Native horizontal scroll */}
      <div 
        ref={scrollRef}
        className={cn(
          "xl:hidden overflow-x-auto overflow-y-hidden flex gap-3 snap-x snap-mandatory scrollbar-hide",
          scrollClassName,
        )}
        style={{ 
          WebkitOverflowScrolling: 'touch',
          scrollSnapType: 'x mandatory'
        }}
      >
        {children}
      </div>
    </>
  );
}

export function SidebarPanel() {
  const { t } = useTranslation();
  const sidebarNewExperiences = [...sidebarTopRated, ...sidebarTopRated.slice(0, 2)];
  
  return (
    <aside className="space-y-[1.7rem] overflow-hidden md:space-y-6 xl:mt-13 xl:space-y-5">
      <Card className="rounded-[18px] border border-slate-200 bg-white shadow-sm overflow-hidden">
        <CardContent className="p-4 overflow-hidden">
          <PanelHeading title={t('sections.lastMinuteDeals')} linkTo="/tours?category=last-minute-deals" />
          <SwipeableSection 
            itemCount={lastMinuteDeals.length}
            originalChildren={lastMinuteDeals.map((deal) => (
              <div key={deal.title} className="xl:w-auto">
                <SidebarDealCard {...deal} />
              </div>
            ))}
          >
            {lastMinuteDeals.map((deal, index) => (
              <div key={`${deal.title}-${index}`} className="w-[280px] flex-shrink-0 snap-start">
                <div className="pointer-events-auto">
                  <SidebarDealCard {...deal} />
                </div>
              </div>
            ))}
          </SwipeableSection>
        </CardContent>
      </Card>
      
<div className="mt-23">
      <Card className="h-auto rounded-[18px] border border-slate-200 bg-white shadow-sm overflow-hidden">
        <CardContent className="p-4 overflow-hidden">
          <PanelHeading title={t('sections.newExperiences')} linkTo="/tours?category=new-experiences" />
          <SwipeableSection 
            className="xl:gap-x-3 xl:gap-y-[calc(0.99rem*2.015)]"
            itemCount={sidebarNewExperiences.length}
            originalChildren={sidebarNewExperiences.map((tour, index) => (
              <div key={`${tour.title}-${index}`} className="xl:w-auto">
                <CompactTourCard {...tour} badge="new" />
              </div>
            ))}
          >
            {sidebarNewExperiences.map((tour, index) => (
              <div key={`${tour.title}-${index}`} className="w-[280px] flex-shrink-0 snap-start">
                <div className="pointer-events-auto">
                  <CompactTourCard {...tour} badge="new" />
                </div>
              </div>
            ))}
          </SwipeableSection>
        </CardContent>
      </Card>
  </div>

      {/* <Card className="rounded-[18px] border border-slate-200 bg-[#fafaf8] shadow-sm">
        <CardContent className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          {trustFeatures.map((item, index) => {
            const Icon = icons[index];

            return (
              <div key={item.title} className="flex items-start gap-3">
                <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-[color:var(--brand-green)]/12 bg-white text-[color:var(--brand-green)]">
                  <Icon className="size-[18px]" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                  <p className="mt-1 text-[13px] leading-6 text-slate-500">{item.description}</p>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card> */}
    </aside>
  );
}
