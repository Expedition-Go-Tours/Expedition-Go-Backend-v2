/**
 * Centralised list of admin/analytics endpoints used across feature hooks.
 * Keeping them here lets us swap or version paths from a single place.
 */
export const ADMIN_ENDPOINTS = {
  dashboard: "/admin/dashboard",
  notifications: "/admin/notifications",
  revenue: "/admin/revenue",
  stripeRevenue: "/admin/stripe-revenue",
  stripeRevenueLive: "/admin/stripe-revenue-live",
  revenuePerMonth: "/admin/revenue-per-month",
  bookingsPerDay: "/admin/bookings-per-day",
  conversionRate: "/admin/conversion-rate",
  userStats: "/admin/stats/users",
  popularTours: "/admin/popular-tours",
  users: "/admin/users",
  userById: (id) => `/admin/users/${id}`,
  userRole: (id) => `/admin/users/${id}/role`,
  userStatus: (id) => `/admin/users/${id}/status`,
  bookings: "/admin/bookings",
  bookingById: (id) => `/admin/bookings/${id}`,
  tourAvailability: (id) => `/admin/tours/${id}/availability`,
  tourById: (id) => `/admin/tours/${id}`,
  categories: "/admin/categories",
  categoryById: (id) => `/admin/categories/${id}`,
};

export const ANALYTICS_ENDPOINTS = {
  revenue: "/analytics/revenue",
  revenueMonthly: "/analytics/revenue/monthly",
  topTours: "/analytics/top-tours",
  revenueRatingCorrelation: "/analytics/revenue-rating-correlation",
  cacheInvalidate: "/analytics/cache/invalidate",
  tourAnalytics: (tourId) => `/tours/${tourId}/analytics`,
};

export const TOUR_ENDPOINTS = {
  top5: "/tours/top-5-tours",
  lastMinuteDeals: "/tours/last-minute-deals",
  toursWithin: ({ distance, latlng, unit = "km" }) =>
    `/tours/tours-within/${distance}/center/${latlng}/unit/${unit}`,
  list: "/tours",
  create: "/tours",
  detail: (id) => `/tours/${id}`,
  update: (id) => `/tours/${id}`,
  remove: (id) => `/tours/${id}`,
  related: (id) => `/tours/${id}/related`,
  relatedAdvanced: (id) => `/tours/${id}/related-advanced`,
  analytics: (id) => `/tours/${id}/analytics`,
  reviews: (tourId) => `/tours/${tourId}/reviews`,
};
