import { Download, RefreshCcw, Star } from "lucide-react";

import { AdminButton } from "@/components/ui/admin-button";
import {
  AdminCard,
  AdminCardContent,
  AdminCardDescription,
  AdminCardHeader,
  AdminCardTitle,
} from "@/components/ui/admin-card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  StatusPill,
  pillToneForBookingStatus,
} from "@/components/ui/status-pill";
import { useAuth } from "@/components/auth/AuthProvider";
import { isAdminUser } from "@/lib/rbac";
import {
  useAnalyticsRevenue,
  useAnalyticsRevenueMonthly,
  useAnalyticsTopTours,
  useInvalidateAnalyticsCache,
  useRevenueRatingCorrelation,
} from "@/features/analytics/hooks";
import { RevenueChart } from "@/features/analytics/components/RevenueChart";
import { extractList, extractScalar } from "@/utils/extractList";
import { formatCurrency, formatNumber, safeNumber } from "@/utils/format";
import { downloadCsv, toCsv } from "@/utils/csv";

export default function AnalyticsPage() {
  const { user } = useAuth();
  const showAdminControls = isAdminUser(user);

  const revenueSummary = useAnalyticsRevenue();
  const monthly = useAnalyticsRevenueMonthly();
  const topTours = useAnalyticsTopTours();
  const correlation = useRevenueRatingCorrelation();
  const invalidate = useInvalidateAnalyticsCache();

  const totalRevenue = safeNumber(extractScalar(revenueSummary.data, ["total", "revenue", "amount"], 0));
  const monthlyData = extractList(monthly.data, ["months", "data", "revenue"]);
  const topToursData = extractList(topTours.data, ["tours", "items", "topTours"]);
  const correlationPoints = extractList(correlation.data, ["points", "data", "items"]);

  function handleExportTopTours() {
    if (!topToursData.length) return;
    const csv = toCsv(topToursData, [
      { key: "name", label: "Tour", accessor: (t) => t?.name || t?.title },
      {
        key: "bookings",
        label: "Bookings",
        accessor: (t) => t?.bookings ?? t?.totalBookings ?? t?.count,
      },
      {
        key: "revenue",
        label: "Revenue",
        accessor: (t) => t?.revenue ?? t?.totalRevenue ?? t?.amount,
      },
      {
        key: "rating",
        label: "Rating",
        accessor: (t) => t?.rating ?? t?.averageRating,
      },
    ]);
    downloadCsv(`top-tours-${Date.now()}.csv`, csv);
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-[color:var(--admin-text)]">Analytics & reports</h2>
          <p className="text-sm text-[color:var(--admin-muted)]">
            Revenue trends, top performers and CSV exports for your team.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AdminButton variant="outline" onClick={handleExportTopTours} disabled={!topToursData.length}>
            <Download className="size-4" /> Export top tours
          </AdminButton>
          {showAdminControls ? (
            <AdminButton onClick={() => invalidate.mutate()} disabled={invalidate.isPending}>
              <RefreshCcw className={`size-4 ${invalidate.isPending ? "animate-spin" : ""}`} /> Refresh cache
            </AdminButton>
          ) : null}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <AdminCard className="lg:col-span-2">
          <AdminCardHeader>
            <div>
              <AdminCardTitle>Revenue trend</AdminCardTitle>
              <AdminCardDescription>Monthly revenue across the platform</AdminCardDescription>
            </div>
          </AdminCardHeader>
          <AdminCardContent>
            {monthly.isLoading ? <Skeleton className="h-72 rounded-xl" /> : <RevenueChart data={monthlyData} />}
          </AdminCardContent>
        </AdminCard>

        <AdminCard>
          <AdminCardHeader>
            <div>
              <AdminCardTitle>Total revenue</AdminCardTitle>
              <AdminCardDescription>Lifetime, all currencies (USD eq.)</AdminCardDescription>
            </div>
          </AdminCardHeader>
          <AdminCardContent>
            {revenueSummary.isLoading ? (
              <Skeleton className="h-32 rounded-xl" />
            ) : (
              <div className="flex h-full flex-col justify-between rounded-xl bg-[color:var(--admin-brand-soft)] p-5">
                <p className="text-3xl font-bold text-[color:var(--admin-brand-dark)]">
                  {formatCurrency(totalRevenue)}
                </p>
                <p className="mt-3 text-xs text-[color:var(--admin-brand-dark)]/80">
                  Across {formatNumber(monthlyData.length)} reporting periods.
                </p>
              </div>
            )}
          </AdminCardContent>
        </AdminCard>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <AdminCard>
          <AdminCardHeader>
            <div>
              <AdminCardTitle>Top revenue tours</AdminCardTitle>
              <AdminCardDescription>Best earners in the selected period</AdminCardDescription>
            </div>
          </AdminCardHeader>
          <AdminCardContent>
            <ul className="space-y-3">
              {topTours.isLoading
                ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-12 rounded-xl" />)
                : topToursData.length === 0
                  ? (
                    <li className="rounded-xl border border-dashed border-[color:var(--admin-border)] p-4 text-center text-sm text-[color:var(--admin-muted)]">
                      No data available yet.
                    </li>
                  )
                  : topToursData.slice(0, 8).map((tour, idx) => {
                      const name = tour?.name || tour?.title || "Tour";
                      const revenue = tour?.revenue ?? tour?.totalRevenue ?? tour?.amount;
                      const bookings = tour?.bookings ?? tour?.totalBookings ?? tour?.count;
                      return (
                        <li
                          key={tour?._id || tour?.id || idx}
                          className="flex items-center gap-3 rounded-xl border border-[color:var(--admin-border)] bg-[color:var(--admin-panel-2)] p-3"
                        >
                          <span className="grid size-9 place-items-center rounded-lg bg-[color:var(--admin-brand)] text-xs font-bold text-white">
                            #{idx + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-[color:var(--admin-text)]">{name}</p>
                            <p className="text-xs text-[color:var(--admin-muted)]">
                              {bookings !== undefined ? `${formatNumber(bookings)} bookings` : "—"}
                            </p>
                          </div>
                          <span className="text-sm font-semibold text-[color:var(--admin-text)]">
                            {revenue !== undefined ? formatCurrency(revenue) : "—"}
                          </span>
                        </li>
                      );
                    })}
            </ul>
          </AdminCardContent>
        </AdminCard>

        <AdminCard>
          <AdminCardHeader>
            <div>
              <AdminCardTitle>Revenue × Rating</AdminCardTitle>
              <AdminCardDescription>How quality drives revenue</AdminCardDescription>
            </div>
          </AdminCardHeader>
          <AdminCardContent>
            <ul className="space-y-3">
              {correlation.isLoading
                ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-12 rounded-xl" />)
                : correlationPoints.length === 0
                  ? (
                    <li className="rounded-xl border border-dashed border-[color:var(--admin-border)] p-4 text-center text-sm text-[color:var(--admin-muted)]">
                      Not enough data yet.
                    </li>
                  )
                  : correlationPoints.slice(0, 8).map((point, idx) => {
                      const tour = point?.name || point?.tourName || point?.title || `Tour ${idx + 1}`;
                      const rating = point?.rating ?? point?.averageRating ?? 0;
                      const revenue = point?.revenue ?? point?.totalRevenue ?? point?.amount;
                      const status = point?.status || (rating >= 4.5 ? "confirmed" : rating >= 4 ? "pending" : "cancelled");
                      return (
                        <li
                          key={point?._id || point?.id || idx}
                          className="flex items-center gap-3 rounded-xl border border-[color:var(--admin-border)] bg-[color:var(--admin-panel-2)] p-3"
                        >
                          <Star className="size-5 text-[color:var(--admin-warning)]" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-[color:var(--admin-text)]">{tour}</p>
                            <p className="text-xs text-[color:var(--admin-muted)]">
                              {Number(rating).toFixed(2)} / 5
                            </p>
                          </div>
                          <span className="text-sm font-semibold text-[color:var(--admin-text)]">
                            {revenue !== undefined ? formatCurrency(revenue) : "—"}
                          </span>
                          <StatusPill tone={pillToneForBookingStatus(status)}>{status}</StatusPill>
                        </li>
                      );
                    })}
            </ul>
          </AdminCardContent>
        </AdminCard>
      </div>
    </div>
  );
}
