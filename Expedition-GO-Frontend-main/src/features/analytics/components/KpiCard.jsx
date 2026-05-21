import { ArrowDown, ArrowUp } from "lucide-react";

import { cn } from "@/lib/utils";

export function KpiCard({ icon: Icon, label, value, helperText, delta, accent = "brand" }) {
  const isPositive = typeof delta === "number" ? delta >= 0 : null;
  const accentClass = {
    brand: "bg-[color:var(--admin-brand-soft)] text-[color:var(--admin-brand-dark)]",
    info: "bg-[color:var(--admin-info-soft)] text-[color:var(--admin-info)]",
    warning: "bg-[color:var(--admin-warning-soft)] text-[color:var(--admin-warning)]",
    success: "bg-[color:var(--admin-success-soft)] text-[color:var(--admin-success)]",
    danger: "bg-[color:var(--admin-danger-soft)] text-[color:var(--admin-danger)]",
  }[accent] || "bg-[color:var(--admin-brand-soft)] text-[color:var(--admin-brand-dark)]";

  return (
    <div className="admin-fade-in rounded-2xl border border-[color:var(--admin-border)] bg-[color:var(--admin-panel)] p-5 shadow-[var(--admin-shadow-soft)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--admin-muted)]">
            {label}
          </p>
          <p className="mt-2 text-2xl font-bold tracking-tight text-[color:var(--admin-text)]">{value}</p>
        </div>
        {Icon ? (
          <span className={cn("grid size-10 place-items-center rounded-xl", accentClass)}>
            <Icon className="size-5" />
          </span>
        ) : null}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-[color:var(--admin-muted)]">
        {helperText ? <span>{helperText}</span> : <span />}
        {isPositive !== null ? (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold",
              isPositive
                ? "bg-[color:var(--admin-success-soft)] text-[color:var(--admin-success)]"
                : "bg-[color:var(--admin-danger-soft)] text-[color:var(--admin-danger)]",
            )}
          >
            {isPositive ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
            {Math.abs(delta).toFixed(1)}%
          </span>
        ) : null}
      </div>
    </div>
  );
}
