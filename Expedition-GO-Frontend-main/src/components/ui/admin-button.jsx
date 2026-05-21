import * as React from "react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";

const adminButtonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-all disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--admin-ring)]",
  {
    variants: {
      variant: {
        default:
          "bg-[color:var(--admin-brand)] text-white shadow-[0_10px_24px_rgba(15,159,122,0.25)] hover:bg-[color:var(--admin-brand-dark)]",
        outline:
          "border border-[color:var(--admin-border)] bg-[color:var(--admin-panel)] text-[color:var(--admin-text)] hover:bg-[color:var(--admin-border-soft)]",
        ghost:
          "text-[color:var(--admin-text-soft)] hover:bg-[color:var(--admin-border-soft)]",
        soft:
          "bg-[color:var(--admin-brand-soft)] text-[color:var(--admin-brand-dark)] hover:bg-[color:var(--admin-brand-soft)]/80",
        danger:
          "bg-[color:var(--admin-danger)] text-white hover:opacity-90",
        link:
          "h-auto px-0 py-0 text-[color:var(--admin-brand-dark)] hover:underline",
      },
      size: {
        default: "h-10 px-4",
        sm: "h-8 px-3 text-xs",
        lg: "h-12 px-6 text-base",
        icon: "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

const AdminButton = React.forwardRef(function AdminButton(
  { className, variant, size, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(adminButtonVariants({ variant, size, className }))}
      {...props}
    />
  );
});

export { AdminButton, adminButtonVariants };
