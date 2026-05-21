import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Auth Store
 *
 * Manages authentication state for the supplier dashboard.
 * Supports two auth mechanisms:
 *  1. Cookie-based session (__session cookie set by backend after
 *     /api/auth/verify-token). This is the PRIMARY mechanism.
 *  2. localStorage fallback (Authorization: Bearer token). Used when
 *     cookies are blocked (e.g. Safari Private Mode, strict tracker blockers).
 */

export const useAuthStore = create(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,

      /**
       * Log in a user.
       * @param {Object} user  - User object (e.g. { uid, email, name, role })
       * @param {string} token - Optional JWT / Firebase ID token for localStorage fallback
       */
      login: (user, token) => {
        if (token) {
          localStorage.setItem("auth_token", token);
        }
        set({ user, token, isAuthenticated: true, isLoading: false });
      },

      /**
       * Update user data without touching the token.
       */
      updateUser: (userData) => {
        set((state) => ({
          user: state.user ? { ...state.user, ...userData } : userData,
        }));
      },

      /**
       * Set loading state (used during initial session check).
       */
      setLoading: (loading) => set({ isLoading: loading }),

      /**
       * Mark auth as failed / user is logged out.
       */
      setUnauthenticated: () => {
        localStorage.removeItem("auth_token");
        localStorage.removeItem("auth_user");
        set({ user: null, token: null, isAuthenticated: false, isLoading: false });
      },

      /**
       * Log out the user completely.
       * Also calls the backend to clear the __session cookie.
       */
      logout: async () => {
        // Attempt to clear the server-side session cookie
        try {
          const { default: api } = await import("@/lib/axios");
          await api.post("/auth/logout", {}, { withCredentials: true });
        } catch {
          // Backend logout is best-effort; local state must always clear.
        }
        localStorage.removeItem("auth_token");
        localStorage.removeItem("auth_user");
        set({ user: null, token: null, isAuthenticated: false, isLoading: false });
      },
    }),
    {
      name: "auth-storage",
      // Persist user and token so the user stays "logged in" across refreshes
      // even if cookies are unavailable.
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);

/**
 * Initialize auth state from localStorage on app load.
 * If a token is present, we optimistically assume the user is authenticated.
 * The first API call will validate the session (401 if the cookie/token expired).
 */
export function initAuthFromStorage() {
  const token = localStorage.getItem("auth_token");
  const userJson = localStorage.getItem("auth_user");
  const user = userJson ? JSON.parse(userJson) : null;

  if (token && user) {
    useAuthStore.setState({ user, token, isAuthenticated: true, isLoading: false });
  } else if (token || user) {
    // Partial state — clear it to avoid stale data
    useAuthStore.getState().setUnauthenticated();
  }
}
