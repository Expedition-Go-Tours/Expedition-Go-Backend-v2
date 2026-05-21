import { useNavigate } from "react-router-dom";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  DollarSign,
  ShoppingCart,
  Package,
  Users,
  TrendingUp,
  TrendingDown,
  ArrowUpRight,
  AlertCircle,
  Clock,
  ChevronRight,
  CalendarCheck,
  Star,
} from "lucide-react";
import StatusBadge from "@/components/shared/StatusBadge";
import { formatCurrency, formatDate } from "@/lib/utils";

const REVENUE_DATA = [
  { month: "Dec", revenue: 38000 },
  { month: "Jan", revenue: 42000 },
  { month: "Feb", revenue: 35000 },
  { month: "Mar", revenue: 51000 },
  { month: "Apr", revenue: 48000 },
  { month: "May", revenue: 62500 },
];

const BOOKING_STATUS_DATA = [
  { name: "Confirmed", value: 68, color: "#00d67f" },
  { name: "Pending", value: 15, color: "#ffc400" },
  { name: "Cancelled", value: 8, color: "#dc3545" },
  { name: "Refunded", value: 9, color: "#298dff" },
];

const RECENT_BOOKINGS = [
  { id: "BK-2026-0001", customer: "John Smith", tour: "Serengeti Safari Adventure", date: "2026-05-18", amount: 2400, status: "CONFIRMED" },
  { id: "BK-2026-0002", customer: "Sarah Johnson", tour: "Zanzibar Beach Escape", date: "2026-05-17", amount: 1800, status: "AWAITING_CONFIRMATION" },
  { id: "BK-2026-0003", customer: "Michael Brown", tour: "Kilimanjaro Trek", date: "2026-05-15", amount: 3200, status: "CONFIRMED" },
  { id: "BK-2026-0004", customer: "Emily Davis", tour: "Masai Mara Wildlife Tour", date: "2026-05-14", amount: 1950, status: "CANCELLED" },
  { id: "BK-2026-0005", customer: "Robert Wilson", tour: "Victoria Falls Expedition", date: "2026-05-13", amount: 2800, status: "CONFIRMED" },
];

const PENDING_ITEMS = [
  { label: "Awaiting Confirmation", count: 2, route: "/bookings?tab=AWAITING_CONFIRMATION", color: "text-[#ffc400]", bg: "bg-[#fffbeb]" },
  { label: "Refund Requests", count: 1, route: "/bookings?tab=REFUND_REQUEST", color: "text-[#f97316]", bg: "bg-[#fff7ed]" },
  { label: "Reviews to Moderate", count: 12, route: "/reviews", color: "text-[#044b3b]", bg: "bg-[#f0fdf4]" },
  { label: "Supplier Applications", count: 1, route: "/users?roleFilter=SUPPLIER&statusFilter=PENDING", color: "text-[#1d4ed8]", bg: "bg-[#eff6ff]" },
];

function StatCard({ title, value, change, isPositive, icon: Icon, color }) {
  return (
    <div className="bg-white rounded-lg border border-[#eaeaea] p-5 hover:shadow-md transition-shadow">
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
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-[#eaeaea] rounded-lg shadow-lg p-3">
        <p className="text-sm font-medium text-[#1e293b] mb-1">{label}</p>
        <p className="text-xs text-[#64748b]">
          Revenue: {formatCurrency(payload[0].value)}
        </p>
      </div>
    );
  }
  return null;
};

export default function DashboardPage() {
  const navigate = useNavigate();

  return (
    <div className="p-4 md:p-6">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-xl md:text-2xl font-bold text-[#1e293b]">Dashboard</h1>
        <p className="text-sm text-[#64748b] mt-1">Welcome back! Here's what's happening with your business.</p>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          title="Total Revenue"
          value="$124,580"
          change={12.5}
          isPositive={true}
          icon={DollarSign}
          color="bg-[#044b3b]"
        />
        <StatCard
          title="Active Bookings"
          value="1,240"
          change={8.2}
          isPositive={true}
          icon={ShoppingCart}
          color="bg-[#0f766e]"
        />
        <StatCard
          title="Total Products"
          value="48"
          change={3}
          isPositive={true}
          icon={Package}
          color="bg-[#18ddef]"
        />
        <StatCard
          title="New Customers"
          value="156"
          change={-2.1}
          isPositive={false}
          icon={Users}
          color="bg-[#ffc400]"
        />
      </div>

      {/* Quick Actions / Pending Items */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {PENDING_ITEMS.map((item) => (
          <button
            key={item.label}
            onClick={() => navigate(item.route)}
            className={`flex items-center justify-between p-4 rounded-lg border border-[#eaeaea] hover:shadow-md transition-all text-left ${item.bg}`}
          >
            <div>
              <p className={`text-2xl font-bold ${item.color}`}>{item.count}</p>
              <p className="text-sm text-[#64748b] mt-0.5">{item.label}</p>
            </div>
            <ChevronRight size={18} className="text-[#9e9e9e]" />
          </button>
        ))}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Revenue Chart */}
        <div className="lg:col-span-2 bg-white rounded-lg border border-[#eaeaea] p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-[#1e293b]">Revenue Trend</h3>
            <span className="text-xs text-[#64748b]">Last 6 months</span>
          </div>
          <ResponsiveContainer width="100%" height={250}>
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
              <Area type="monotone" dataKey="revenue" stroke="#044b3b" strokeWidth={2} fillOpacity={1} fill="url(#colorRevenue)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Booking Status Distribution */}
        <div className="bg-white rounded-lg border border-[#eaeaea] p-5">
          <h3 className="text-sm font-semibold text-[#1e293b] mb-4">Booking Status</h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={BOOKING_STATUS_DATA}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={80}
                paddingAngle={3}
                dataKey="value"
              >
                {BOOKING_STATUS_DATA.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
          <div className="mt-2 space-y-1.5">
            {BOOKING_STATUS_DATA.map((item) => (
              <div key={item.name} className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }} />
                  <span className="text-[#64748b]">{item.name}</span>
                </span>
                <span className="font-medium text-[#1e293b]">{item.value}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Bookings */}
        <div className="bg-white rounded-lg border border-[#eaeaea] p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-[#1e293b]">Recent Bookings</h3>
            <button
              onClick={() => navigate("/bookings")}
              className="text-xs text-[#044b3b] font-medium hover:underline flex items-center gap-1"
            >
              View All
              <ArrowUpRight size={12} />
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#eaeaea]">
                  <th className="text-left py-2 text-xs font-semibold text-[#64748b] uppercase">Booking</th>
                  <th className="text-left py-2 text-xs font-semibold text-[#64748b] uppercase">Customer</th>
                  <th className="text-left py-2 text-xs font-semibold text-[#64748b] uppercase">Amount</th>
                  <th className="text-left py-2 text-xs font-semibold text-[#64748b] uppercase">Status</th>
                </tr>
              </thead>
              <tbody>
                {RECENT_BOOKINGS.map((booking) => (
                  <tr key={booking.id} className="border-b border-[#eaeaea] last:border-0 hover:bg-[#f8fafc] transition-colors">
                    <td className="py-3">
                      <p className="text-sm font-medium text-[#044b3b]">{booking.id}</p>
                      <p className="text-xs text-[#64748b]">{formatDate(booking.date)}</p>
                    </td>
                    <td className="py-3">
                      <p className="text-sm text-[#1e293b]">{booking.customer}</p>
                      <p className="text-xs text-[#64748b] truncate max-w-[150px]">{booking.tour}</p>
                    </td>
                    <td className="py-3 font-medium text-[#1e293b]">{formatCurrency(booking.amount)}</td>
                    <td className="py-3">
                      <StatusBadge status={booking.status} label={booking.status.replace(/_/g, " ")} size="sm" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Popular Tours */}
        <div className="bg-white rounded-lg border border-[#eaeaea] p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-[#1e293b]">Top Performing Tours</h3>
            <button
              onClick={() => navigate("/performance")}
              className="text-xs text-[#044b3b] font-medium hover:underline flex items-center gap-1"
            >
              View Details
              <ArrowUpRight size={12} />
            </button>
          </div>
          <div className="space-y-4">
            {[
              { name: "Serengeti Safari Adventure", bookings: 342, revenue: 142000, rating: 4.8 },
              { name: "Victoria Falls Expedition", bookings: 203, revenue: 98000, rating: 4.7 },
              { name: "Okavango Delta Safari", bookings: 156, revenue: 87000, rating: 4.8 },
              { name: "Kilimanjaro Trek", bookings: 89, revenue: 76000, rating: 4.9 },
              { name: "Zanzibar Beach Escape", bookings: 145, revenue: 54000, rating: 4.6 },
            ].map((tour, index) => (
              <div key={tour.name} className="flex items-center gap-3">
                <span className="w-5 text-xs font-bold text-[#64748b]">{index + 1}</span>
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-sm font-medium text-[#1e293b]">{tour.name}</p>
                    <span className="text-xs text-[#64748b]">{tour.bookings} bookings</span>
                  </div>
                  <div className="w-full h-1.5 bg-[#f8fafc] rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[#044b3b]"
                      style={{ width: `${(tour.bookings / 342) * 100}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
