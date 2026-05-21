import { useState, useMemo, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { Search, Filter, Download, Plus, X, ChevronDown, Calendar } from "lucide-react";
import { format } from "date-fns";
import DataTable from "@/components/shared/DataTable";
import StatusBadge from "@/components/shared/StatusBadge";
import { BOOKING_STATUSES, BOOKING_SORT_OPTIONS, DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils";

// Mock data for demonstration
const MOCK_BOOKINGS = [
  { id: "BK-2026-0001", bookingNumber: "TGA-78234", customerName: "John Smith", customerEmail: "john@example.com", tourName: "Serengeti Safari Adventure", travelDate: "2026-06-15", bookingDate: "2026-05-18", travelers: 4, total: 2400, status: "CONFIRMED", paymentStatus: "PAID", currency: "USD" },
  { id: "BK-2026-0002", bookingNumber: "TGA-78235", customerName: "Sarah Johnson", customerEmail: "sarah@example.com", tourName: "Zanzibar Beach Escape", travelDate: "2026-06-20", bookingDate: "2026-05-17", travelers: 2, total: 1800, status: "AWAITING_CONFIRMATION", paymentStatus: "PENDING", currency: "USD" },
  { id: "BK-2026-0003", bookingNumber: "TGA-78236", customerName: "Michael Brown", customerEmail: "michael@example.com", tourName: "Kilimanjaro Trek", travelDate: "2026-07-01", bookingDate: "2026-05-15", travelers: 1, total: 3200, status: "CONFIRMED", paymentStatus: "PAID", currency: "USD" },
  { id: "BK-2026-0004", bookingNumber: "TGA-78237", customerName: "Emily Davis", customerEmail: "emily@example.com", tourName: "Masai Mara Wildlife Tour", travelDate: "2026-06-10", bookingDate: "2026-05-16", travelers: 3, total: 1950, status: "CANCELLED", paymentStatus: "REFUNDED", currency: "USD" },
  { id: "BK-2026-0005", bookingNumber: "TGA-78238", customerName: "Robert Wilson", customerEmail: "robert@example.com", tourName: "Victoria Falls Expedition", travelDate: "2026-08-05", bookingDate: "2026-05-14", travelers: 2, total: 2800, status: "CONFIRMED", paymentStatus: "PAID", currency: "USD" },
  { id: "BK-2026-0006", bookingNumber: "TGA-78239", customerName: "Lisa Anderson", customerEmail: "lisa@example.com", tourName: "Serengeti Safari Adventure", travelDate: "2026-06-22", bookingDate: "2026-05-18", travelers: 5, total: 3000, status: "AMENDMENT_REQUEST", paymentStatus: "PAID", currency: "USD" },
  { id: "BK-2026-0007", bookingNumber: "TGA-78240", customerName: "David Martinez", customerEmail: "david@example.com", tourName: "Ngorongoro Crater Tour", travelDate: "2026-07-10", bookingDate: "2026-05-12", travelers: 2, total: 1600, status: "REFUND_REQUEST", paymentStatus: "PAID", currency: "USD" },
  { id: "BK-2026-0008", bookingNumber: "TGA-78241", customerName: "Jennifer Taylor", customerEmail: "jennifer@example.com", tourName: "Zanzibar Beach Escape", travelDate: "2026-09-01", bookingDate: "2026-05-10", travelers: 4, total: 3600, status: "CONFIRMED", paymentStatus: "PENDING", currency: "USD" },
  { id: "BK-2026-0009", bookingNumber: "TGA-78242", customerName: "James Thomas", customerEmail: "james@example.com", tourName: "Okavango Delta Safari", travelDate: "2026-06-18", bookingDate: "2026-05-18", travelers: 2, total: 4200, status: "CONFIRMED", paymentStatus: "PAID", currency: "USD" },
  { id: "BK-2026-0010", bookingNumber: "TGA-78243", customerName: "Maria Garcia", customerEmail: "maria@example.com", tourName: "Kilimanjaro Trek", travelDate: "2026-07-15", bookingDate: "2026-05-08", travelers: 3, total: 9600, status: "REJECTED", paymentStatus: "FAILED", currency: "USD" },
  { id: "BK-2026-0011", bookingNumber: "TGA-78244", customerName: "William Lee", customerEmail: "william@example.com", tourName: "Serengeti Safari Adventure", travelDate: "2026-06-25", bookingDate: "2026-05-17", travelers: 2, total: 1200, status: "AMENDED", paymentStatus: "PAID", currency: "USD" },
  { id: "BK-2026-0012", bookingNumber: "TGA-78245", customerName: "Patricia White", customerEmail: "patricia@example.com", tourName: "Masai Mara Wildlife Tour", travelDate: "2026-08-20", bookingDate: "2026-05-16", travelers: 1, total: 650, status: "AWAITING_CONFIRMATION", paymentStatus: "PENDING", currency: "USD" },
  { id: "BK-2026-0013", bookingNumber: "TGA-78246", customerName: "Charles Harris", customerEmail: "charles@example.com", tourName: "Victoria Falls Expedition", travelDate: "2026-09-10", bookingDate: "2026-05-15", travelers: 4, total: 5600, status: "CONFIRMED", paymentStatus: "PAID", currency: "USD" },
  { id: "BK-2026-0014", bookingNumber: "TGA-78247", customerName: "Linda Clark", customerEmail: "linda@example.com", tourName: "Zanzibar Beach Escape", travelDate: "2026-07-05", bookingDate: "2026-05-14", travelers: 2, total: 1800, status: "REFUND_REJECTED", paymentStatus: "PAID", currency: "USD" },
  { id: "BK-2026-0015", bookingNumber: "TGA-78248", customerName: "Thomas Robinson", customerEmail: "thomas@example.com", tourName: "Ngorongoro Crater Tour", travelDate: "2026-08-15", bookingDate: "2026-05-13", travelers: 6, total: 4800, status: "CONFIRMED", paymentStatus: "PAID", currency: "USD" },
];

// Quick filter tabs configuration
const QUICK_FILTERS = [
  { key: "ALL", label: "All Bookings", count: null },
  { key: "AWAITING_CONFIRMATION", label: "Awaiting Confirmation", count: null },
  { key: "CONFIRMED", label: "Confirmed", count: null },
  { key: "CANCELLED", label: "Cancelled", count: null },
  { key: "REFUND_REQUEST", label: "Refund Requests", count: null },
  { key: "AMENDMENT_REQUEST", label: "Amendment Requests", count: null },
];

export default function BookingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // URL state
  const page = parseInt(searchParams.get("page") || "0", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || String(DEFAULT_PAGE_SIZE), 10);
  const sortBy = searchParams.get("sortBy") || "NEW_BOOKINGS";
  const searchQuery = searchParams.get("search") || "";
  const statusFilters = searchParams.getAll("status");
  const travelDateFrom = searchParams.get("travelDateFrom") || "";
  const travelDateTo = searchParams.get("travelDateTo") || "";
  const activeTab = searchParams.get("tab") || "ALL";

  // Local state for filters
  const [localSearch, setLocalSearch] = useState(searchQuery);
  const [showFilters, setShowFilters] = useState(false);
  const [selectedStatuses, setSelectedStatuses] = useState(
    statusFilters.length > 0 ? statusFilters : []
  );
  const [dateFrom, setDateFrom] = useState(travelDateFrom);
  const [dateTo, setDateTo] = useState(travelDateTo);

  // Update URL when filters change
  const updateFilters = useCallback(
    (updates) => {
      const params = new URLSearchParams(searchParams);
      Object.entries(updates).forEach(([key, value]) => {
        if (value === "" || value === null || value === undefined) {
          params.delete(key);
        } else if (Array.isArray(value)) {
          params.delete(key);
          value.forEach((v) => params.append(key, v));
        } else {
          params.set(key, String(value));
        }
      });
      setSearchParams(params);
    },
    [searchParams, setSearchParams]
  );

  // Handle search submit
  const handleSearch = () => {
    updateFilters({ search: localSearch || null, page: 0 });
  };

  // Handle status toggle
  const toggleStatus = (status) => {
    const newStatuses = selectedStatuses.includes(status)
      ? selectedStatuses.filter((s) => s !== status)
      : [...selectedStatuses, status];
    setSelectedStatuses(newStatuses);
    updateFilters({ status: newStatuses.length > 0 ? newStatuses : null, page: 0 });
  };

  // Handle date filter apply
  const applyDateFilter = () => {
    updateFilters({
      travelDateFrom: dateFrom || null,
      travelDateTo: dateTo || null,
      page: 0,
    });
  };

  // Handle tab click
  const handleTabClick = (tabKey) => {
    if (tabKey === "ALL") {
      setSelectedStatuses([]);
      updateFilters({ tab: "ALL", status: null, page: 0 });
    } else {
      setSelectedStatuses([tabKey]);
      updateFilters({ tab: tabKey, status: [tabKey], page: 0 });
    }
  };

  // Clear all filters
  const clearFilters = () => {
    setLocalSearch("");
    setSelectedStatuses([]);
    setDateFrom("");
    setDateTo("");
    setSearchParams({});
  };

  // Filter and sort data
  const filteredData = useMemo(() => {
    let data = [...MOCK_BOOKINGS];

    // Apply status filter
    if (selectedStatuses.length > 0) {
      data = data.filter((b) => selectedStatuses.includes(b.status));
    }

    // Apply search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      data = data.filter(
        (b) =>
          b.bookingNumber.toLowerCase().includes(q) ||
          b.customerName.toLowerCase().includes(q) ||
          b.customerEmail.toLowerCase().includes(q) ||
          b.tourName.toLowerCase().includes(q)
      );
    }

    // Apply date range
    if (travelDateFrom) {
      const from = new Date(travelDateFrom);
      data = data.filter((b) => new Date(b.travelDate) >= from);
    }
    if (travelDateTo) {
      const to = new Date(travelDateTo);
      data = data.filter((b) => new Date(b.travelDate) <= to);
    }

    // Apply sorting
    data.sort((a, b) => {
      switch (sortBy) {
        case "OLDEST_FIRST":
          return new Date(a.bookingDate) - new Date(b.bookingDate);
        case "TRAVEL_DATE_ASC":
          return new Date(a.travelDate) - new Date(b.travelDate);
        case "TRAVEL_DATE_DESC":
          return new Date(b.travelDate) - new Date(a.travelDate);
        case "HIGHEST_VALUE":
          return b.total - a.total;
        case "LOWEST_VALUE":
          return a.total - b.total;
        case "NEW_BOOKINGS":
        default:
          return new Date(b.bookingDate) - new Date(a.bookingDate);
      }
    });

    return data;
  }, [selectedStatuses, searchQuery, travelDateFrom, travelDateTo, sortBy]);

  // Paginate data
  const totalItems = filteredData.length;
  const totalPages = Math.ceil(totalItems / pageSize);
  const paginatedData = filteredData.slice(page * pageSize, (page + 1) * pageSize);

  // Calculate tab counts
  const tabCounts = useMemo(() => {
    const counts = { ALL: MOCK_BOOKINGS.length };
    Object.keys(BOOKING_STATUSES).forEach((status) => {
      counts[status] = MOCK_BOOKINGS.filter((b) => b.status === status).length;
    });
    return counts;
  }, []);

  // Table columns
  const columns = useMemo(
    () => [
      {
        accessorKey: "bookingNumber",
        header: "Booking ID",
        cell: ({ row }) => (
          <span className="font-medium text-[#044b3b]">{row.original.bookingNumber}</span>
        ),
      },
      {
        accessorKey: "customerName",
        header: "Customer",
        cell: ({ row }) => (
          <div>
            <p className="font-medium text-[#1e293b]">{row.original.customerName}</p>
            <p className="text-xs text-[#64748b]">{row.original.customerEmail}</p>
          </div>
        ),
      },
      {
        accessorKey: "tourName",
        header: "Tour",
      },
      {
        accessorKey: "travelDate",
        header: "Travel Date",
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5 text-[#1e293b]">
            <Calendar size={14} className="text-[#64748b]" />
            {formatDate(row.original.travelDate)}
          </div>
        ),
      },
      {
        accessorKey: "travelers",
        header: "Travelers",
        cell: ({ row }) => (
          <span className="text-[#1e293b]">{row.original.travelers}</span>
        ),
      },
      {
        accessorKey: "total",
        header: "Total",
        cell: ({ row }) => (
          <span className="font-semibold text-[#1e293b]">
            {formatCurrency(row.original.total, row.original.currency)}
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <StatusBadge
            status={row.original.status}
            label={BOOKING_STATUSES[row.original.status]?.label}
          />
        ),
      },
      {
        accessorKey: "paymentStatus",
        header: "Payment",
        cell: ({ row }) => (
          <StatusBadge
            status={row.original.paymentStatus}
            label={row.original.paymentStatus}
          />
        ),
      },
      {
        id: "actions",
        header: "",
        cell: () => (
          <button className="text-[#64748b] hover:text-[#044b3b] transition-colors">
            View
          </button>
        ),
      },
    ],
    []
  );

  return (
    <div className="p-4 md:p-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-[#1e293b]">Bookings</h1>
          <p className="text-sm text-[#64748b] mt-1">
            Manage and track all customer bookings
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm font-medium text-[#64748b] hover:bg-[#f8fafc] hover:text-[#1e293b] transition-colors">
            <Download size={16} />
            <span className="hidden sm:inline">Export</span>
          </button>
          <button className="flex items-center gap-2 px-4 py-2.5 bg-[#044b3b] text-white rounded-lg text-sm font-medium hover:bg-[#033629] transition-colors">
            <Plus size={16} />
            <span className="hidden sm:inline">Create Booking</span>
          </button>
        </div>
      </div>

      {/* Quick Filter Tabs */}
      <div className="flex items-center gap-1 mb-4 overflow-x-auto pb-1">
        {QUICK_FILTERS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => handleTabClick(tab.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              activeTab === tab.key
                ? "bg-[#044b3b] text-white"
                : "bg-white text-[#64748b] hover:bg-[#f8fafc] hover:text-[#1e293b] border border-[#eaeaea]"
            }`}
          >
            {tab.label}
            {tabCounts[tab.key] !== null && (
              <span
                className={`ml-1.5 px-1.5 py-0.5 rounded-full text-xs ${
                  activeTab === tab.key
                    ? "bg-white/20 text-white"
                    : "bg-[#f8fafc] text-[#64748b]"
                }`}
              >
                {tabCounts[tab.key] || 0}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Filters Bar */}
      <div className="bg-white rounded-lg border border-[#eaeaea] p-4 mb-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 flex-wrap">
          {/* Search */}
          <div className="relative flex-1 min-w-[240px]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9e9e9e]" />
            <input
              type="text"
              placeholder="Search by booking ID, customer, tour..."
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="w-full pl-9 pr-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
            />
          </div>

          {/* Status Multi-Select Dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`flex items-center gap-2 px-4 py-2.5 border rounded-lg text-sm font-medium transition-colors ${
                selectedStatuses.length > 0
                  ? "border-[#044b3b] text-[#044b3b] bg-[#f0fdf4]"
                  : "border-[#eaeaea] text-[#64748b] hover:bg-[#f8fafc]"
              }`}
            >
              <Filter size={16} />
              Status
              {selectedStatuses.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 bg-[#044b3b] text-white rounded-full text-xs">
                  {selectedStatuses.length}
                </span>
              )}
              <ChevronDown size={14} />
            </button>

            {/* Status Dropdown */}
            {showFilters && (
              <div className="absolute top-full left-0 mt-1 w-64 bg-white border border-[#eaeaea] rounded-lg shadow-lg z-50 p-2">
                <div className="flex items-center justify-between px-2 py-1 border-b border-[#eaeaea] mb-1">
                  <span className="text-xs font-semibold text-[#64748b]">Filter by Status</span>
                  <button
                    onClick={() => setShowFilters(false)}
                    className="text-[#9e9e9e] hover:text-[#1e293b]"
                  >
                    <X size={14} />
                  </button>
                </div>
                {Object.entries(BOOKING_STATUSES).map(([key, value]) => (
                  <label
                    key={key}
                    className="flex items-center gap-3 px-2 py-2 hover:bg-[#f8fafc] rounded-md cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedStatuses.includes(key)}
                      onChange={() => toggleStatus(key)}
                      className="w-4 h-4 rounded border-[#eaeaea] text-[#044b3b] focus:ring-[#044b3b]"
                    />
                    <StatusBadge status={key} label={value.label} size="sm" />
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Date Range */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Calendar size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9e9e9e]" />
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="pl-9 pr-3 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
              />
            </div>
            <span className="text-[#9e9e9e]">to</span>
            <div className="relative">
              <Calendar size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9e9e9e]" />
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="pl-9 pr-3 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
              />
            </div>
            <button
              onClick={applyDateFilter}
              className="px-3 py-2.5 bg-[#044b3b] text-white rounded-lg text-sm font-medium hover:bg-[#033629] transition-colors"
            >
              Apply
            </button>
          </div>

          {/* Sort */}
          <select
            value={sortBy}
            onChange={(e) => updateFilters({ sortBy: e.target.value })}
            className="px-3 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          >
            {BOOKING_SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          {/* Clear Filters */}
          {(searchQuery || selectedStatuses.length > 0 || travelDateFrom || travelDateTo) && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 px-3 py-2.5 text-sm text-[#dc3545] hover:bg-[#ffebeb] rounded-lg transition-colors"
            >
              <X size={14} />
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Active Filters Display */}
      {(selectedStatuses.length > 0 || travelDateFrom || travelDateTo || searchQuery) && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <span className="text-xs text-[#64748b]">Active filters:</span>
          {searchQuery && (
            <span className="inline-flex items-center gap-1 px-2 py-1 bg-[#f8fafc] border border-[#eaeaea] rounded-md text-xs text-[#1e293b]">
              Search: {searchQuery}
              <button onClick={() => { setLocalSearch(""); updateFilters({ search: null }); }}>
                <X size={12} className="text-[#9e9e9e] hover:text-[#dc3545]" />
              </button>
            </span>
          )}
          {selectedStatuses.map((status) => (
            <span
              key={status}
              className="inline-flex items-center gap-1 px-2 py-1 bg-[#f8fafc] border border-[#eaeaea] rounded-md text-xs text-[#1e293b]"
            >
              {BOOKING_STATUSES[status]?.label}
              <button onClick={() => toggleStatus(status)}>
                <X size={12} className="text-[#9e9e9e] hover:text-[#dc3545]" />
              </button>
            </span>
          ))}
          {travelDateFrom && (
            <span className="inline-flex items-center gap-1 px-2 py-1 bg-[#f8fafc] border border-[#eaeaea] rounded-md text-xs text-[#1e293b]">
              From: {formatDate(travelDateFrom)}
              <button onClick={() => { setDateFrom(""); updateFilters({ travelDateFrom: null }); }}>
                <X size={12} className="text-[#9e9e9e] hover:text-[#dc3545]" />
              </button>
            </span>
          )}
          {travelDateTo && (
            <span className="inline-flex items-center gap-1 px-2 py-1 bg-[#f8fafc] border border-[#eaeaea] rounded-md text-xs text-[#1e293b]">
              To: {formatDate(travelDateTo)}
              <button onClick={() => { setDateTo(""); updateFilters({ travelDateTo: null }); }}>
                <X size={12} className="text-[#9e9e9e] hover:text-[#dc3545]" />
              </button>
            </span>
          )}
        </div>
      )}

      {/* Data Table */}
      <DataTable
        data={paginatedData}
        columns={columns}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        currentPage={page}
        totalPages={totalPages}
        totalItems={totalItems}
        onPageChange={(newPage) => updateFilters({ page: newPage })}
        onPageSizeChange={(newSize) => updateFilters({ pageSize: newSize, page: 0 })}
      />
    </div>
  );
}
