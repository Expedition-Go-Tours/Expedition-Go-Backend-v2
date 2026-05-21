import { Navbar } from "@/components/homepage/Navbar";
import { Footer } from "@/components/homepage/Footer";
import { HeroSkeleton } from "./HeroSkeleton";
import { TourCarouselSkeleton, DestinationsSkeleton } from "./SectionSkeleton";
import { SidebarSkeleton } from "./SidebarSkeleton";
import { Skeleton } from "@/components/ui/skeleton";

export function HomePageSkeleton() {
  return (
    <div className="min-h-[100svh] min-h-screen overflow-x-hidden bg-[color:var(--page-bg)] pb-[env(safe-area-inset-bottom,0)] text-slate-900 supports-[min-height:100dvh]:min-h-[100dvh]">
      <Navbar />
      <div className="hidden lg:block lg:h-[104px]" />
      <div className="h-0 lg:hidden" />
      <HeroSkeleton />

      <main className="mx-auto w-full max-w-[1520px] overflow-hidden px-4 pb-[3.4rem] sm:px-6 sm:pb-14">
        <div className="grid gap-[1.65rem] min-[640px]:gap-[2.125rem] md:gap-8 xl:grid-cols-[minmax(0,1fr)_430px] xl:gap-7">
          <div className="min-w-0 space-y-[1.7rem] pt-[1.4875rem] md:space-y-6 md:pt-6 xl:space-y-5 xl:pt-5">
            <TourCarouselSkeleton delay={0} />
            <div className="space-y-[1.7rem] pt-0 md:space-y-6 md:pt-4 xl:space-y-4 xl:pt-5">
              <DestinationsSkeleton delay={50} />
              <TourCarouselSkeleton delay={100} />
              <TourCarouselSkeleton delay={150} />
              <TourCarouselSkeleton delay={200} />
            </div>
          </div>
          <div className="min-w-0 pt-[1.7rem] md:pt-6 xl:pt-4">
            <SidebarSkeleton />
          </div>
        </div>
      </main>

      <div className="mx-auto mb-[3.4rem] max-w-[1520px] overflow-hidden px-4 sm:px-6 md:mb-14">
        <section className="py-8 sm:py-12">
          <div className="grid items-stretch gap-0 overflow-hidden rounded-xl border border-slate-200 shadow-lg sm:rounded-2xl lg:grid-cols-2">
            <Skeleton className="h-[220px] rounded-none sm:h-[260px] lg:h-auto lg:min-h-[220px]" delay={0} />
            <div className="flex min-w-0 flex-col justify-center bg-[color:var(--brand-mist)] p-5 sm:p-8 lg:p-12">
              <Skeleton className="mb-3 h-9 w-full max-w-md" delay={20} />
              <Skeleton className="mb-5 h-4 w-full" delay={30} />
              <Skeleton className="mb-5 h-4 w-11/12 max-w-lg" delay={40} />
              <div className="flex flex-col gap-3 lg:flex-row">
                <Skeleton className="h-11 min-h-0 w-full flex-1 rounded-lg sm:h-12" delay={50} />
                <Skeleton className="h-11 w-full rounded-lg sm:h-12 lg:w-36 lg:shrink-0" delay={60} />
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="mx-auto mb-[3.4rem] max-w-[1520px] px-4 sm:px-6 md:mb-14">
        <section className="bg-white py-[2.125rem] md:py-8">
          <div className="grid grid-cols-3 gap-[1.1rem] sm:gap-4 lg:gap-6">
            {[0, 15, 30, 45, 60, 75].map((extraDelay, i) => (
              <div key={i} className="flex flex-col items-center text-center">
                <Skeleton className="size-10 rounded-full sm:size-12 lg:size-14" delay={40 + extraDelay} />
                <div className="mt-2.5 space-y-1.5 sm:mt-3">
                  <Skeleton className="mx-auto h-3 w-16 sm:h-3.5 sm:w-20" delay={50 + extraDelay} />
                  <Skeleton className="mx-auto h-3 w-20 sm:w-24" delay={60 + extraDelay} />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <Footer />
    </div>
  );
}
