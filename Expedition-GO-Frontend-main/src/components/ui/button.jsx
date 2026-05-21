import * as React from "react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold transition-all disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--brand-green)]/30",
  {
    variants: {
      variant: {
        default:
          "bg-[color:var(--brand-green)] text-white shadow-[0_12px_30px_rgba(1,49,26,0.22)] hover:bg-[color:var(--brand-green-2)]",
        outline:
          "border border-[color:var(--brand-green)]/15 bg-white text-[color:var(--brand-green)] hover:border-[color:var(--brand-green)]/35 hover:bg-[color:var(--brand-mist)]",
        ghost:
          "text-[color:var(--brand-green)] hover:bg-[color:var(--brand-mist)]",
        subtle:
          "bg-[color:var(--brand-mist)] text-[color:var(--brand-green)] hover:bg-[color:var(--brand-sand)]",
      },
      size: {
        default: "h-11 px-5",
        sm: "h-9 px-4 text-xs",
        lg: "h-13 px-6 text-base",
        icon: "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({ className, variant, size, asChild = false, ...props }) {
  const Comp = asChild ? React.Fragment : "button";

  if (asChild) {
    const child = React.Children.only(props.children);
    return React.cloneElement(child, {
      className: cn(buttonVariants({ variant, size, className }), child.props.className),
    });
  }

  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
