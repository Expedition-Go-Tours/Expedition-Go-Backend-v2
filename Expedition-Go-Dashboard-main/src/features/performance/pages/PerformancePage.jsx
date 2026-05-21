import { useState } from "react";
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { TrendingUp, TrendingDown, Calendar, DollarSign, Users, ShoppingCart, ArrowUpRight } from "lucide-react";
import { format, subMonths } from "date-fns";

// Mock revenue data (last 6 months)
const REVENUE_DATA = Array.from({ length: 6 }, (_, i) => {
  const month = subMonths(new Date(), 5 - i);
  return {
    month: format(month, "MMM yyyy"),
    revenue: 45000 + Math.random() * 35000,
    bookings: 120 + Math.floor(Math.random() * 80),
    target: 50000,
  };
});

// Booking funnel data
const FUNNEL_DATA = [
  { stage: "Page Views", count: 15420, percentage: 100 },
  { stage: "Product View", count: 8230, percentage: 53.4 },
  { stage: "Add to Cart", count: 3450, percentage: 22.4 },
  { stage: "Checkout", count: 1890, percentage: 12.2 },
  { stage: "Payment", count: 1240, percentage: 8.0 },
  { stage: "Completed", count: 1080, percentage: 7.0 },
];

// Top tours performance
const TOP_TOURS = [
  { name: "Serengeti Safari Adventure", revenue: 142000, bookings: 342, conversion: 8.4 },
  { name: "Victoria Falls Expedition", revenue: 98000, bookings: 203, conversion: 7.2 },
  { name: "Okavango Delta Safari", revenue: 87000, bookings: 156, conversion: 6.8 },
  { name: "Kilimanjaro Trek", revenue: 76000, bookings: 89, conversion: 5.9 },
  { name: "Zanzibar Beach Escape", revenue: 54000, bookings: 145, conversion: 5.3 },
  { name: "Masai Mara Wildlife Tour", revenue: 42000, bookings: 98, conversion: 4.8 },
];

// Revenue by category
const CATEGORY_DATA = [
  { name: "Safari", value: 45, color: "#044b3b" },
  { name: "Beach", value: 20, color: "#0f766e" },
  { name: "Adventure", value: 15, color: "#18ddef" },
  { name: "Trekking", value: 12, color: "#ffc400" },
  { name: "City", value: 8, color: "#9e9e9e" },
];

// KPICard component
function KPICard({ title, value, change, changeLabel, icon: Icon, color }) {
  const isPositive = change >= 0;
  return (
    <div className="bg-white rounded-lg border border-[#eaeaea] p-5">
      <div className="flex items-center justify-between mb-3">
        <div className={`w-10 h-10 rounded-lg ${color} bg-opacity-10 flex items-center justify-center`}>
          <Icon size={20} className={color.replace("bg-", "text-")} />
        </div>
        <div className={`flex items-center gap-1 text-xs font-medium ${isPositive ? "text-[#00d67f]" : "text-[#dc3545]"}`}>
          {isPositive ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
          {Math.abs(change)}%
        </div>
      </div>
      <p className="text-2xl font-bold text-[#1e293b]">{value}</p>
      <p className="text-sm text-[#64748b] mt-1">{title}</p>
      <p className="text-xs text-[#9e9e9e] mt-1">{changeLabel}</p>
    </div>
  );
}

// Custom tooltip for charts
const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-[#eaeaea] rounded-lg shadow-lg p-3">
        <p className="text-sm font-medium text-[#1e293b] mb-1">{label}</p>
        {payload.map((entry, index) => (
          <p key={index} className="text-xs text-[#64748b]">
            <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: entry.color }} />
            {entry.name}: {entry.value.toLocaleString()}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

export default function PerformancePage() {
  const [dateRange, setDateRange] = useState("6months");

  return (
    <div className="p-4 md:p-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-[#1e293b]">Performance</h1>
          <p className="text-sm text-[#64748b] mt-1">Analytics and insights for your business</p>
        </div>
        <select
          value={dateRange}
          onChange={(e) => setDateRange(e.target.value)}
          className="px-3 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
        >
          <option value="7days">Last 7 Days</option>
          <option value="30days">Last 30 Days</option>
          <option value="6months">Last 6 Months</option>
          <option value="1year">Last Year</option>
        </select>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <KPICard
          title="Total Revenue"
          value="$124,580"
          change={12.5}
          changeLabel="vs last month"
          icon={DollarSign}
          color="bg-[#044b3b]"
        />
        <KPICard
          title="Total Bookings"
          value="1,240"
          change={8.2}
          changeLabel="vs last month"
          icon={ShoppingCart}
          color="bg-[#0f766e]"
        />
        <KPICard
          title="Conversion Rate"
          value="7.0%"
          change={-2.1}
          changeLabel="vs last month"
          icon={ArrowUpRight}
          color="bg-[#18ddef]"
        />
        <KPICard
          title="Active Customers"
          value="3,420"
          change={15.3}
          changeLabel="vs last month"
          icon={Users}
          color="bg-[#ffc400]"
        />
      </div>

      {/* Charts Row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Revenue Trend */}
        <div className="lg:col-span-2 bg-white rounded-lg border border-[#eaeaea] p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-[#1e293b]">Revenue Trend</h3>
            <div className="flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-[#044b3b]" />
                Revenue
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-[#eaeaea]" />
                Target
              </span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={REVENUE_DATA}>
              <defs>
                <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#044b3b" stopOpacity={0.1} />
                  <stop offset="95%" stopColor="#044b3b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#64748b" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 12, fill: "#64748b" }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v / 1000}k`} />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="revenue"
                stroke="#044b3b"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#colorRevenue)"
                name="Revenue"
              />
              <Line
                type="monotone"
                dataKey="target"
                stroke="#eaeaea"
                strokeWidth={2}
                strokeDasharray="5 5"
                dot={false}
                name="Target"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Revenue by Category */}
        <div className="bg-white rounded-lg border border-[#eaeaea] p-5">
          <h3 className="text-sm font-semibold text-[#1e293b] mb-4">Revenue by Category</h3>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={CATEGORY_DATA}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={100}
                paddingAngle={4}
                dataKey="value"
              >
                {CATEGORY_DATA.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
          <div className="mt-4 space-y-2">
            {CATEGORY_DATA.map((cat) => (
              <div key={cat.name} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: cat.color }} />
                  <span className="text-[#1e293b]">{cat.name}</span>
                </span>
                <span className="text-[#64748b] font-medium">{cat.value}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Charts Row 2 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Booking Funnel */}
        <div className="bg-white rounded-lg border border-[#eaeaea] p-5">
          <h3 className="text-sm font-semibold text-[#1e293b] mb-4">Booking Conversion Funnel</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={FUNNEL_DATA} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 12, fill: "#64748b" }} axisLine={false} tickLine={false} />
              <YAxis dataKey="stage" type="category" tick={{ fontSize: 12, fill: "#1e293b" }} axisLine={false} tickLine={false} width={100} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="count" fill="#044b3b" radius={[0, 4, 4, 0]} name="Count" />
            </BarChart>
          </ResponsiveContainer>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4 text-center">
            {[
              { label: "Page Views", value: "15,420" },
              { label: "Add to Cart", value: "3,450" },
              { label: "Conversion", value: "7.0%" },
            ].map((stat) => (
              <div key={stat.label} className="p-3 bg-[#f8fafc] rounded-lg">
                <p className="text-lg font-bold text-[#1e293b]">{stat.value}</p>
                <p className="text-xs text-[#64748b]">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Top Performing Tours */}
        <div className="bg-white rounded-lg border border-[#eaeaea] p-5">
          <h3 className="text-sm font-semibold text-[#1e293b] mb-4">Top Performing Tours</h3>
          <div className="space-y-4">
            {TOP_TOURS.map((tour, index) => (
              <div key={tour.name} className="flex items-center gap-4">
                <span className="w-6 text-sm font-bold text-[#64748b]">{index + 1}</span>
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-sm font-medium text-[#1e293b]">{tour.name}</p>
                    <p className="text-sm font-bold text-[#044b3b]">${(tour.revenue / 1000).toFixed(0)}k</p>
                  </div>
                  <div className="w-full h-2 bg-[#f8fafc] rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[#044b3b]"
                      style={{ width: `${(tour.revenue / TOP_TOURS[0].revenue) * 100}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between mt-1 text-xs text-[#64748b]">
                    <span>{tour.bookings} bookings</span>
                    <span>{tour.conversion}% conversion</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Monthly Bookings Chart */}
      <div className="bg-white rounded-lg border border-[#eaeaea] p-5">
        <h3 className="text-sm font-semibold text-[#1e293b] mb-4">Monthly Bookings vs Target</h3>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={REVENUE_DATA}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#64748b" }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 12, fill: "#64748b" }} axisLine={false} tickLine={false} />
            <Tooltip content={<CustomTooltip />} />
            <Legend />
            <Bar dataKey="bookings" fill="#044b3b" radius={[4, 4, 0, 0]} name="Bookings" />
            <Bar dataKey="target" fill="#eaeaea" radius={[4, 4, 0, 0]} name="Target" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
