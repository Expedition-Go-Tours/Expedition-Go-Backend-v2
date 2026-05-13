// ============================================================================
// EXPEDITION GO - API CLIENT
// Complete API client with all necessary exports
// Place this file at: src/api/client.js (or wherever your client.js is)
// ============================================================================

import { getApiBaseUrl, getAuthToken } from "@/lib/auth";

/**
 * Normalized API error returned to React Query / UI.
 */
export class ApiError extends Error {
  constructor({ message, status, data, url }) {
    super(message || "Request failed");
    this.name = "ApiError";
    this.status = status ?? 0;
    this.data = data ?? null;
    this.url = url ?? null;
  }
}

function joinUrl(base, path) {
  if (!path) return base;
  if (/^https?:\/\//i.test(path)) return path;
  const cleanedBase = base.replace(/\/+$/, "");
  const cleanedPath = path.startsWith("/") ? path : `/${path}`;
  return `${cleanedBase}${cleanedPath}`;
}

function buildQuery(params) {
  if (!params) return "";
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      value.forEach((entry) => search.append(key, String(entry)));
    } else {
      search.append(key, String(value));
    }
  });
  const str = search.toString();
  return str ? `?${str}` : "";
}

async function parseResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (response.status === 204) return null;
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  try {
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Lightweight fetch wrapper used by every React Query hook.
 *
 * Options:
 *  - method: HTTP verb
 *  - params: object of query string params (skips null/undefined)
 *  - body: any JSON-serializable body
 *  - signal: AbortSignal forwarded by React Query
 *  - auth: when false, skips attaching the Authorization header
 */
export async function apiRequest(path, options = {}) {
  const { method = "GET", params, body, signal, auth = true, headers = {} } = options;
  const base = getApiBaseUrl();
  const url = `${joinUrl(base, path)}${buildQuery(params)}`;

  const finalHeaders = {
    Accept: "application/json",
    ...headers,
  };

  let payload;
  if (body !== undefined && body !== null) {
    if (body instanceof FormData) {
      payload = body;
    } else {
      finalHeaders["Content-Type"] = finalHeaders["Content-Type"] || "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body);
    }
  }

  if (auth) {
    try {
      const token = await getAuthToken();
      if (token) finalHeaders.Authorization = `Bearer ${token}`;
    } catch {
      // Silent: requests can proceed unauthenticated, the backend will respond 401.
    }
  }

  let response;
  try {
    response = await fetch(url, { method, headers: finalHeaders, body: payload, signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ApiError({
      message: error?.message || "Network request failed",
      status: 0,
      url,
    });
  }

  const data = await parseResponse(response);

  if (!response.ok) {
    const message =
      (data && typeof data === "object" && (data.message || data.error)) ||
      response.statusText ||
      `Request failed with status ${response.status}`;
    throw new ApiError({ message, status: response.status, data, url });
  }

  return data;
}

/**
 * Many backends wrap responses in `{ status: 'success', data: ... }`.
 * Helper that returns the inner payload when present.
 */
export function unwrap(payload, key) {
  if (!payload || typeof payload !== "object") return payload;
  if (key && payload?.data && payload.data[key] !== undefined) return payload.data[key];
  if (payload?.data !== undefined) return payload.data;
  return payload;
}

// Export everything for convenience
export default {
  apiRequest,
  ApiError,
  unwrap,
};
