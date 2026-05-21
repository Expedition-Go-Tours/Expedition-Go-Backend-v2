import { Skeleton } from "@/components/ui/skeleton";
import { CardSkeleton, DestinationCardSkeleton } from "./CardSkeleton";

export function TourCarouselSkeleton({ delay = 0 }) {
  return (
    <section className="py-4 md:py-4 xl:py-5">
      {/* Section Heading */}
      <div className="mb-[0.6375rem] flex items-start justify-between gap-4 md:mb-2.5 xl:mb-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-7 w-56" delay={delay} />
          <Skeleton className="h-3 w-72" delay={delay + 20} />
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Skeleton className="h-5 w-20" delay={delay + 30} />
          <div className="hidden xl:flex items-center gap-2">
            <Skeleton className="size-8 rounded-full" delay={delay + 40} />
            <Skeleton className="size-8 rounded-full" delay={delay + 40} />
          </div>
        </div>
      </div>

      {/* Cards */}
      <div className="hidden xl:flex gap-3 overflow-hidden">
        {[0, 30, 60, 90].map((cardDelay, i) => (
          <div key={i} className="min-w-[280px] shrink-0">
            <CardSkeleton delay={delay + 50 + cardDelay} />
          </div>
        ))}
      </div>
      <div className="xl:hidden flex gap-3 overflow-hidden">
        {[0, 30, 60].map((cardDelay, i) => (
          <div key={i} className="w-[280px] shrink-0">
            <CardSkeleton delay={delay + 50 + cardDelay} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function DestinationsSkeleton({ delay = 0 }) {
  return (
    <section className="py-4 md:py-4 xl:py-5">
      {/* Section Heading */}
      <div className="mb-[0.6375rem] flex items-start justify-between gap-4 md:mb-2.5 xl:mb-3">
        <div className="min-w-0 flex-1">
          <Skeleton className="h-7 w-64" delay={delay} />
        </div>
        <Skeleton className="h-5 w-20" delay={delay + 20} />
      </div>

      {/* Cards */}
      <div className="hidden xl:flex gap-3 overflow-hidden">
        {[0, 25, 50, 75].map((cardDelay, i) => (
          <div key={i} className="min-w-[280px] shrink-0">
            <DestinationCardSkeleton delay={delay + 40 + cardDelay} />
          </div>
        ))}
      </div>
      <div className="xl:hidden flex gap-3 overflow-hidden">
        {[0, 25, 50].map((cardDelay, i) => (
          <div key={i} className="w-[280px] shrink-0">
            <DestinationCardSkeleton delay={delay + 40 + cardDelay} />
          </div>
        ))}
      </div>
    </section>
  );
}
