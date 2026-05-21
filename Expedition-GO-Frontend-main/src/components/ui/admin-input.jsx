import * as React from "react";

import { cn } from "@/lib/utils";

const AdminInput = React.forwardRef(function AdminInput({ className, type = "text", ...props }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-10 w-full rounded-lg border border-[color:var(--admin-border)] bg-[color:var(--admin-panel)] px-3 py-2 text-sm text-[color:var(--admin-text)] outline-none transition placeholder:text-[color:var(--admin-muted)] focus:border-[color:var(--admin-brand)] focus:ring-2 focus:ring-[color:var(--admin-ring)] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});

const AdminTextarea = React.forwardRef(function AdminTextarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-24 w-full rounded-lg border border-[color:var(--admin-border)] bg-[color:var(--admin-panel)] px-3 py-2 text-sm text-[color:var(--admin-text)] outline-none transition placeholder:text-[color:var(--admin-muted)] focus:border-[color:var(--admin-brand)] focus:ring-2 focus:ring-[color:var(--admin-ring)] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});

const AdminLabel = React.forwardRef(function AdminLabel({ className, ...props }, ref) {
  return (
    <label
      ref={ref}
      className={cn("text-xs font-semibold uppercase tracking-wider text-[color:var(--admin-muted)]", className)}
      {...props}
    />
  );
});

export { AdminInput, AdminTextarea, AdminLabel };
