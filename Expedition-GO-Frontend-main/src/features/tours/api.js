import { apiRequest, unwrap } from "@/api/client";
import { TOUR_ENDPOINTS } from "@/api/endpoints";

export async function fetchTours({ signal, params } = {}) {
  return unwrap(await apiRequest(TOUR_ENDPOINTS.list, { signal, params, auth: false }));
}

export async function createTour(formData) {
  return unwrap(
    await apiRequest(TOUR_ENDPOINTS.create, {
      method: "POST",
      body: formData,
    }),
  );
}
