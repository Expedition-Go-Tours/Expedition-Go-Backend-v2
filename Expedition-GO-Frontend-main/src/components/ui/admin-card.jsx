import { cn } from "@/lib/utils";

function AdminCard({ className, ...props }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-[color:var(--admin-border)] bg-[color:var(--admin-panel)] shadow-[var(--admin-shadow-soft)]",
        className,
      )}
      {...props}
    />
  );
}

function AdminCardHeader({ className, ...props }) {
  return <div className={cn("flex items-start justify-between gap-3 px-5 pb-3 pt-5", className)} {...props} />;
}

function AdminCardTitle({ className, ...props }) {
  return (
    <h3
      className={cn("text-sm font-semibold uppercase tracking-[0.18em] text-[color:var(--admin-muted)]", className)}
      {...props}
    />
  );
}

function AdminCardDescription({ className, ...props }) {
  return <p className={cn("text-sm text-[color:var(--admin-muted)]", className)} {...props} />;
}

function AdminCardContent({ className, ...props }) {
  return <div className={cn("px-5 pb-5", className)} {...props} />;
}

function AdminCardFooter({ className, ...props }) {
  return (
    <div
      className={cn("flex items-center justify-between gap-3 border-t border-[color:var(--admin-border)] px-5 py-3", className)}
      {...props}
    />
  );
}

export {
  AdminCard,
  AdminCardHeader,
  AdminCardTitle,
  AdminCardDescription,
  AdminCardContent,
  AdminCardFooter,
};
