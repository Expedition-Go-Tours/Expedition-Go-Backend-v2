import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { fetchAdminBookings, updateBooking } from "./api";

export const bookingKeys = {
  all: ["admin-bookings"],
  list: (params) => [...bookingKeys.all, params || {}],
};

export function useAdminBookings(params) {
  return useQuery({
    queryKey: bookingKeys.list(params),
    queryFn: ({ signal }) => fetchAdminBookings({ signal, params }),
    placeholderData: (prev) => prev,
  });
}

function applyOptimistic(queryClient, id, transform) {
  const queries = queryClient.getQueriesData({ queryKey: bookingKeys.all });
  const previous = queries.map(([key, data]) => ({ key, data }));

  queries.forEach(([key, data]) => {
    if (!data) return;
    const list = Array.isArray(data) ? data : data?.bookings || data?.data || data?.items;
    if (!Array.isArray(list)) return;
    const next = list.map((b) => {
      const matches = b?._id === id || b?.id === id;
      return matches ? transform(b) : b;
    });
    if (Array.isArray(data)) {
      queryClient.setQueryData(key, next);
    } else if (Array.isArray(data?.bookings)) {
      queryClient.setQueryData(key, { ...data, bookings: next });
    } else if (Array.isArray(data?.data)) {
      queryClient.setQueryData(key, { ...data, data: next });
    } else if (Array.isArray(data?.items)) {
      queryClient.setQueryData(key, { ...data, items: next });
    }
  });

  return previous;
}

function rollback(queryClient, previous) {
  if (!previous) return;
  previous.forEach(({ key, data }) => queryClient.setQueryData(key, data));
}

export function useUpdateBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }) => updateBooking(id, payload),
    onMutate: async ({ id, payload }) => {
      await queryClient.cancelQueries({ queryKey: bookingKeys.all });
      const previous = applyOptimistic(queryClient, id, (b) => ({ ...b, ...payload }));
      return { previous };
    },
    onError: (error, _vars, context) => {
      rollback(queryClient, context?.previous);
      toast.error(error?.message || "Could not update booking");
    },
    onSuccess: () => {
      toast.success("Booking updated");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: bookingKeys.all });
    },
  });
}
