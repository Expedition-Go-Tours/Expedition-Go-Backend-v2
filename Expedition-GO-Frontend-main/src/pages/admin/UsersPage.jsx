import { useMemo, useState } from "react";
import { Download, MoreHorizontal, Pencil, Search, Trash2, UserPlus } from "lucide-react";

import { AdminButton } from "@/components/ui/admin-button";
import {
  AdminCard,
  AdminCardContent,
  AdminCardDescription,
  AdminCardHeader,
  AdminCardTitle,
} from "@/components/ui/admin-card";
import { AdminInput } from "@/components/ui/admin-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  StatusPill,
  pillToneForRole,
  pillToneForUserStatus,
} from "@/components/ui/status-pill";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import {
  useAdminUsers,
  useDeleteUser,
  useUpdateUserRole,
  useUpdateUserStatus,
} from "@/features/users/hooks";
import { UserDialog } from "@/features/users/components/UserDialog";
import { ALL_ADMIN_ROLES } from "@/lib/rbac";
import { extractList } from "@/utils/extractList";
import { formatRelative } from "@/utils/format";
import { downloadCsv, toCsv } from "@/utils/csv";

const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "pending", label: "Pending" },
  { value: "disabled", label: "Disabled" },
];

const ROLE_OPTIONS = [...ALL_ADMIN_ROLES, "user"];
const STATUS_TOGGLE = ["active", "pending", "disabled"];

function getInitials(value) {
  if (!value) return "U";
  const parts = String(value).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function UsersPage() {
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [editing, setEditing] = useState(null);
  const debouncedSearch = useDebouncedValue(search, 300);

  const params = useMemo(() => {
    const next = {};
    if (debouncedSearch) next.search = debouncedSearch;
    if (roleFilter !== "all") next.role = roleFilter;
    if (statusFilter !== "all") next.status = statusFilter;
    return next;
  }, [debouncedSearch, roleFilter, statusFilter]);

  const usersQuery = useAdminUsers(params);
  const updateRole = useUpdateUserRole();
  const updateStatus = useUpdateUserStatus();
  const deleteUser = useDeleteUser();

  const list = useMemo(() => extractList(usersQuery.data, ["users"]), [usersQuery.data]);

  function handleExport() {
    if (!list.length) return;
    const csv = toCsv(list, [
      { key: "name", label: "Name", accessor: (u) => u.name },
      { key: "email", label: "Email", accessor: (u) => u.email },
      { key: "role", label: "Role", accessor: (u) => u.role },
      { key: "status", label: "Status", accessor: (u) => u.status },
      { key: "createdAt", label: "Created", accessor: (u) => u.createdAt || u.created_at || "" },
    ]);
    downloadCsv(`users-${Date.now()}.csv`, csv);
  }

  return (
    <div className="grid gap-5">
      <AdminCard>
        <AdminCardHeader>
          <div>
            <AdminCardTitle>User management</AdminCardTitle>
            <AdminCardDescription>Search, filter and manage workspace access.</AdminCardDescription>
          </div>
          <div className="flex items-center gap-2">
            <AdminButton variant="outline" onClick={handleExport} disabled={!list.length}>
              <Download className="size-4" /> Export CSV
            </AdminButton>
            <AdminButton onClick={() => setEditing({})}>
              <UserPlus className="size-4" /> New user
            </AdminButton>
          </div>
        </AdminCardHeader>
        <AdminCardContent>
          <div className="grid gap-3 md:grid-cols-[1fr_180px_180px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[color:var(--admin-muted)]" />
              <AdminInput
                placeholder="Search by name or email..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All roles</SelectItem>
                {ROLE_OPTIONS.map((role) => (
                  <SelectItem key={role} value={role}>
                    {role}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTER_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="mt-5 overflow-hidden rounded-2xl border border-[color:var(--admin-border)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersQuery.isLoading ? (
                  [0, 1, 2, 3, 4].map((i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={5}>
                        <Skeleton className="h-10 rounded-xl" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : list.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-sm text-[color:var(--admin-muted)]">
                      No users match the current filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  list.map((user) => {
                    const id = user?._id || user?.id;
                    return (
                      <TableRow key={id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Avatar className="size-9">
                              <AvatarImage src={user?.photoURL || user?.avatar} alt={user?.name || ""} />
                              <AvatarFallback>{getInitials(user?.name || user?.email)}</AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-[color:var(--admin-text)]">
                                {user?.name || "Unnamed"}
                              </p>
                              <p className="truncate text-xs text-[color:var(--admin-muted)]">
                                {user?.email || "—"}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusPill tone={pillToneForRole(user?.role)}>{user?.role || "user"}</StatusPill>
                        </TableCell>
                        <TableCell>
                          <StatusPill tone={pillToneForUserStatus(user?.status)}>
                            {user?.status || "active"}
                          </StatusPill>
                        </TableCell>
                        <TableCell className="text-sm text-[color:var(--admin-muted)]">
                          {formatRelative(user?.createdAt || user?.created_at)}
                        </TableCell>
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                className="grid size-8 place-items-center rounded-full border border-[color:var(--admin-border)] text-[color:var(--admin-muted)] hover:bg-[color:var(--admin-border-soft)]"
                                aria-label="Open user actions"
                              >
                                <MoreHorizontal className="size-4" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56">
                              <DropdownMenuLabel>Manage user</DropdownMenuLabel>
                              <DropdownMenuItem onSelect={() => setEditing(user)}>
                                <Pencil className="size-4" /> Edit details
                              </DropdownMenuItem>
                              <DropdownMenuSub>
                                <DropdownMenuSubTrigger>Change role</DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                  {ROLE_OPTIONS.map((role) => (
                                    <DropdownMenuItem
                                      key={role}
                                      onSelect={() => updateRole.mutate({ id, role })}
                                    >
                                      {role}
                                    </DropdownMenuItem>
                                  ))}
                                </DropdownMenuSubContent>
                              </DropdownMenuSub>
                              <DropdownMenuSub>
                                <DropdownMenuSubTrigger>Change status</DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                  {STATUS_TOGGLE.map((status) => (
                                    <DropdownMenuItem
                                      key={status}
                                      onSelect={() => updateStatus.mutate({ id, status })}
                                    >
                                      {status}
                                    </DropdownMenuItem>
                                  ))}
                                </DropdownMenuSubContent>
                              </DropdownMenuSub>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-[color:var(--admin-danger)]"
                                onSelect={() => {
                                  if (typeof window !== "undefined" && window.confirm("Delete this user?")) {
                                    deleteUser.mutate({ id });
                                  }
                                }}
                              >
                                <Trash2 className="size-4" /> Delete user
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </AdminCardContent>
      </AdminCard>

      <UserDialog
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        user={editing && Object.keys(editing).length ? editing : null}
        onSubmit={(values) => {
          const id = editing?._id || editing?.id;
          if (id) {
            if (values.role && values.role !== editing.role) {
              updateRole.mutate({ id, role: values.role });
            }
            if (values.status && values.status !== editing.status) {
              updateStatus.mutate({ id, status: values.status });
            }
          }
          setEditing(null);
        }}
      />
    </div>
  );
}
