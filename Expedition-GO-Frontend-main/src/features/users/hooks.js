import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { deleteUser, fetchAdminUsers, updateUserRole, updateUserStatus } from "./api";

export const userKeys = {
  all: ["admin-users"],
  list: (params) => [...userKeys.all, params || {}],
};

export function useAdminUsers(params) {
  return useQuery({
    queryKey: userKeys.list(params),
    queryFn: ({ signal }) => fetchAdminUsers({ signal, params }),
    placeholderData: (prev) => prev,
  });
}

function applyOptimistic(queryClient, id, transform) {
  const queries = queryClient.getQueriesData({ queryKey: userKeys.all });
  const previous = queries.map(([key, data]) => ({ key, data }));

  queries.forEach(([key, data]) => {
    if (!data) return;
    const list = Array.isArray(data) ? data : data?.users || data?.data || data?.items;
    if (!Array.isArray(list)) return;
    const next = list.map((u) => {
      const matches = u?._id === id || u?.id === id;
      return matches ? transform(u) : u;
    });
    if (Array.isArray(data)) {
      queryClient.setQueryData(key, next);
    } else if (Array.isArray(data?.users)) {
      queryClient.setQueryData(key, { ...data, users: next });
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

export function useUpdateUserRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, role }) => updateUserRole(id, role),
    onMutate: async ({ id, role }) => {
      await queryClient.cancelQueries({ queryKey: userKeys.all });
      const previous = applyOptimistic(queryClient, id, (u) => ({ ...u, role }));
      return { previous };
    },
    onError: (error, _vars, context) => {
      rollback(queryClient, context?.previous);
      toast.error(error?.message || "Could not update role");
    },
    onSuccess: () => {
      toast.success("Role updated");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: userKeys.all });
    },
  });
}

export function useUpdateUserStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }) => updateUserStatus(id, status),
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: userKeys.all });
      const previous = applyOptimistic(queryClient, id, (u) => ({ ...u, status }));
      return { previous };
    },
    onError: (error, _vars, context) => {
      rollback(queryClient, context?.previous);
      toast.error(error?.message || "Could not update status");
    },
    onSuccess: () => {
      toast.success("Status updated");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: userKeys.all });
    },
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) => deleteUser(id),
    onSuccess: () => {
      toast.success("User deleted");
      queryClient.invalidateQueries({ queryKey: userKeys.all });
    },
    onError: (error) => {
      toast.error(error?.message || "Could not delete user");
    },
  });
}
