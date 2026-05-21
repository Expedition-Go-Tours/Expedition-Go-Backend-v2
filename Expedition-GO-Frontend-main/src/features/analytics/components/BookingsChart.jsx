import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatNumber, safeNumber } from "@/utils/format";

function BookingsTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-[color:var(--admin-border)] bg-[color:var(--admin-panel)] px-3 py-2 text-xs shadow-[var(--admin-shadow)]">
      <p className="font-semibold text-[color:var(--admin-text)]">{label}</p>
      <p className="text-[color:var(--admin-muted)]">
        Bookings:{" "}
        <span className="font-semibold text-[color:var(--admin-brand-dark)]">{formatNumber(payload[0]?.value)}</span>
      </p>
    </div>
  );
}

export function BookingsChart({ data }) {
  const safeData = Array.isArray(data)
    ? data.map((entry) => ({
        label: entry.label ?? entry.day ?? entry.date ?? entry.name ?? entry._id ?? "",
        value: safeNumber(
          entry.value ?? entry.count ?? entry.bookings ?? entry.total ?? entry.totalBookings ?? 0,
        ),
      }))
    : [];

  return (
    <div className="h-72 w-full" role="img" aria-label="Bookings per day chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={safeData} margin={{ top: 10, right: 12, left: -10, bottom: 0 }}>
          <CartesianGrid stroke="var(--admin-border)" strokeDasharray="4 6" vertical={false} />
          <XAxis dataKey="label" stroke="var(--admin-muted)" fontSize={12} tickLine={false} axisLine={false} />
          <YAxis stroke="var(--admin-muted)" fontSize={12} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: "var(--admin-brand-soft)" }} content={<BookingsTooltip />} />
          <Bar dataKey="value" fill="var(--admin-brand)" radius={[6, 6, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
