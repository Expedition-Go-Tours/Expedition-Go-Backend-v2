import { apiRequest, unwrap } from "@/api/client";
import { ADMIN_ENDPOINTS } from "@/api/endpoints";

export async function fetchAdminUsers({ signal, params } = {}) {
  return unwrap(await apiRequest(ADMIN_ENDPOINTS.users, { signal, params }));
}

export async function updateUserRole(id, role) {
  return unwrap(
    await apiRequest(ADMIN_ENDPOINTS.userRole(id), {
      method: "PATCH",
      body: { role },
    }),
  );
}

export async function updateUserStatus(id, status) {
  return unwrap(
    await apiRequest(ADMIN_ENDPOINTS.userStatus(id), {
      method: "PATCH",
      body: { status },
    }),
  );
}

export async function deleteUser(id) {
  return unwrap(await apiRequest(ADMIN_ENDPOINTS.userById(id), { method: "DELETE" }));
}
