import { useState } from "react";
import { Search, Filter, Plus, Eye, Edit, Ban, Trash2, User, Mail, Shield, Check, X } from "lucide-react";
import StatusBadge from "@/components/shared/StatusBadge";
import DataTable from "@/components/shared/DataTable";
import { formatDate } from "@/lib/utils";

const MOCK_USERS = [
  { id: "USR-001", name: "John Smith", email: "john@example.com", phone: "+1 234-567-8901", role: "CUSTOMER", status: "ACTIVE", totalBookings: 5, joinedDate: "2025-08-15", lastLogin: "2026-05-18" },
  { id: "USR-002", name: "Sarah Johnson", email: "sarah@example.com", phone: "+1 234-567-8902", role: "CUSTOMER", status: "ACTIVE", totalBookings: 3, joinedDate: "2025-09-20", lastLogin: "2026-05-17" },
  { id: "USR-003", name: "Michael Brown", email: "michael@example.com", phone: "+1 234-567-8903", role: "CUSTOMER", status: "ACTIVE", totalBookings: 1, joinedDate: "2026-01-10", lastLogin: "2026-05-16" },
  { id: "USR-004", name: "Serengeti Tours Ltd.", email: "contact@serengetitours.com", phone: "+255 123-456-789", role: "SUPPLIER", status: "ACTIVE", totalBookings: 342, joinedDate: "2024-03-01", lastLogin: "2026-05-18" },
  { id: "USR-005", name: "Zanzibar Adventures", email: "info@zanzibar-adventures.com", phone: "+255 234-567-890", role: "SUPPLIER", status: "SUSPENDED", totalBookings: 89, joinedDate: "2024-06-15", lastLogin: "2026-04-20" },
  { id: "USR-006", name: "Kili Expeditions", email: "admin@kiliexpeditions.com", phone: "+255 345-678-901", role: "SUPPLIER", status: "ACTIVE", totalBookings: 156, joinedDate: "2024-08-10", lastLogin: "2026-05-15" },
  { id: "USR-007", name: "Admin User", email: "admin@travioafrica.com", phone: "+1 555-0100", role: "ADMIN", status: "ACTIVE", totalBookings: 0, joinedDate: "2024-01-01", lastLogin: "2026-05-18" },
  { id: "USR-008", name: "Jane Manager", email: "jane@travioafrica.com", phone: "+1 555-0101", role: "ADMIN", status: "ACTIVE", totalBookings: 0, joinedDate: "2024-02-15", lastLogin: "2026-05-17" },
  { id: "USR-009", name: "Emily Davis", email: "emily@example.com", phone: "+1 234-567-8904", role: "CUSTOMER", status: "SUSPENDED", totalBookings: 2, joinedDate: "2025-11-05", lastLogin: "2026-03-10" },
  { id: "USR-010", name: "Robert Wilson", email: "robert@example.com", phone: "+1 234-567-8905", role: "CUSTOMER", status: "ACTIVE", totalBookings: 8, joinedDate: "2025-07-22", lastLogin: "2026-05-18" },
];

const ROLE_COLORS = {
  ADMIN: { bg: "bg-[#f0fdf4]", text: "text-[#044b3b]", border: "border-[#044b3b]" },
  SUPPLIER: { bg: "bg-[#eff6ff]", text: "text-[#1d4ed8]", border: "border-[#1d4ed8]" },
  CUSTOMER: { bg: "bg-[#f8fafc]", text: "text-[#64748b]", border: "border-[#64748b]" },
};

function RoleBadge({ role }) {
  const style = ROLE_COLORS[role] || ROLE_COLORS.CUSTOMER;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium border ${style.bg} ${style.text} ${style.border}`}>
      {role === "ADMIN" && <Shield size={10} />}
      {role}
    </span>
  );
}

export default function UsersPage() {
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showInviteModal, setShowInviteModal] = useState(false);

  const filteredUsers = MOCK_USERS.filter((user) => {
    const matchesSearch = !search ||
      user.name.toLowerCase().includes(search.toLowerCase()) ||
      user.email.toLowerCase().includes(search.toLowerCase());
    const matchesRole = !roleFilter || user.role === roleFilter;
    const matchesStatus = !statusFilter || user.status === statusFilter;
    return matchesSearch && matchesRole && matchesStatus;
  });

  const columns = [
    {
      accessorKey: "name",
      header: "User",
      cell: ({ row }) => (
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-[#044b3b] flex items-center justify-center text-white text-sm font-medium">
            {row.original.name.charAt(0)}
          </div>
          <div>
            <p className="text-sm font-medium text-[#1e293b]">{row.original.name}</p>
            <p className="text-xs text-[#64748b]">{row.original.email}</p>
          </div>
        </div>
      ),
    },
    { accessorKey: "phone", header: "Phone", cell: ({ row }) => <span className="text-sm text-[#64748b]">{row.original.phone}</span> },
    {
      accessorKey: "role",
      header: "Role",
      cell: ({ row }) => <RoleBadge role={row.original.role} />,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} label={row.original.status} size="sm" />,
    },
    { accessorKey: "totalBookings", header: "Bookings", cell: ({ row }) => <span className="text-sm text-[#1e293b]">{row.original.totalBookings}</span> },
    { accessorKey: "joinedDate", header: "Joined", cell: ({ row }) => <span className="text-sm text-[#64748b]">{formatDate(row.original.joinedDate)}</span> },
    { accessorKey: "lastLogin", header: "Last Login", cell: ({ row }) => <span className="text-sm text-[#64748b]">{formatDate(row.original.lastLogin)}</span> },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex items-center gap-1">
          <button className="p-1.5 text-[#64748b] hover:text-[#044b3b] hover:bg-[#f0fdf4] rounded-md transition-colors" title="View">
            <Eye size={14} />
          </button>
          <button className="p-1.5 text-[#64748b] hover:text-[#044b3b] hover:bg-[#f0fdf4] rounded-md transition-colors" title="Edit">
            <Edit size={14} />
          </button>
          {row.original.status === "ACTIVE" ? (
            <button className="p-1.5 text-[#64748b] hover:text-[#ffc400] hover:bg-[#fffbeb] rounded-md transition-colors" title="Suspend">
              <Ban size={14} />
            </button>
          ) : (
            <button className="p-1.5 text-[#64748b] hover:text-[#00d67f] hover:bg-[#ebfcf5] rounded-md transition-colors" title="Activate">
              <Check size={14} />
            </button>
          )}
          <button className="p-1.5 text-[#64748b] hover:text-[#dc3545] hover:bg-[#ffebeb] rounded-md transition-colors" title="Delete">
            <Trash2 size={14} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="p-4 md:p-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-[#1e293b]">User Management</h1>
          <p className="text-sm text-[#64748b] mt-1">Manage customers, suppliers, and admin users</p>
        </div>
        <button
          onClick={() => setShowInviteModal(true)}
          className="flex items-center justify-center gap-2 px-4 py-2.5 bg-[#044b3b] text-white rounded-lg text-sm font-medium hover:bg-[#033629] transition-colors"
        >
          <Plus size={16} />
          Invite Admin
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[
          { label: "Total Users", value: MOCK_USERS.length, color: "text-[#044b3b]" },
          { label: "Customers", value: MOCK_USERS.filter((u) => u.role === "CUSTOMER").length, color: "text-[#64748b]" },
          { label: "Suppliers", value: MOCK_USERS.filter((u) => u.role === "SUPPLIER").length, color: "text-[#1d4ed8]" },
          { label: "Admins", value: MOCK_USERS.filter((u) => u.role === "ADMIN").length, color: "text-[#044b3b]" },
        ].map((stat) => (
          <div key={stat.label} className="bg-white rounded-lg border border-[#eaeaea] p-4">
            <p className="text-xs text-[#64748b] uppercase tracking-wider">{stat.label}</p>
            <p className={`text-2xl font-bold mt-1 ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mb-4">
        <div className="relative flex-1 w-full sm:max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9e9e9e]" />
          <input
            type="text"
            placeholder="Search users..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="px-3 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
        >
          <option value="">All Roles</option>
          <option value="CUSTOMER">Customer</option>
          <option value="SUPPLIER">Supplier</option>
          <option value="ADMIN">Admin</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
        >
          <option value="">All Statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="SUSPENDED">Suspended</option>
        </select>
      </div>

      {/* Table */}
      <DataTable
        data={filteredUsers}
        columns={columns}
        pageSize={10}
        currentPage={0}
        totalPages={1}
        totalItems={filteredUsers.length}
      />

      {/* Invite Admin Modal */}
      {showInviteModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-full sm:max-w-md w-full mx-4 p-4 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-[#1e293b]">Invite Admin</h3>
              <button
                onClick={() => setShowInviteModal(false)}
                className="p-1.5 text-[#9e9e9e] hover:text-[#1e293b] hover:bg-[#f8fafc] rounded-lg transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#1e293b] mb-2">Full Name</label>
                <input
                  type="text"
                  placeholder="Enter full name"
                  className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#1e293b] mb-2">Email</label>
                <input
                  type="email"
                  placeholder="Enter email address"
                  className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#1e293b] mb-2">Role</label>
                <select className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]">
                  <option value="admin">Administrator</option>
                  <option value="manager">Manager</option>
                  <option value="support">Support</option>
                </select>
              </div>
              <button
                onClick={() => setShowInviteModal(false)}
                className="w-full px-4 py-2.5 bg-[#044b3b] text-white rounded-lg text-sm font-medium hover:bg-[#033629] transition-colors"
              >
                Send Invitation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
