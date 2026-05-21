import { useMemo, useState } from "react";
import { Download, Search } from "lucide-react";

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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  StatusPill,
  pillToneForBookingStatus,
} from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useAdminBookings, useUpdateBooking } from "@/features/bookings/hooks";
import { BookingDrawer } from "@/features/bookings/components/BookingDrawer";
import { extractList } from "@/utils/extractList";
import { formatCurrency, formatDate } from "@/utils/format";
import { downloadCsv, toCsv } from "@/utils/csv";

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "confirmed", label: "Confirmed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "completed", label: "Completed" },
];

export default function BookingsPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [activeBooking, setActiveBooking] = useState(null);
  const debounced = useDebouncedValue(search, 300);

  const params = useMemo(() => {
    const next = {};
    if (debounced) next.search = debounced;
    if (statusFilter !== "all") next.status = statusFilter;
    if (from) next.from = from;
    if (to) next.to = to;
    return next;
  }, [debounced, statusFilter, from, to]);

  const bookingsQuery = useAdminBookings(params);
  const updateBooking = useUpdateBooking();
  const list = useMemo(() => extractList(bookingsQuery.data, ["bookings"]), [bookingsQuery.data]);

  function handleExport() {
    if (!list.length) return;
    const csv = toCsv(list, [
      { key: "reference", label: "Reference", accessor: (b) => b.reference || b.code || b._id },
      {
        key: "customer",
        label: "Customer",
        accessor: (b) => b?.user?.name || b?.customer || b?.guestName,
      },
      {
        key: "tour",
        label: "Tour",
        accessor: (b) => b?.tour?.name || b?.tourName || b?.product || b?.title,
      },
      { key: "status", label: "Status", accessor: (b) => b?.status },
      { key: "travelDate", label: "Travel Date", accessor: (b) => b?.startDate || b?.travelDate || b?.date },
      {
        key: "amount",
        label: "Amount",
        accessor: (b) => b?.amount ?? b?.totalAmount ?? b?.price ?? b?.total,
      },
      { key: "currency", label: "Currency", accessor: (b) => b?.currency || "USD" },
      { key: "createdAt", label: "Created", accessor: (b) => b?.createdAt || b?.created_at },
    ]);
    downloadCsv(`bookings-${Date.now()}.csv`, csv);
  }

  return (
    <div className="grid gap-5">
      <AdminCard>
        <AdminCardHeader>
          <div>
            <AdminCardTitle>Bookings</AdminCardTitle>
            <AdminCardDescription>Filter, review and update bookings.</AdminCardDescription>
          </div>
          <AdminButton variant="outline" onClick={handleExport} disabled={!list.length}>
            <Download className="size-4" /> Export CSV
          </AdminButton>
        </AdminCardHeader>
        <AdminCardContent>
          <div className="grid gap-3 lg:grid-cols-[1fr_180px_180px_180px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[color:var(--admin-muted)]" />
              <AdminInput
                placeholder="Search reference, customer or tour..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <AdminInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <AdminInput type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>

          <div className="mt-5 overflow-hidden rounded-2xl border border-[color:var(--admin-border)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Tour</TableHead>
                  <TableHead>Travel date</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bookingsQuery.isLoading ? (
                  [0, 1, 2, 3, 4].map((i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={6}>
                        <Skeleton className="h-10 rounded-xl" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : list.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-sm text-[color:var(--admin-muted)]">
                      No bookings match the current filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  list.map((booking) => {
                    const id = booking?._id || booking?.id;
                    const tour = booking?.tour?.name || booking?.tourName || booking?.product || booking?.title || "Tour";
                    const customer = booking?.user?.name || booking?.customer || booking?.guestName || "Guest";
                    const reference = booking?.reference || booking?.code || id;
                    const status = booking?.status || "pending";
                    const amount = booking?.amount ?? booking?.totalAmount ?? booking?.price ?? booking?.total;
                    const currency = booking?.currency || "USD";
                    const travelDate = booking?.startDate || booking?.travelDate || booking?.date;
                    return (
                      <TableRow
                        key={id}
                        onClick={() => setActiveBooking(booking)}
                        className="cursor-pointer"
                      >
                        <TableCell className="font-mono text-xs">{reference}</TableCell>
                        <TableCell>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-[color:var(--admin-text)]">{customer}</p>
                            <p className="truncate text-xs text-[color:var(--admin-muted)]">
                              {booking?.user?.email || booking?.email || "—"}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <p className="max-w-[260px] truncate text-sm text-[color:var(--admin-text)]">{tour}</p>
                        </TableCell>
                        <TableCell className="text-sm text-[color:var(--admin-muted)]">{formatDate(travelDate)}</TableCell>
                        <TableCell className="text-sm font-semibold text-[color:var(--admin-text)]">
                          {amount !== undefined ? formatCurrency(amount, currency) : "—"}
                        </TableCell>
                        <TableCell>
                          <StatusPill tone={pillToneForBookingStatus(status)}>{status}</StatusPill>
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

      <BookingDrawer
        booking={activeBooking}
        open={Boolean(activeBooking)}
        onOpenChange={(open) => !open && setActiveBooking(null)}
        onUpdate={(vars) => updateBooking.mutate(vars, { onSuccess: () => setActiveBooking(null) })}
        isUpdating={updateBooking.isPending}
      />
    </div>
  );
}
