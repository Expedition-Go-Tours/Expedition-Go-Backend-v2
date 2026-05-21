import { Activity, CalendarDays, DollarSign, TrendingUp, Users } from "lucide-react";

import {
  AdminCard,
  AdminCardContent,
  AdminCardDescription,
  AdminCardHeader,
  AdminCardTitle,
} from "@/components/ui/admin-card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill, pillToneForBookingStatus } from "@/components/ui/status-pill";
import {
  useAdminDashboard,
  useAdminNotifications,
  useBookingsPerDay,
  useConversionRate,
  usePopularTours,
  useRevenuePerMonth,
  useRevenueSummary,
  useUserStats,
} from "@/features/analytics/hooks";
import { useAdminBookings } from "@/features/bookings/hooks";
import { BookingsChart } from "@/features/analytics/components/BookingsChart";
import { RevenueChart } from "@/features/analytics/components/RevenueChart";
import { RolesPieChart } from "@/features/analytics/components/RolesPieChart";
import { KpiCard } from "@/features/analytics/components/KpiCard";
import { extractList, extractScalar } from "@/utils/extractList";
import { formatCompact, formatCurrency, formatNumber, formatRelative, safeNumber } from "@/utils/format";

function safeDeltaFromObj(obj) {
  if (!obj) return undefined;
  const candidates = ["change", "growth", "trend", "delta", "percentChange", "growthRate"];
  for (const key of candidates) {
    if (typeof obj[key] === "number") return obj[key];
    const nested = obj?.data?.[key];
    if (typeof nested === "number") return nested;
  }
  return undefined;
}

function pickRevenueValue(payload) {
  return safeNumber(
    extractScalar(payload, ["total", "totalRevenue", "revenue", "amount", "value"], 0),
    0,
  );
}

function pickUsersTotal(payload) {
  return safeNumber(
    extractScalar(payload, ["total", "totalUsers", "count", "users"], 0),
    0,
  );
}

function pickBookingsTotal(payload) {
  return safeNumber(
    extractScalar(payload, ["total", "totalBookings", "count", "bookings"], 0),
    0,
  );
}

function pickConversion(payload) {
  return safeNumber(
    extractScalar(payload, ["rate", "conversion", "conversionRate", "value", "percentage"], 0),
    0,
  );
}

export default function OverviewPage() {
  const dashboardQuery = useAdminDashboard();
  const revenueQuery = useRevenueSummary();
  const userStatsQuery = useUserStats();
  const conversionQuery = useConversionRate();
  const revenuePerMonthQuery = useRevenuePerMonth();
  const bookingsPerDayQuery = useBookingsPerDay();
  const popularToursQuery = usePopularTours();
  const bookingsQuery = useAdminBookings({ limit: 5, sort: "-createdAt" });
  const notificationsQuery = useAdminNotifications();

  const dashboard = dashboardQuery.data || {};
  const revenue = pickRevenueValue(dashboard?.revenue || revenueQuery.data || dashboard);
  const userTotals = pickUsersTotal(dashboard?.users || userStatsQuery.data || dashboard);
  const bookingsTotal = pickBookingsTotal(dashboard?.bookings || dashboard);
  const conversion = pickConversion(conversionQuery.data || dashboard?.conversion || {});

  const revenueDelta = safeDeltaFromObj(dashboard?.revenue) ?? safeDeltaFromObj(revenueQuery.data);
  const usersDelta = safeDeltaFromObj(dashboard?.users) ?? safeDeltaFromObj(userStatsQuery.data);
  const bookingsDelta = safeDeltaFromObj(dashboard?.bookings) ?? safeDeltaFromObj(bookingsPerDayQuery.data);
  const conversionDelta = safeDeltaFromObj(conversionQuery.data);

  const revenueSeries = extractList(revenuePerMonthQuery.data, ["months", "data", "revenue"]);
  const bookingsSeries = extractList(bookingsPerDayQuery.data, ["days", "data", "bookings"]);
  const userBreakdown = extractList(userStatsQuery.data, ["roles", "byRole", "distribution"]);
  const popularTours = extractList(popularToursQuery.data, ["tours", "popularTours", "items"]);
  const recentBookings = extractList(bookingsQuery.data, ["bookings"]).slice(0, 5);
  const notifications = extractList(notificationsQuery.data, ["notifications"]).slice(0, 6);

  return (
    <div className="grid gap-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {revenueQuery.isLoading ? (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-2xl" />)
        ) : (
          <>
            <KpiCard
              icon={DollarSign}
              accent="brand"
              label="Total revenue"
              value={formatCurrency(revenue)}
              helperText="All-time platform revenue"
              delta={revenueDelta}
            />
            <KpiCard
              icon={Users}
              accent="info"
              label="Total users"
              value={formatNumber(userTotals)}
              helperText="Travellers + admins"
              delta={usersDelta}
            />
            <KpiCard
              icon={CalendarDays}
              accent="warning"
              label="Total bookings"
              value={formatNumber(bookingsTotal)}
              helperText="All booking channels"
              delta={bookingsDelta}
            />
            <KpiCard
              icon={TrendingUp}
              accent="success"
              label="Conversion"
              value={`${safeNumber(conversion).toFixed(2)}%`}
              helperText="Visit → booking rate"
              delta={conversionDelta}
            />
          </>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <AdminCard className="lg:col-span-2">
          <AdminCardHeader>
            <div>
              <AdminCardTitle>Revenue trend</AdminCardTitle>
              <AdminCardDescription>Monthly revenue for the platform</AdminCardDescription>
            </div>
          </AdminCardHeader>
          <AdminCardContent>
            {revenuePerMonthQuery.isLoading ? (
              <Skeleton className="h-64 rounded-xl" />
            ) : (
              <RevenueChart data={revenueSeries} />
            )}
          </AdminCardContent>
        </AdminCard>

        <AdminCard>
          <AdminCardHeader>
            <div>
              <AdminCardTitle>User roles</AdminCardTitle>
              <AdminCardDescription>Distribution across your team</AdminCardDescription>
            </div>
          </AdminCardHeader>
          <AdminCardContent>
            {userStatsQuery.isLoading ? (
              <Skeleton className="h-64 rounded-xl" />
            ) : (
              <RolesPieChart data={userBreakdown} />
            )}
          </AdminCardContent>
        </AdminCard>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <AdminCard className="lg:col-span-2">
          <AdminCardHeader>
            <div>
              <AdminCardTitle>Bookings per day</AdminCardTitle>
              <AdminCardDescription>Recent activity volume</AdminCardDescription>
            </div>
          </AdminCardHeader>
          <AdminCardContent>
            {bookingsPerDayQuery.isLoading ? (
              <Skeleton className="h-64 rounded-xl" />
            ) : (
              <BookingsChart data={bookingsSeries} />
            )}
          </AdminCardContent>
        </AdminCard>

        <AdminCard>
          <AdminCardHeader>
            <div>
              <AdminCardTitle>Notifications</AdminCardTitle>
              <AdminCardDescription>Latest activity</AdminCardDescription>
            </div>
          </AdminCardHeader>
          <AdminCardContent>
            <ul className="space-y-3">
              {notificationsQuery.isLoading
                ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-12 rounded-xl" />)
                : notifications.length > 0
                  ? notifications.map((notice, idx) => (
                      <li
                        key={notice?._id || notice?.id || idx}
                        className="flex items-start gap-3 rounded-xl border border-[color:var(--admin-border)] bg-[color:var(--admin-panel-2)] p-3"
                      >
                        <span className="mt-1 grid size-8 shrink-0 place-items-center rounded-lg bg-[color:var(--admin-brand-soft)] text-[color:var(--admin-brand-dark)]">
                          <Activity className="size-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-[color:var(--admin-text)]">
                            {notice?.title || notice?.message || notice?.name || "Notification"}
                          </p>
                          <p className="text-xs text-[color:var(--admin-muted)]">
                            {formatRelative(notice?.createdAt || notice?.updatedAt || notice?.timestamp)}
                          </p>
                        </div>
                      </li>
                    ))
                  : (
                    <li className="rounded-xl border border-dashed border-[color:var(--admin-border)] p-4 text-center text-sm text-[color:var(--admin-muted)]">
                      You&apos;re all caught up.
                    </li>
                  )}
            </ul>
          </AdminCardContent>
        </AdminCard>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <AdminCard>
          <AdminCardHeader>
            <div>
              <AdminCardTitle>Recent bookings</AdminCardTitle>
              <AdminCardDescription>Latest reservations across products</AdminCardDescription>
            </div>
          </AdminCardHeader>
          <AdminCardContent>
            <ul className="divide-y divide-[color:var(--admin-border)]">
              {bookingsQuery.isLoading
                ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="my-2 h-10 rounded-xl" />)
                : recentBookings.length > 0
                  ? recentBookings.map((booking, idx) => {
                      const tour =
                        booking?.tour?.name ||
                        booking?.tourName ||
                        booking?.product ||
                        booking?.title ||
                        "Tour";
                      const customer =
                        booking?.user?.name || booking?.customer || booking?.guestName || "Guest";
                      const amount = booking?.amount ?? booking?.totalAmount ?? booking?.price ?? booking?.total;
                      const status = booking?.status || "pending";
                      return (
                        <li
                          key={booking?._id || booking?.id || idx}
                          className="flex items-center gap-3 py-3"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-[color:var(--admin-text)]">{tour}</p>
                            <p className="text-xs text-[color:var(--admin-muted)]">
                              {customer} • {formatRelative(booking?.createdAt || booking?.updatedAt)}
                            </p>
                          </div>
                          <span className="text-sm font-semibold text-[color:var(--admin-text)]">
                            {amount !== undefined ? formatCurrency(amount, booking?.currency) : "—"}
                          </span>
                          <StatusPill tone={pillToneForBookingStatus(status)}>{status}</StatusPill>
                        </li>
                      );
                    })
                  : (
                    <li className="py-6 text-center text-sm text-[color:var(--admin-muted)]">
                      No bookings yet.
                    </li>
                  )}
            </ul>
          </AdminCardContent>
        </AdminCard>

        <AdminCard>
          <AdminCardHeader>
            <div>
              <AdminCardTitle>Popular tours</AdminCardTitle>
              <AdminCardDescription>Top performing experiences</AdminCardDescription>
            </div>
          </AdminCardHeader>
          <AdminCardContent>
            <ul className="space-y-3">
              {popularToursQuery.isLoading
                ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-12 rounded-xl" />)
                : popularTours.length > 0
                  ? popularTours.slice(0, 5).map((tour, idx) => {
                      const name = tour?.name || tour?.title || tour?.tourName || "Tour";
                      const bookings = tour?.bookings ?? tour?.totalBookings ?? tour?.count;
                      const rev = tour?.revenue ?? tour?.totalRevenue ?? tour?.amount;
                      return (
                        <li
                          key={tour?._id || tour?.id || idx}
                          className="flex items-center gap-3 rounded-xl border border-[color:var(--admin-border)] bg-[color:var(--admin-panel-2)] p-3"
                        >
                          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[color:var(--admin-brand-soft)] text-xs font-bold text-[color:var(--admin-brand-dark)]">
                            #{idx + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-[color:var(--admin-text)]">{name}</p>
                            <p className="text-xs text-[color:var(--admin-muted)]">
                              {bookings !== undefined ? `${formatCompact(bookings)} bookings` : "—"}
                            </p>
                          </div>
                          <span className="text-sm font-semibold text-[color:var(--admin-text)]">
                            {rev !== undefined ? formatCurrency(rev) : "—"}
                          </span>
                        </li>
                      );
                    })
                  : (
                    <li className="rounded-xl border border-dashed border-[color:var(--admin-border)] p-4 text-center text-sm text-[color:var(--admin-muted)]">
                      Performance data appears once you have bookings.
                    </li>
                  )}
            </ul>
          </AdminCardContent>
        </AdminCard>
      </div>
    </div>
  );
}
