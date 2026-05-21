import { Skeleton } from "@/components/ui/skeleton";

export function HeroSkeleton() {
  return (
    <section
      id="home"
      className="relative min-h-[50vh] sm:min-h-[52vh] md:min-h-[50vh] lg:min-h-[52vh] xl:min-h-[60vh] flex items-start overflow-visible bg-[color:var(--brand-green)] pb-4 pt-[12vh] text-white"
    >
      <div className="absolute inset-0">
        <div className="h-full w-full bg-gradient-to-br from-slate-400/35 via-slate-300/25 to-slate-400/35" aria-hidden />
        <div
          className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.5),rgba(0,0,0,0.18)_25%,rgba(122,69,11,0.14)_60%,rgba(0,0,0,0.2)),radial-gradient(circle_at_center,rgba(255,174,58,0.28),transparent_42%)]"
          aria-hidden
        />
      </div>

      <div className="relative mx-auto w-full max-w-[1520px] overflow-visible px-2 py-10 sm:px-4 sm:py-14 md:py-16">
        <div className="mx-auto max-w-4xl text-center">
          <Skeleton className="mx-auto mt-4 h-9 w-full max-w-[min(100%,36rem)] sm:h-11 md:h-12" delay={0} />

          <Skeleton className="mx-auto mt-1 h-4 w-[min(100%,20rem)] max-w-full sm:h-5" delay={15} />

          <div className="mt-3 flex justify-center px-2">
            <Skeleton className="h-7 w-44 rounded-full" delay={30} />
          </div>

          <div className="relative mx-auto mt-4 w-full max-w-4xl sm:mt-3.5 md:mt-4 lg:max-w-2xl">
            <div className="mx-auto grid w-full grid-cols-[1fr_auto] gap-0 overflow-hidden rounded-lg border border-slate-200/90 bg-white shadow-md">
              <div className="flex items-center gap-2 px-2 py-1.5 text-left">
                <Skeleton className="size-3 shrink-0 rounded-sm" delay={45} />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-2.5 w-20" delay={50} />
                  <Skeleton className="h-4 w-full max-w-[220px]" delay={55} />
                </div>
              </div>
              <div className="p-1">
                <Skeleton className="h-full min-h-7 w-[76px] rounded-lg sm:min-h-8 sm:w-[88px]" delay={60} />
              </div>
            </div>
          </div>

          <div className="mt-3 hidden grid-cols-3 gap-2 sm:mt-3.5 md:mt-4 md:grid">
            {[0, 20, 40].map((extra) => (
              <div
                key={extra}
                className="space-y-2 rounded-lg border border-white/10 bg-black/20 px-2.5 py-2 backdrop-blur-sm"
              >
                <Skeleton className="mx-auto h-8 w-20 bg-slate-200/90" delay={75 + extra} />
                <Skeleton className="mx-auto h-3 w-24 max-w-full bg-slate-200/80" delay={85 + extra} />
              </div>
            ))}
          </div>

          <div className="mt-4 overflow-visible sm:mt-5 md:mt-6">
            <Skeleton className="mx-auto mb-3 h-4 w-48 max-w-[90%]" delay={100} />
            <div className="relative hidden justify-center pb-6 md:flex">
              <div className="flex max-w-full gap-3 overflow-hidden">
                {[0, 25, 50].map((extra) => (
                  <div key={extra} className="w-[280px] min-w-[280px] shrink-0">
                    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                      <Skeleton className="h-[120px] w-full rounded-none" delay={110 + extra} />
                      <div className="space-y-2 p-3">
                        <Skeleton className="h-3 w-4/5" delay={120 + extra} />
                        <Skeleton className="h-3 w-3/5" delay={125 + extra} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex gap-3 overflow-hidden pb-4 md:hidden">
              {[0, 25].map((extra) => (
                <div key={extra} className="w-[280px] shrink-0">
                  <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                    <Skeleton className="h-[120px] w-full rounded-none" delay={110 + extra} />
                    <div className="space-y-2 p-3">
                      <Skeleton className="h-3 w-4/5" delay={120 + extra} />
                      <Skeleton className="h-3 w-3/5" delay={125 + extra} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
