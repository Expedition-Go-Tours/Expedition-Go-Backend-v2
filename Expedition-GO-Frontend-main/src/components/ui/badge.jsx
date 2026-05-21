import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold tracking-[0.14em] uppercase",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[color:var(--brand-green)] text-white",
        outline: "border-[color:var(--brand-green)]/15 bg-white text-[color:var(--brand-green)]",
        soft: "border-transparent bg-[color:var(--brand-mist)] text-[color:var(--brand-green)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({ className, variant, ...props }) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge };
