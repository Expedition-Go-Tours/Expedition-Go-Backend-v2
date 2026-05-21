import { cn } from "@/lib/utils";

const TONE_STYLES = {
  default:
    "bg-[color:var(--admin-border-soft)] text-[color:var(--admin-text-soft)] border-[color:var(--admin-border)]",
  success:
    "bg-[color:var(--admin-success-soft)] text-[color:var(--admin-success)] border-transparent",
  warning:
    "bg-[color:var(--admin-warning-soft)] text-[color:var(--admin-warning)] border-transparent",
  danger:
    "bg-[color:var(--admin-danger-soft)] text-[color:var(--admin-danger)] border-transparent",
  info:
    "bg-[color:var(--admin-info-soft)] text-[color:var(--admin-info)] border-transparent",
  brand:
    "bg-[color:var(--admin-brand-soft)] text-[color:var(--admin-brand-dark)] border-transparent",
};

export function StatusPill({ tone = "default", className, ...props }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold capitalize",
        TONE_STYLES[tone] || TONE_STYLES.default,
        className,
      )}
      {...props}
    />
  );
}

export function pillToneForBookingStatus(status) {
  const v = String(status || "").toLowerCase();
  if (v === "confirmed" || v === "completed" || v === "paid") return "success";
  if (v === "pending" || v === "processing") return "warning";
  if (v === "cancelled" || v === "refunded" || v === "failed") return "danger";
  return "default";
}

export function pillToneForUserStatus(status) {
  const v = String(status || "").toLowerCase();
  if (v === "active" || v === "enabled" || v === "verified") return "success";
  if (v === "pending" || v === "invited") return "warning";
  if (v === "disabled" || v === "banned" || v === "suspended") return "danger";
  return "default";
}

export function pillToneForRole(role) {
  const v = String(role || "").toLowerCase();
  if (v === "admin") return "brand";
  if (v === "manager") return "info";
  if (v === "agent") return "warning";
  return "default";
}
