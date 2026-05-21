import { cn } from "@/lib/utils";

function Skeleton({ className, delay = 0, ...props }) {
  return (
    <div
      className={cn("relative overflow-hidden rounded-md bg-slate-200/70 before:absolute before:inset-0 before:-translate-x-full before:animate-[skeletonShimmer_1.5s_ease-in-out_infinite] before:bg-gradient-to-r before:from-transparent before:via-white/80 before:to-transparent", className)}
      style={{ animationDelay: delay > 0 ? `${delay}ms` : undefined }}
      {...props}
    />
  );
}

export { Skeleton };
