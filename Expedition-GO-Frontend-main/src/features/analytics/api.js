import { apiRequest, unwrap } from "@/api/client";
import { ADMIN_ENDPOINTS, ANALYTICS_ENDPOINTS } from "@/api/endpoints";

export async function fetchAdminDashboard({ signal } = {}) {
  return unwrap(await apiRequest(ADMIN_ENDPOINTS.dashboard, { signal }));
}

export async function fetchAdminNotifications({ signal } = {}) {
  return unwrap(await apiRequest(ADMIN_ENDPOINTS.notifications, { signal }));
}

export async function fetchRevenueSummary({ signal } = {}) {
  return unwrap(await apiRequest(ADMIN_ENDPOINTS.revenue, { signal }));
}

export async function fetchStripeRevenue({ signal } = {}) {
  return unwrap(await apiRequest(ADMIN_ENDPOINTS.stripeRevenue, { signal }));
}

export async function fetchStripeRevenueLive({ signal } = {}) {
  return unwrap(await apiRequest(ADMIN_ENDPOINTS.stripeRevenueLive, { signal }));
}

export async function fetchRevenuePerMonth({ signal, params } = {}) {
  return unwrap(await apiRequest(ADMIN_ENDPOINTS.revenuePerMonth, { signal, params }));
}

export async function fetchBookingsPerDay({ signal, params } = {}) {
  return unwrap(await apiRequest(ADMIN_ENDPOINTS.bookingsPerDay, { signal, params }));
}

export async function fetchConversionRate({ signal } = {}) {
  return unwrap(await apiRequest(ADMIN_ENDPOINTS.conversionRate, { signal }));
}

export async function fetchUserStats({ signal } = {}) {
  return unwrap(await apiRequest(ADMIN_ENDPOINTS.userStats, { signal }));
}

export async function fetchPopularTours({ signal, params } = {}) {
  return unwrap(await apiRequest(ADMIN_ENDPOINTS.popularTours, { signal, params }));
}

export async function fetchAnalyticsRevenue({ signal } = {}) {
  return unwrap(await apiRequest(ANALYTICS_ENDPOINTS.revenue, { signal }));
}

export async function fetchAnalyticsRevenueMonthly({ signal, params } = {}) {
  return unwrap(await apiRequest(ANALYTICS_ENDPOINTS.revenueMonthly, { signal, params }));
}

export async function fetchAnalyticsTopTours({ signal, params } = {}) {
  return unwrap(await apiRequest(ANALYTICS_ENDPOINTS.topTours, { signal, params }));
}

export async function fetchRevenueRatingCorrelation({ signal } = {}) {
  return unwrap(await apiRequest(ANALYTICS_ENDPOINTS.revenueRatingCorrelation, { signal }));
}

export async function invalidateAnalyticsCache() {
  return unwrap(await apiRequest(ANALYTICS_ENDPOINTS.cacheInvalidate, { method: "POST" }));
}
