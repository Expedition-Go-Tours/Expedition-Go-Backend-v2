import { useState } from "react";
import {
  Bell,
  Check,
  Trash2,
  Package,
  CalendarCheck,
  Star,
  AlertTriangle,
  Info,
  MessageSquare,
  DollarSign,
  X,
  Settings,
} from "lucide-react";
import { formatDateTime, formatDate } from "@/lib/utils";

const NOTIFICATION_TYPES = {
  booking: { icon: CalendarCheck, color: "bg-[#ebfcf5] text-[#047857]", label: "Booking" },
  review: { icon: Star, color: "bg-[#fffbeb] text-[#b45309]", label: "Review" },
  product: { icon: Package, color: "bg-[#eff6ff] text-[#1d4ed8]", label: "Product" },
  payment: { icon: DollarSign, color: "bg-[#f0fdf4] text-[#044b3b]", label: "Payment" },
  alert: { icon: AlertTriangle, color: "bg-[#ffebeb] text-[#b91c1c]", label: "Alert" },
  system: { icon: Info, color: "bg-[#ecfeff] text-[#0e7490]", label: "System" },
};

const MOCK_NOTIFICATIONS = [
  {
    id: "NOT-001",
    type: "booking",
    title: "New Booking Received",
    message: "John Smith booked Serengeti Safari Adventure for June 15, 2026",
    date: "2026-05-18T14:30:00",
    read: false,
    action: "/bookings",
    actionLabel: "View Booking",
  },
  {
    id: "NOT-002",
    type: "review",
    title: "New Review Pending Approval",
    message: "Sarah Johnson left a 5-star review for Zanzibar Beach Escape",
    date: "2026-05-18T12:15:00",
    read: false,
    action: "/reviews",
    actionLabel: "Moderate Review",
  },
  {
    id: "NOT-003",
    type: "payment",
    title: "Payment Failed",
    message: "Payment for booking BK-2026-0007 failed. Customer notified.",
    date: "2026-05-18T10:45:00",
    read: true,
    action: "/finance",
    actionLabel: "View Transaction",
  },
  {
    id: "NOT-004",
    type: "product",
    title: "Product Pending Approval",
    message: "Masai Mara Wildlife Tour has been submitted for approval",
    date: "2026-05-17T16:20:00",
    read: true,
    action: "/products",
    actionLabel: "Review Product",
  },
  {
    id: "NOT-005",
    type: "alert",
    title: "Low Availability Warning",
    message: "Serengeti Safari Adventure has only 2 spots left for June 20",
    date: "2026-05-17T09:30:00",
    read: false,
    action: "/availability",
    actionLabel: "Check Availability",
  },
  {
    id: "NOT-006",
    type: "system",
    title: "System Maintenance Scheduled",
    message: "Platform maintenance scheduled for May 20, 2026 at 02:00 UTC",
    date: "2026-05-16T18:00:00",
    read: true,
    action: null,
    actionLabel: null,
  },
  {
    id: "NOT-007",
    type: "booking",
    title: "Booking Cancelled",
    message: "Emily Davis cancelled Masai Mara Wildlife Tour. Refund processed.",
    date: "2026-05-16T11:00:00",
    read: true,
    action: "/bookings",
    actionLabel: "View Details",
  },
  {
    id: "NOT-008",
    type: "review",
    title: "Review Flagged",
    message: "A review for Victoria Falls Expedition has been flagged by supplier",
    date: "2026-05-15T15:45:00",
    read: false,
    action: "/reviews",
    actionLabel: "Review Flagged",
  },
  {
    id: "NOT-009",
    type: "payment",
    title: "Payout Processed",
    message: "Payout of $4,200 to Serengeti Tours Ltd. has been processed",
    date: "2026-05-15T08:00:00",
    read: true,
    action: "/finance",
    actionLabel: "View Payout",
  },
  {
    id: "NOT-010",
    type: "system",
    title: "New Feature Available",
    message: "Multi-language support is now available for tour descriptions",
    date: "2026-05-14T10:00:00",
    read: true,
    action: null,
    actionLabel: null,
  },
];

function groupByDate(notifications) {
  const groups = {};
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  notifications.forEach((notif) => {
    const date = new Date(notif.date);
    const dateKey = formatDate(date);
    const isToday = date.toDateString() === today.toDateString();
    const isYesterday = date.toDateString() === yesterday.toDateString();

    let label;
    if (isToday) label = "Today";
    else if (isYesterday) label = "Yesterday";
    else label = dateKey;

    if (!groups[label]) groups[label] = [];
    groups[label].push(notif);
  });

  return groups;
}

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState(MOCK_NOTIFICATIONS);
  const [filter, setFilter] = useState("all"); // all, unread

  const unreadCount = notifications.filter((n) => !n.read).length;
  const filteredNotifications = filter === "unread" ? notifications.filter((n) => !n.read) : notifications;
  const groupedNotifications = groupByDate(filteredNotifications);

  const markAsRead = (id) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  };

  const markAllAsRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const deleteNotification = (id) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  const deleteAll = () => {
    if (confirm("Are you sure you want to clear all notifications?")) {
      setNotifications([]);
    }
  };

  return (
    <div className="p-4 md:p-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-[#1e293b]">Notifications</h1>
          <p className="text-sm text-[#64748b] mt-1">
            You have {unreadCount} unread notification{unreadCount !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={markAllAsRead}
            className="flex items-center gap-2 px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm font-medium text-[#64748b] hover:bg-[#f8fafc] hover:text-[#1e293b] transition-colors"
          >
            <Check size={16} />
            Mark All Read
          </button>
          <button
            onClick={deleteAll}
            className="flex items-center gap-2 px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm font-medium text-[#64748b] hover:bg-[#ffebeb] hover:text-[#dc3545] transition-colors"
          >
            <Trash2 size={16} />
            Clear All
          </button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-1 mb-6 overflow-x-auto pb-1">
        {[
          { key: "all", label: "All Notifications" },
          { key: "unread", label: "Unread" },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              filter === tab.key
                ? "bg-[#044b3b] text-white"
                : "bg-white text-[#64748b] border border-[#eaeaea] hover:bg-[#f8fafc]"
            }`}
          >
            {tab.label}
            {tab.key === "unread" && unreadCount > 0 && (
              <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-xs ${filter === "unread" ? "bg-white/20" : "bg-[#f8fafc]"}`}>
                {unreadCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Notifications List */}
      <div className="space-y-6">
        {Object.entries(groupedNotifications).length === 0 ? (
          <div className="text-center py-12">
            <div className="w-16 h-16 rounded-full bg-[#f8fafc] flex items-center justify-center mx-auto mb-4">
              <Bell size={24} className="text-[#9e9e9e]" />
            </div>
            <p className="text-sm text-[#64748b]">No notifications to display.</p>
          </div>
        ) : (
          Object.entries(groupedNotifications).map(([dateLabel, items]) => (
            <div key={dateLabel}>
              <h3 className="text-xs font-semibold text-[#64748b] uppercase tracking-wider mb-3 sticky top-16 bg-white py-2">
                {dateLabel}
              </h3>
              <div className="space-y-2">
                {items.map((notification) => {
                  const typeConfig = NOTIFICATION_TYPES[notification.type];
                  const TypeIcon = typeConfig.icon;

                  return (
                    <div
                      key={notification.id}
                      className={`group flex flex-col sm:flex-row items-start gap-3 sm:gap-4 p-4 rounded-lg border transition-all ${
                        notification.read
                          ? "bg-white border-[#eaeaea]"
                          : "bg-[#f8fafc] border-[#044b3b]/20 shadow-sm"
                      }`}
                    >
                      {/* Icon */}
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${typeConfig.color}`}>
                        <TypeIcon size={18} />
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {!notification.read && (
                            <span className="w-2 h-2 rounded-full bg-[#044b3b] flex-shrink-0" />
                          )}
                          <h4 className={`text-sm font-semibold ${notification.read ? "text-[#1e293b]" : "text-[#044b3b]"}`}>
                            {notification.title}
                          </h4>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#f8fafc] text-[#64748b] border border-[#eaeaea]">
                            {typeConfig.label}
                          </span>
                        </div>
                        <p className="text-sm text-[#64748b] mb-2">{notification.message}</p>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-[#9e9e9e]">{formatDateTime(notification.date)}</span>
                          {notification.action && (
                            <a
                              href={notification.action}
                              className="text-xs text-[#044b3b] font-medium hover:underline"
                            >
                              {notification.actionLabel}
                            </a>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity self-end sm:self-auto">
                        {!notification.read && (
                          <button
                            onClick={() => markAsRead(notification.id)}
                            className="p-1.5 text-[#9e9e9e] hover:text-[#00d67f] hover:bg-[#ebfcf5] rounded-md transition-colors"
                            title="Mark as read"
                          >
                            <Check size={16} />
                          </button>
                        )}
                        <button
                          onClick={() => deleteNotification(notification.id)}
                          className="p-1.5 text-[#9e9e9e] hover:text-[#dc3545] hover:bg-[#ffebeb] rounded-md transition-colors"
                          title="Delete"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
