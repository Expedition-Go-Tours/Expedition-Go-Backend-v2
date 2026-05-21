import { Skeleton } from "@/components/ui/skeleton";

function SidebarDealCardSkeleton({ delay = 0 }) {
  return (
    <div className="overflow-hidden rounded-[14px] border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06)]">
      <div className="relative">
        <Skeleton className="h-36 w-full rounded-none" delay={delay} />
        <Skeleton className="absolute left-2 top-2 h-5 w-16 rounded-md" delay={delay + 20} />
        <Skeleton className="absolute right-2 top-2 size-6 rounded-full" delay={delay + 20} />
      </div>
      <div className="p-4 xl:p-3.5 space-y-3">
        <Skeleton className="h-4 w-full" delay={delay + 30} />
        <Skeleton className="h-4 w-4/5" delay={delay + 40} />
        <div className="flex items-end justify-between gap-2">
          <div className="space-y-1 flex-1">
            <Skeleton className="h-2.5 w-12" delay={delay + 50} />
            <div className="flex items-baseline gap-1.5">
              <Skeleton className="h-3 w-12" delay={delay + 60} />
              <Skeleton className="h-4 w-14" delay={delay + 60} />
            </div>
          </div>
          <Skeleton className="h-6 w-20 rounded-full" delay={delay + 70} />
        </div>
      </div>
    </div>
  );
}

function CompactCardSkeleton({ delay = 0 }) {
  return (
    <div className="overflow-hidden rounded-[14px] border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06)]">
      <div className="relative">
        <Skeleton className="h-40 w-full rounded-none" delay={delay} />
        <Skeleton className="absolute left-2 top-2 h-5 w-20 rounded-md" delay={delay + 20} />
        <Skeleton className="absolute right-2 top-2 size-6 rounded-full" delay={delay + 20} />
      </div>
      <div className="p-3 space-y-2">
        <Skeleton className="h-4 w-full" delay={delay + 30} />
        <Skeleton className="h-3 w-3/4" delay={delay + 40} />
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-1">
            <Skeleton className="h-3 w-3 rounded-sm" delay={delay + 50} />
            <Skeleton className="h-3 w-8" delay={delay + 50} />
          </div>
          <Skeleton className="h-4 w-14" delay={delay + 60} />
        </div>
      </div>
    </div>
  );
}

export function SidebarSkeleton() {
  return (
    <aside className="space-y-[1.7rem] overflow-hidden md:space-y-6 xl:mt-13 xl:space-y-5">
      {/* Last Minute Deals Section */}
      <div className="rounded-[18px] border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="p-4 overflow-hidden">
          <div className="mb-[0.6375rem] flex items-center justify-between md:mb-2.5 xl:mb-3">
            <Skeleton className="h-6 w-44" delay={0} />
            <Skeleton className="h-5 w-16" delay={20} />
          </div>
          {/* Desktop: Grid layout */}
          <div className="hidden xl:grid xl:grid-cols-2 xl:gap-3">
            {[0, 30, 60, 90].map((extraDelay, i) => (
              <SidebarDealCardSkeleton key={i} delay={40 + extraDelay} />
            ))}
          </div>
          {/* Mobile/Tablet: Show 2 cards */}
          <div className="xl:hidden flex gap-3 overflow-hidden">
            {[0, 30].map((extraDelay, i) => (
              <div key={i} className="w-[280px] flex-shrink-0">
                <SidebarDealCardSkeleton delay={40 + extraDelay} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* New Experiences Section */}
      <div className="mt-23">
      <div className="rounded-[18px] border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="p-4 overflow-hidden">
          <div className="mb-[0.6375rem] flex items-center justify-between md:mb-2.5 xl:mb-3">
            <Skeleton className="h-6 w-40" delay={0} />
            <Skeleton className="h-5 w-16" delay={20} />
          </div>
          {/* Desktop: Grid layout */}
          <div className="hidden xl:grid xl:grid-cols-2 xl:gap-3">
            {[0, 25, 50, 75, 100, 125].map((extraDelay, i) => (
              <CompactCardSkeleton key={i} delay={40 + extraDelay} />
            ))}
          </div>
          {/* Mobile/Tablet: Show 2 cards */}
          <div className="xl:hidden flex gap-3 overflow-hidden">
            {[0, 25].map((extraDelay, i) => (
              <div key={i} className="w-[280px] flex-shrink-0">
                <CompactCardSkeleton delay={40 + extraDelay} />
              </div>
            ))}
          </div>
        </div>
      </div>
      </div>
    </aside>
  );
}
