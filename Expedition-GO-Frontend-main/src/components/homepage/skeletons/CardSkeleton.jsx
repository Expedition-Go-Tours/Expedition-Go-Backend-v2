import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export function CardSkeleton({ delay = 0 }) {
  return (
    <Card className="overflow-hidden rounded-[12px] border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06)]">
      <Skeleton className="h-40 xl:h-44 w-full rounded-none" delay={delay} />
      <CardContent className="p-3.5 xl:p-4">
        <div className="flex items-center gap-2 mb-2">
          <Skeleton className="h-5 w-5 rounded-full" delay={delay + 30} />
          <Skeleton className="h-3 w-20" delay={delay + 30} />
        </div>
        <Skeleton className="h-5 w-full mb-1.5" delay={delay + 50} />
        <Skeleton className="h-5 w-4/5 mb-3" delay={delay + 60} />
        <div className="flex items-center gap-1.5 mb-3">
          <Skeleton className="h-3 w-3 rounded-sm" delay={delay + 70} />
          <Skeleton className="h-3 w-32" delay={delay + 70} />
        </div>
        <div className="flex items-end justify-between gap-3 mt-auto">
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-4 w-4 rounded-sm" delay={delay + 80} />
            <Skeleton className="h-3 w-8" delay={delay + 80} />
            <Skeleton className="h-3 w-12" delay={delay + 80} />
          </div>
          <div className="text-right">
            <Skeleton className="h-2.5 w-12 mb-1" delay={delay + 90} />
            <Skeleton className="h-5 w-16" delay={delay + 90} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function CompactCardSkeleton({ delay = 0 }) {
  return (
    <Card className="overflow-hidden rounded-[14px] border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06)]">
      <Skeleton className="h-40 w-full rounded-none" delay={delay} />
      <CardContent className="p-3">
        <Skeleton className="h-4 w-full mb-2" delay={delay + 30} />
        <Skeleton className="h-3 w-3/4 mb-2" delay={delay + 50} />
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-1">
            <Skeleton className="h-3 w-3 rounded-sm" delay={delay + 60} />
            <Skeleton className="h-3 w-8" delay={delay + 60} />
          </div>
          <Skeleton className="h-4 w-14" delay={delay + 70} />
        </div>
      </CardContent>
    </Card>
  );
}

export function DestinationCardSkeleton({ delay = 0 }) {
  return (
    <Card className="relative overflow-hidden rounded-[12px] border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06)]">
      <Skeleton className="h-32 xl:h-36 w-full rounded-none" delay={delay} />
      <div className="absolute bottom-3 left-3 right-3">
        <Skeleton className="h-5 w-3/4 mb-1" delay={delay + 30} />
        <Skeleton className="h-3 w-1/2" delay={delay + 50} />
      </div>
    </Card>
  );
}
