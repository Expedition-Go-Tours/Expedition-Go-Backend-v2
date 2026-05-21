import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { safeNumber } from "@/utils/format";

const COLORS = ["#0f9f7a", "#0b74ff", "#f59e0b", "#ef4444", "#a855f7", "#0891b2"];

export function RolesPieChart({ data }) {
  const safeData = Array.isArray(data)
    ? data
        .map((entry) => ({
          name: entry.name ?? entry.role ?? entry.label ?? entry._id ?? "Unknown",
          value: safeNumber(entry.value ?? entry.count ?? entry.total ?? 0),
        }))
        .filter((entry) => entry.value > 0)
    : [];

  if (safeData.length === 0) {
    return (
      <div className="grid h-60 place-items-center rounded-xl border border-dashed border-[color:var(--admin-border)] text-sm text-[color:var(--admin-muted)]">
        Not enough data to render breakdown.
      </div>
    );
  }

  return (
    <div className="h-72 w-full" role="img" aria-label="User role distribution">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip
            contentStyle={{
              borderRadius: 8,
              border: "1px solid var(--admin-border)",
              background: "var(--admin-panel)",
              color: "var(--admin-text)",
              fontSize: 12,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Pie
            data={safeData}
            dataKey="value"
            nameKey="name"
            innerRadius={60}
            outerRadius={100}
            paddingAngle={2}
          >
            {safeData.map((_, index) => (
              <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
