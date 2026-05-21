import { useState } from "react";
import {
  DollarSign,
  ArrowUpRight,
  ArrowDownLeft,
  Download,
  Calendar,
  Search,
  ChevronDown,
  CreditCard,
  Wallet,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import StatusBadge from "@/components/shared/StatusBadge";
import DataTable from "@/components/shared/DataTable";
import { formatCurrency, formatDate } from "@/lib/utils";

const TABS = [
  { key: "transactions", label: "Transactions", icon: CreditCard },
  { key: "payouts", label: "Payouts", icon: Wallet },
  { key: "refunds", label: "Refunds", icon: RefreshCw },
  { key: "earnings", label: "Earnings", icon: DollarSign },
];

// Mock transaction data
const MOCK_TRANSACTIONS = [
  { id: "TXN-001", date: "2026-05-18", type: "booking", description: "Booking BK-2026-0001 - Serengeti Safari", amount: 2400, status: "PAID", customer: "John Smith", tour: "Serengeti Safari Adventure" },
  { id: "TXN-002", date: "2026-05-17", type: "booking", description: "Booking BK-2026-0002 - Zanzibar Beach", amount: 1800, status: "PENDING", customer: "Sarah Johnson", tour: "Zanzibar Beach Escape" },
  { id: "TXN-003", date: "2026-05-16", type: "refund", description: "Refund for BK-2026-0004 - Masai Mara", amount: -1950, status: "REFUNDED", customer: "Emily Davis", tour: "Masai Mara Wildlife Tour" },
  { id: "TXN-004", date: "2026-05-15", type: "commission", description: "Platform commission - BK-2026-0001", amount: -360, status: "PAID", customer: "—", tour: "Serengeti Safari Adventure" },
  { id: "TXN-005", date: "2026-05-14", type: "booking", description: "Booking BK-2026-0005 - Victoria Falls", amount: 2800, status: "PAID", customer: "Robert Wilson", tour: "Victoria Falls Expedition" },
  { id: "TXN-006", date: "2026-05-13", type: "payout", description: "Supplier payout - Serengeti Tours Ltd.", amount: -2040, status: "PAID", customer: "—", tour: "Multiple" },
  { id: "TXN-007", date: "2026-05-12", type: "booking", description: "Booking BK-2026-0007 - Ngorongoro", amount: 1600, status: "FAILED", customer: "David Martinez", tour: "Ngorongoro Crater Tour" },
  { id: "TXN-008", date: "2026-05-11", type: "commission", description: "Platform commission - BK-2026-0005", amount: -420, status: "PAID", customer: "—", tour: "Victoria Falls Expedition" },
];

const MOCK_PAYOUTS = [
  { id: "PO-001", supplier: "Serengeti Tours Ltd.", amount: 4200, status: "PAID", date: "2026-05-15", method: "Bank Transfer", account: "****4521" },
  { id: "PO-002", supplier: "Zanzibar Adventures", amount: 1800, status: "PENDING", date: "2026-05-14", method: "Stripe", account: "****7890" },
  { id: "PO-003", supplier: "Kili Expeditions", amount: 3200, status: "PAID", date: "2026-05-10", method: "Bank Transfer", account: "****1234" },
  { id: "PO-004", supplier: "Mara Safaris", amount: 0, status: "PENDING", date: "2026-05-18", method: "Stripe", account: "****5678" },
];

const MOCK_REFUNDS = [
  { id: "REF-001", bookingId: "BK-2026-0004", customer: "Emily Davis", amount: 1950, status: "REFUNDED", date: "2026-05-16", reason: "Tour cancelled by customer", processedBy: "Admin" },
  { id: "REF-002", bookingId: "BK-2026-0007", customer: "David Martinez", amount: 1600, status: "REFUND_REQUEST", date: "2026-05-14", reason: "Payment failed, duplicate charge", processedBy: "—" },
  { id: "REF-003", bookingId: "BK-2026-0010", customer: "Maria Garcia", amount: 9600, status: "REFUND_REJECTED", date: "2026-05-12", reason: "Booking terms violation", processedBy: "Admin" },
];

export default function FinancePage() {
  const [activeTab, setActiveTab] = useState("transactions");
  const [search, setSearch] = useState("");

  // Calculate summary stats
  const totalRevenue = MOCK_TRANSACTIONS.filter((t) => t.type === "booking" && t.status === "PAID").reduce((sum, t) => sum + t.amount, 0);
  const totalRefunds = MOCK_TRANSACTIONS.filter((t) => t.type === "refund").reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const totalCommissions = Math.abs(MOCK_TRANSACTIONS.filter((t) => t.type === "commission").reduce((sum, t) => sum + t.amount, 0));
  const netRevenue = totalRevenue - totalRefunds - totalCommissions;

  const transactionColumns = [
    { accessorKey: "id", header: "Transaction ID", cell: ({ row }) => <span className="font-mono text-xs text-[#044b3b]">{row.original.id}</span> },
    { accessorKey: "date", header: "Date", cell: ({ row }) => <span className="text-[#1e293b]">{formatDate(row.original.date)}</span> },
    { accessorKey: "type", header: "Type", cell: ({ row }) => (
      <span className={`capitalize text-sm font-medium ${
        row.original.type === "booking" ? "text-[#00d67f]" :
        row.original.type === "refund" ? "text-[#dc3545]" :
        row.original.type === "commission" ? "text-[#ffc400]" :
        "text-[#044b3b]"
      }`}>{row.original.type}</span>
    )},
    { accessorKey: "description", header: "Description", cell: ({ row }) => <span className="text-[#1e293b] text-sm">{row.original.description}</span> },
    { accessorKey: "amount", header: "Amount", cell: ({ row }) => (
      <span className={`font-semibold ${row.original.amount >= 0 ? "text-[#00d67f]" : "text-[#dc3545]"}`}>
        {row.original.amount >= 0 ? "+" : ""}{formatCurrency(Math.abs(row.original.amount))}
      </span>
    )},
    { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={row.original.status} label={row.original.status} size="sm" /> },
    { accessorKey: "customer", header: "Customer", cell: ({ row }) => <span className="text-sm text-[#64748b]">{row.original.customer}</span> },
  ];

  const payoutColumns = [
    { accessorKey: "id", header: "Payout ID", cell: ({ row }) => <span className="font-mono text-xs text-[#044b3b]">{row.original.id}</span> },
    { accessorKey: "supplier", header: "Supplier", cell: ({ row }) => <span className="font-medium text-[#1e293b]">{row.original.supplier}</span> },
    { accessorKey: "amount", header: "Amount", cell: ({ row }) => <span className="font-semibold text-[#1e293b]">{formatCurrency(row.original.amount)}</span> },
    { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={row.original.status} label={row.original.status} size="sm" /> },
    { accessorKey: "date", header: "Date", cell: ({ row }) => <span className="text-[#1e293b]">{formatDate(row.original.date)}</span> },
    { accessorKey: "method", header: "Method", cell: ({ row }) => <span className="text-sm text-[#64748b]">{row.original.method}</span> },
    { accessorKey: "account", header: "Account", cell: ({ row }) => <span className="text-sm font-mono text-[#64748b]">{row.original.account}</span> },
  ];

  const refundColumns = [
    { accessorKey: "id", header: "Refund ID", cell: ({ row }) => <span className="font-mono text-xs text-[#044b3b]">{row.original.id}</span> },
    { accessorKey: "bookingId", header: "Booking", cell: ({ row }) => <span className="text-sm text-[#1e293b]">{row.original.bookingId}</span> },
    { accessorKey: "customer", header: "Customer", cell: ({ row }) => <span className="font-medium text-[#1e293b]">{row.original.customer}</span> },
    { accessorKey: "amount", header: "Amount", cell: ({ row }) => <span className="font-semibold text-[#dc3545]">{formatCurrency(row.original.amount)}</span> },
    { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={row.original.status} label={row.original.status} size="sm" /> },
    { accessorKey: "date", header: "Date", cell: ({ row }) => <span className="text-[#1e293b]">{formatDate(row.original.date)}</span> },
    { accessorKey: "reason", header: "Reason", cell: ({ row }) => <span className="text-sm text-[#64748b]">{row.original.reason}</span> },
  ];

  return (
    <div className="p-4 md:p-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-[#1e293b]">Finance</h1>
          <p className="text-sm text-[#64748b] mt-1">Manage payments, payouts, and earnings</p>
        </div>
        <button className="flex items-center justify-center gap-2 px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm font-medium text-[#64748b] hover:bg-[#f8fafc] hover:text-[#1e293b] transition-colors">
          <Download size={16} />
          Export Report
        </button>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: "Total Revenue", value: formatCurrency(totalRevenue), icon: ArrowUpRight, color: "text-[#00d67f]", bg: "bg-[#ebfcf5]" },
          { label: "Total Refunds", value: formatCurrency(totalRefunds), icon: ArrowDownLeft, color: "text-[#dc3545]", bg: "bg-[#ffebeb]" },
          { label: "Commissions", value: formatCurrency(totalCommissions), icon: AlertCircle, color: "text-[#ffc400]", bg: "bg-[#fffbeb]" },
          { label: "Net Revenue", value: formatCurrency(netRevenue), icon: DollarSign, color: "text-[#044b3b]", bg: "bg-[#f0fdf4]" },
        ].map((stat) => (
          <div key={stat.label} className="bg-white rounded-lg border border-[#eaeaea] p-5">
            <div className="flex items-center justify-between mb-3">
              <div className={`w-10 h-10 rounded-lg ${stat.bg} flex items-center justify-center`}>
                <stat.icon size={20} className={stat.color} />
              </div>
            </div>
            <p className="text-2xl font-bold text-[#1e293b]">{stat.value}</p>
            <p className="text-sm text-[#64748b] mt-1">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-6 overflow-x-auto pb-1">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                activeTab === tab.key
                  ? "bg-[#044b3b] text-white"
                  : "bg-white text-[#64748b] border border-[#eaeaea] hover:bg-[#f8fafc]"
              }`}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Search & Filter */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9e9e9e]" />
          <input
            type="text"
            placeholder={`Search ${activeTab}...`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          />
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === "transactions" && (
        <DataTable
          data={MOCK_TRANSACTIONS}
          columns={transactionColumns}
          pageSize={10}
          currentPage={0}
          totalPages={1}
          totalItems={MOCK_TRANSACTIONS.length}
        />
      )}

      {activeTab === "payouts" && (
        <DataTable
          data={MOCK_PAYOUTS}
          columns={payoutColumns}
          pageSize={10}
          currentPage={0}
          totalPages={1}
          totalItems={MOCK_PAYOUTS.length}
        />
      )}

      {activeTab === "refunds" && (
        <DataTable
          data={MOCK_REFUNDS}
          columns={refundColumns}
          pageSize={10}
          currentPage={0}
          totalPages={1}
          totalItems={MOCK_REFUNDS.length}
        />
      )}

      {activeTab === "earnings" && (
        <div className="bg-white rounded-lg border border-[#eaeaea] p-4 md:p-6">
          <h3 className="text-lg font-semibold text-[#1e293b] mb-4">Earnings Breakdown</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h4 className="text-sm font-medium text-[#64748b] mb-3">By Tour</h4>
              <div className="space-y-3">
                {[
                  { tour: "Serengeti Safari Adventure", earnings: 4200, bookings: 7 },
                  { tour: "Victoria Falls Expedition", earnings: 3640, bookings: 4 },
                  { tour: "Zanzibar Beach Escape", earnings: 1800, bookings: 2 },
                  { tour: "Kilimanjaro Trek", earnings: 3200, bookings: 1 },
                ].map((item) => (
                  <div key={item.tour} className="flex items-center justify-between p-3 bg-[#f8fafc] rounded-lg">
                    <div>
                      <p className="text-sm font-medium text-[#1e293b]">{item.tour}</p>
                      <p className="text-xs text-[#64748b]">{item.bookings} bookings</p>
                    </div>
                    <span className="text-sm font-bold text-[#044b3b]">{formatCurrency(item.earnings)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h4 className="text-sm font-medium text-[#64748b] mb-3">By Supplier</h4>
              <div className="space-y-3">
                {[
                  { supplier: "Serengeti Tours Ltd.", earnings: 4200, tours: 1 },
                  { supplier: "Victoria Tours", earnings: 3640, tours: 1 },
                  { supplier: "Zanzibar Adventures", earnings: 1800, tours: 1 },
                  { supplier: "Kili Expeditions", earnings: 3200, tours: 1 },
                ].map((item) => (
                  <div key={item.supplier} className="flex items-center justify-between p-3 bg-[#f8fafc] rounded-lg">
                    <div>
                      <p className="text-sm font-medium text-[#1e293b]">{item.supplier}</p>
                      <p className="text-xs text-[#64748b]">{item.tours} tour(s)</p>
                    </div>
                    <span className="text-sm font-bold text-[#044b3b]">{formatCurrency(item.earnings)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
