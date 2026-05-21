// API Base URL
export const API_BASE_URL = "https://expedition-go-backend-v2.onrender.com/api";

// Booking Statuses (Viator-style)
export const BOOKING_STATUSES = {
  AWAITING_CONFIRMATION: {
    label: "Awaiting Confirmation",
    color: "warning",
    badgeColor: "#ffc400",
  },
  CONFIRMED: {
    label: "Confirmed",
    color: "success",
    badgeColor: "#00d67f",
  },
  CANCELLED: {
    label: "Cancelled",
    color: "danger",
    badgeColor: "#dc3545",
  },
  REJECTED: {
    label: "Rejected",
    color: "danger",
    badgeColor: "#dc3545",
  },
  REFUND_REQUEST: {
    label: "Refund Request",
    color: "warning",
    badgeColor: "#f97316",
  },
  REFUNDED: {
    label: "Refunded",
    color: "info",
    badgeColor: "#298dff",
  },
  REFUND_REJECTED: {
    label: "Refund Rejected",
    color: "danger",
    badgeColor: "#7429f8",
  },
  AMENDMENT_REQUEST: {
    label: "Amendment Request",
    color: "info",
    badgeColor: "#18ddef",
  },
  AMENDED: {
    label: "Amended",
    color: "secondary",
    badgeColor: "#0f766e",
  },
};

// Payment Statuses
export const PAYMENT_STATUSES = {
  PAID: { label: "Paid", color: "success" },
  PENDING: { label: "Pending", color: "warning" },
  FAILED: { label: "Failed", color: "danger" },
  REFUNDED: { label: "Refunded", color: "info" },
};

// Tour/Product Statuses
export const PRODUCT_STATUSES = {
  ACTIVE: { label: "Active", color: "success" },
  INACTIVE: { label: "Inactive", color: "muted" },
  DRAFT: { label: "Draft", color: "warning" },
  PENDING_APPROVAL: { label: "Pending Approval", color: "info" },
};

// User Roles
export const USER_ROLES = {
  ADMIN: { label: "Admin", color: "primary" },
  SUPPLIER: { label: "Supplier", color: "secondary" },
  CUSTOMER: { label: "Customer", color: "info" },
};

// Sort Options for Bookings
export const BOOKING_SORT_OPTIONS = [
  { value: "NEW_BOOKINGS", label: "Newest First" },
  { value: "OLDEST_FIRST", label: "Oldest First" },
  { value: "TRAVEL_DATE_ASC", label: "Travel Date (Nearest)" },
  { value: "TRAVEL_DATE_DESC", label: "Travel Date (Farthest)" },
  { value: "HIGHEST_VALUE", label: "Highest Value" },
  { value: "LOWEST_VALUE", label: "Lowest Value" },
];

// Page Sizes
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

// Default Page Size
export const DEFAULT_PAGE_SIZE = 25;
