import { cn } from "@/lib/utils";

function Card({ className, ...props }) {
  return (
    <div
      className={cn(
        "rounded-b-[12px] border border-white/70 bg-white shadow-[0_18px_45px_rgba(15,23,42,0.08)]",
        className,
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }) {
  return <div className={cn("p-5", className)} {...props} />;
}

export { Card, CardContent };
