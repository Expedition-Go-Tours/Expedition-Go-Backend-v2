import { cn } from "@/lib/utils";

const STATUS_STYLES = {
  AWAITING_CONFIRMATION: {
    bg: "bg-[#fffbeb]",
    text: "text-[#b45309]",
    border: "border-[#fcd34d]",
    dot: "bg-[#ffc400]",
  },
  CONFIRMED: {
    bg: "bg-[#ebfcf5]",
    text: "text-[#047857]",
    border: "border-[#6ee7b7]",
    dot: "bg-[#00d67f]",
  },
  CANCELLED: {
    bg: "bg-[#ffebeb]",
    text: "text-[#b91c1c]",
    border: "border-[#fca5a5]",
    dot: "bg-[#dc3545]",
  },
  REJECTED: {
    bg: "bg-[#ffebeb]",
    text: "text-[#b91c1c]",
    border: "border-[#fca5a5]",
    dot: "bg-[#dc3545]",
  },
  REFUND_REQUEST: {
    bg: "bg-[#fff7ed]",
    text: "text-[#c2410c]",
    border: "border-[#fdba74]",
    dot: "bg-[#f97316]",
  },
  REFUNDED: {
    bg: "bg-[#eff6ff]",
    text: "text-[#1d4ed8]",
    border: "border-[#93c5fd]",
    dot: "bg-[#298dff]",
  },
  REFUND_REJECTED: {
    bg: "bg-[#f5f3ff]",
    text: "text-[#6d28d9]",
    border: "border-[#c4b5fd]",
    dot: "bg-[#7429f8]",
  },
  AMENDMENT_REQUEST: {
    bg: "bg-[#ecfeff]",
    text: "text-[#0e7490]",
    border: "border-[#67e8f9]",
    dot: "bg-[#18ddef]",
  },
  AMENDED: {
    bg: "bg-[#f0fdfa]",
    text: "text-[#0f766e]",
    border: "border-[#5eead4]",
    dot: "bg-[#0f766e]",
  },
  PAID: {
    bg: "bg-[#ebfcf5]",
    text: "text-[#047857]",
    border: "border-[#6ee7b7]",
    dot: "bg-[#00d67f]",
  },
  PENDING: {
    bg: "bg-[#fffbeb]",
    text: "text-[#b45309]",
    border: "border-[#fcd34d]",
    dot: "bg-[#ffc400]",
  },
  FAILED: {
    bg: "bg-[#ffebeb]",
    text: "text-[#b91c1c]",
    border: "border-[#fca5a5]",
    dot: "bg-[#dc3545]",
  },
  ACTIVE: {
    bg: "bg-[#ebfcf5]",
    text: "text-[#047857]",
    border: "border-[#6ee7b7]",
    dot: "bg-[#00d67f]",
  },
  INACTIVE: {
    bg: "bg-[#f8fafc]",
    text: "text-[#64748b]",
    border: "border-[#e2e8f0]",
    dot: "bg-[#9e9e9e]",
  },
  DRAFT: {
    bg: "bg-[#fffbeb]",
    text: "text-[#b45309]",
    border: "border-[#fcd34d]",
    dot: "bg-[#ffc400]",
  },
  PENDING_APPROVAL: {
    bg: "bg-[#eff6ff]",
    text: "text-[#1d4ed8]",
    border: "border-[#93c5fd]",
    dot: "bg-[#298dff]",
  },
};

export default function StatusBadge({ status, label, size = "sm" }) {
  const style = STATUS_STYLES[status] || STATUS_STYLES.INACTIVE;
  const sizeClasses = size === "sm" 
    ? "text-xs px-2 py-0.5" 
    : "text-sm px-2.5 py-1";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-medium",
        style.bg,
        style.text,
        style.border,
        sizeClasses
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full", style.dot)} />
      {label || status.replace(/_/g, " ")}
    </span>
  );
}
