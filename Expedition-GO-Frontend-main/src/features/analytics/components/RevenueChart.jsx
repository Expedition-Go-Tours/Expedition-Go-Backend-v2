import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatCompact, formatCurrency, safeNumber } from "@/utils/format";

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  const value = payload[0]?.value;
  return (
    <div className="rounded-lg border border-[color:var(--admin-border)] bg-[color:var(--admin-panel)] px-3 py-2 text-xs shadow-[var(--admin-shadow)]">
      <p className="font-semibold text-[color:var(--admin-text)]">{label}</p>
      <p className="text-[color:var(--admin-muted)]">
        Revenue: <span className="font-semibold text-[color:var(--admin-brand-dark)]">{formatCurrency(value)}</span>
      </p>
    </div>
  );
}

export function RevenueChart({ data }) {
  const safeData = Array.isArray(data)
    ? data.map((entry) => ({
        label: entry.label ?? entry.month ?? entry.name ?? entry._id ?? "",
        value: safeNumber(
          entry.value ?? entry.revenue ?? entry.total ?? entry.amount ?? entry.totalRevenue ?? 0,
        ),
      }))
    : [];

  return (
    <div className="h-72 w-full" role="img" aria-label="Revenue trend chart">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={safeData} margin={{ top: 10, right: 12, left: -10, bottom: 0 }}>
          <defs>
            <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--admin-brand)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--admin-brand)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--admin-border)" strokeDasharray="4 6" vertical={false} />
          <XAxis dataKey="label" stroke="var(--admin-muted)" fontSize={12} tickLine={false} axisLine={false} />
          <YAxis
            stroke="var(--admin-muted)"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => formatCompact(v)}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--admin-brand)", strokeOpacity: 0.18 }} />
          <Area
            type="monotone"
            dataKey="value"
            stroke="var(--admin-brand)"
            strokeWidth={2.5}
            fill="url(#revenueFill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
