import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  fetchAdminDashboard,
  fetchAdminNotifications,
  fetchAnalyticsRevenue,
  fetchAnalyticsRevenueMonthly,
  fetchAnalyticsTopTours,
  fetchBookingsPerDay,
  fetchConversionRate,
  fetchPopularTours,
  fetchRevenuePerMonth,
  fetchRevenueRatingCorrelation,
  fetchRevenueSummary,
  fetchStripeRevenue,
  fetchStripeRevenueLive,
  fetchUserStats,
  invalidateAnalyticsCache,
} from "./api";

export const analyticsKeys = {
  all: ["analytics"],
  dashboard: () => [...analyticsKeys.all, "admin-dashboard"],
  notifications: () => [...analyticsKeys.all, "admin-notifications"],
  revenue: () => [...analyticsKeys.all, "revenue"],
  stripeRevenue: () => [...analyticsKeys.all, "stripe-revenue"],
  stripeRevenueLive: () => [...analyticsKeys.all, "stripe-revenue-live"],
  revenuePerMonth: (params) => [...analyticsKeys.all, "revenue-per-month", params],
  bookingsPerDay: (params) => [...analyticsKeys.all, "bookings-per-day", params],
  conversionRate: () => [...analyticsKeys.all, "conversion-rate"],
  userStats: () => [...analyticsKeys.all, "user-stats"],
  popularTours: (params) => [...analyticsKeys.all, "popular-tours", params],
  analyticsRevenue: () => [...analyticsKeys.all, "analytics-revenue"],
  analyticsRevenueMonthly: (params) => [...analyticsKeys.all, "analytics-revenue-monthly", params],
  topTours: (params) => [...analyticsKeys.all, "top-tours", params],
  revenueRatingCorrelation: () => [...analyticsKeys.all, "revenue-rating-correlation"],
};

export function useAdminDashboard() {
  return useQuery({ queryKey: analyticsKeys.dashboard(), queryFn: ({ signal }) => fetchAdminDashboard({ signal }) });
}

export function useAdminNotifications() {
  return useQuery({
    queryKey: analyticsKeys.notifications(),
    queryFn: ({ signal }) => fetchAdminNotifications({ signal }),
  });
}

export function useRevenueSummary() {
  return useQuery({ queryKey: analyticsKeys.revenue(), queryFn: ({ signal }) => fetchRevenueSummary({ signal }) });
}

export function useStripeRevenue() {
  return useQuery({
    queryKey: analyticsKeys.stripeRevenue(),
    queryFn: ({ signal }) => fetchStripeRevenue({ signal }),
  });
}

export function useStripeRevenueLive() {
  return useQuery({
    queryKey: analyticsKeys.stripeRevenueLive(),
    queryFn: ({ signal }) => fetchStripeRevenueLive({ signal }),
    refetchInterval: 60_000,
  });
}

export function useRevenuePerMonth(params) {
  return useQuery({
    queryKey: analyticsKeys.revenuePerMonth(params),
    queryFn: ({ signal }) => fetchRevenuePerMonth({ signal, params }),
  });
}

export function useBookingsPerDay(params) {
  return useQuery({
    queryKey: analyticsKeys.bookingsPerDay(params),
    queryFn: ({ signal }) => fetchBookingsPerDay({ signal, params }),
  });
}

export function useConversionRate() {
  return useQuery({
    queryKey: analyticsKeys.conversionRate(),
    queryFn: ({ signal }) => fetchConversionRate({ signal }),
  });
}

export function useUserStats() {
  return useQuery({ queryKey: analyticsKeys.userStats(), queryFn: ({ signal }) => fetchUserStats({ signal }) });
}

export function usePopularTours(params) {
  return useQuery({
    queryKey: analyticsKeys.popularTours(params),
    queryFn: ({ signal }) => fetchPopularTours({ signal, params }),
  });
}

export function useAnalyticsRevenue() {
  return useQuery({
    queryKey: analyticsKeys.analyticsRevenue(),
    queryFn: ({ signal }) => fetchAnalyticsRevenue({ signal }),
  });
}

export function useAnalyticsRevenueMonthly(params) {
  return useQuery({
    queryKey: analyticsKeys.analyticsRevenueMonthly(params),
    queryFn: ({ signal }) => fetchAnalyticsRevenueMonthly({ signal, params }),
  });
}

export function useAnalyticsTopTours(params) {
  return useQuery({
    queryKey: analyticsKeys.topTours(params),
    queryFn: ({ signal }) => fetchAnalyticsTopTours({ signal, params }),
  });
}

export function useRevenueRatingCorrelation() {
  return useQuery({
    queryKey: analyticsKeys.revenueRatingCorrelation(),
    queryFn: ({ signal }) => fetchRevenueRatingCorrelation({ signal }),
  });
}

export function useInvalidateAnalyticsCache() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: invalidateAnalyticsCache,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: analyticsKeys.all });
      toast.success("Analytics cache refreshed");
    },
    onError: (error) => {
      toast.error(error?.message || "Could not refresh analytics cache");
    },
  });
}
