import { getApiBaseUrl, getAuthToken } from "@/lib/auth";

/**
 * Normalized API error for React Query/UI handling.
 */
export class ApiError extends Error {
  constructor({ message, status = 0, data = null, url = null }) {
    super(message || "Request failed");
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.url = url;
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

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;

    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry === undefined || entry === null || entry === "") continue;
        search.append(key, String(entry));
      }
      continue;
    }

    search.append(key, String(value));
  }

  const query = search.toString();
  return query ? `?${query}` : "";
}

async function parseResponse(response) {
  if (response.status === 204) return null;

  const contentType = response.headers.get("content-type") || "";

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

function getErrorMessage(data, response) {
  return (
    (data && typeof data === "object" && (data.message || data.error)) ||
    response.statusText ||
    `Request failed with status ${response.status}`
  );
}

/**
 * Lightweight fetch wrapper used by React Query hooks.
 */
export async function apiRequest(path, options = {}) {
  const {
    method = "GET",
    params,
    body,
    signal,
    auth = true,
    headers = {},
  } = options;

  const url = `${joinUrl(getApiBaseUrl(), path)}${buildQuery(params)}`;

  const finalHeaders = {
    Accept: "application/json",
    ...headers,
  };

  let payload;

  if (body !== undefined && body !== null) {
    if (body instanceof FormData) {
      payload = body;
    } else {
      finalHeaders["Content-Type"] =
        finalHeaders["Content-Type"] || "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body);
    }
  }

  if (auth) {
    try {
      const token = await getAuthToken();
      if (token) finalHeaders.Authorization = `Bearer ${token}`;
    } catch {
      // Allow unauthenticated requests to proceed normally.
    }
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: finalHeaders,
      body: payload,
      signal,
      credentials: "include",
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;

    throw new ApiError({
      message: error?.message || "Network request failed",
      url,
    });
  }

  const data = await parseResponse(response);

  if (!response.ok) {
    throw new ApiError({
      message: getErrorMessage(data, response),
      status: response.status,
      data,
      url,
    });
  }

  return data;
}

/**
 * Returns the inner `data` payload when the backend wraps responses.
 */
export function unwrap(payload, key) {
  if (!payload || typeof payload !== "object") return payload;
  if (key && payload?.data && payload.data[key] !== undefined) return payload.data[key];
  if (payload?.data !== undefined) return payload.data;
  return payload;
}
