import { Calendar, Mail, Phone, User } from "lucide-react";

import { AdminButton } from "@/components/ui/admin-button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusPill, pillToneForBookingStatus } from "@/components/ui/status-pill";
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatRelative,
} from "@/utils/format";

const STATUS_OPTIONS = ["pending", "confirmed", "cancelled", "completed", "refunded"];

export function BookingDrawer({ booking, open, onOpenChange, onUpdate, isUpdating }) {
  if (!booking) return null;
  const id = booking?._id || booking?.id;
  const status = booking?.status || "pending";
  const tour = booking?.tour?.name || booking?.tourName || booking?.product || booking?.title || "Booking";
  const customer = booking?.user?.name || booking?.customer || booking?.guestName || "Guest";
  const email = booking?.user?.email || booking?.email;
  const phone = booking?.user?.phone || booking?.phone;
  const amount = booking?.amount ?? booking?.totalAmount ?? booking?.price ?? booking?.total;
  const currency = booking?.currency || "USD";
  const createdAt = booking?.createdAt || booking?.created_at;
  const travelDate = booking?.startDate || booking?.travelDate || booking?.date;
  const guests = booking?.guests ?? booking?.numberOfGuests ?? booking?.participants;
  const reference = booking?.reference || booking?.code || booking?.bookingReference || id;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="mx-auto max-w-2xl">
        <DrawerHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <DrawerTitle>{tour}</DrawerTitle>
              <DrawerDescription>Reference: {reference}</DrawerDescription>
            </div>
            <StatusPill tone={pillToneForBookingStatus(status)}>{status}</StatusPill>
          </div>
        </DrawerHeader>
        <div className="grid gap-4 px-6 pb-2">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-[color:var(--admin-border)] bg-[color:var(--admin-panel-2)] p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-[color:var(--admin-muted)]">Customer</p>
              <p className="mt-1 flex items-center gap-2 text-sm font-semibold text-[color:var(--admin-text)]">
                <User className="size-4" /> {customer}
              </p>
              {email ? (
                <p className="mt-1 flex items-center gap-2 text-xs text-[color:var(--admin-muted)]">
                  <Mail className="size-3.5" /> {email}
                </p>
              ) : null}
              {phone ? (
                <p className="mt-1 flex items-center gap-2 text-xs text-[color:var(--admin-muted)]">
                  <Phone className="size-3.5" /> {phone}
                </p>
              ) : null}
            </div>
            <div className="rounded-xl border border-[color:var(--admin-border)] bg-[color:var(--admin-panel-2)] p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-[color:var(--admin-muted)]">Travel</p>
              <p className="mt-1 flex items-center gap-2 text-sm font-semibold text-[color:var(--admin-text)]">
                <Calendar className="size-4" /> {formatDate(travelDate)}
              </p>
              <p className="mt-1 text-xs text-[color:var(--admin-muted)]">
                {guests !== undefined ? `${guests} guest(s)` : ""}
              </p>
              <p className="mt-1 text-xs text-[color:var(--admin-muted)]">
                Created {formatRelative(createdAt)} ({formatDateTime(createdAt)})
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-[color:var(--admin-border)] bg-[color:var(--admin-panel-2)] p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-[color:var(--admin-text)]">Total amount</p>
              <p className="text-lg font-bold text-[color:var(--admin-text)]">
                {amount !== undefined ? formatCurrency(amount, currency) : "—"}
              </p>
            </div>
          </div>
        </div>

        <DrawerFooter>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid w-full gap-1.5 sm:max-w-xs">
              <span className="text-xs font-semibold uppercase tracking-wider text-[color:var(--admin-muted)]">
                Update status
              </span>
              <Select
                value={status}
                onValueChange={(value) => onUpdate?.({ id, payload: { status: value } })}
                disabled={isUpdating || !id}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <AdminButton variant="outline" onClick={() => onOpenChange?.(false)}>
              Close
            </AdminButton>
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
