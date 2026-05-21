import { apiRequest, unwrap } from "@/api/client";
import { ADMIN_ENDPOINTS } from "@/api/endpoints";

export async function fetchAdminBookings({ signal, params } = {}) {
  return unwrap(await apiRequest(ADMIN_ENDPOINTS.bookings, { signal, params }));
}

export async function updateBooking(id, payload) {
  return unwrap(
    await apiRequest(ADMIN_ENDPOINTS.bookingById(id), {
      method: "PATCH",
      body: payload,
    }),
  );
}
