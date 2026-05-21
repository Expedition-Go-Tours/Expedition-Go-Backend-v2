import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { createTour, fetchTours } from "./api";

export const tourKeys = {
  all: ["tours"],
  list: (params) => [...tourKeys.all, params || {}],
};

export function useTours(params) {
  return useQuery({
    queryKey: tourKeys.list(params),
    queryFn: ({ signal }) => fetchTours({ signal, params }),
    placeholderData: (prev) => prev,
  });
}

export function useCreateTour() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (formData) => createTour(formData),
    onSuccess: (result) => {
      const createdTour =
        result?.tour ||
        result?.data?.tour ||
        (result && typeof result === "object" && !Array.isArray(result) ? result : null);

      if (createdTour) {
        const queries = queryClient.getQueriesData({ queryKey: tourKeys.all });
        queries.forEach(([key, data]) => {
          if (!data) return;
          const list =
            Array.isArray(data) ? data : data?.tours || data?.data?.tours || data?.data || data?.items || null;
          if (!Array.isArray(list)) return;
          const id = createdTour?._id || createdTour?.id;
          const exists = id
            ? list.some((item) => (item?._id || item?.id) === id)
            : false;
          if (exists) return;
          const next = [createdTour, ...list];
          if (Array.isArray(data)) {
            queryClient.setQueryData(key, next);
          } else if (Array.isArray(data?.tours)) {
            queryClient.setQueryData(key, { ...data, tours: next });
          } else if (data?.data && Array.isArray(data.data.tours)) {
            queryClient.setQueryData(key, { ...data, data: { ...data.data, tours: next } });
          } else if (Array.isArray(data?.data)) {
            queryClient.setQueryData(key, { ...data, data: next });
          } else if (Array.isArray(data?.items)) {
            queryClient.setQueryData(key, { ...data, items: next });
          }
        });
      }

      toast.success("Tour created");
      queryClient.invalidateQueries({ queryKey: tourKeys.all });
      queryClient.invalidateQueries({ queryKey: ["admin-tours"] });
    },
    onError: (error) => {
      toast.error(error?.message || "Could not create tour");
    },
  });
}
