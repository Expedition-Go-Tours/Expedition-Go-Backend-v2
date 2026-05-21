import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Loader2, CheckCircle2, AlertCircle, ArrowRight, Shield } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/axios";
import { useAuthStore } from "@/stores/authStore";

/**
 * AuthCallback
 *
 * Cross-domain authentication bridge.
 * When the main site (travioafrica.com) redirects a logged-in user here
 * with ?token=<firebase_id_token>, this page:
 *  1. Reads the token from the URL
 *  2. POSTs it to /api/auth/verify-token (backend verifies with Firebase Admin)
 *  3. The backend sets an HTTP-only __session cookie
 *  4. We update local auth state and redirect to the dashboard
 *
 * The token is removed from the URL immediately to prevent it from lingering
 * in browser history or referrer headers.
 */
export default function AuthCallback() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const login = useAuthStore((state) => state.login);
  const [status, setStatus] = useState("checking"); // checking | loading | success | error
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    const token = searchParams.get("token");

    if (!token) {
      setStatus("error");
      setErrorMessage("No authentication token found in the URL.");
      toast.error("Authentication failed: missing token.");
      return;
    }

    // Immediately remove token from URL so it doesn't stay in browser history
    // or get leaked via referrer headers.
    if (window.history.replaceState) {
      const cleanUrl =
        window.location.protocol +
        "//" +
        window.location.host +
        window.location.pathname;
      try {
        window.history.replaceState({ path: cleanUrl }, "", cleanUrl);
      } catch {
        // SecurityError can occur in jsdom/iframe contexts — safe to ignore
      }
    }

    setStatus("loading");

    // POST token to backend for verification and session cookie creation
    api
      .post(
        "/auth/verify-token",
        { token },
        { withCredentials: true } // required: tells browser to accept the __session cookie
      )
      .then((response) => {
        const { user, token: backendToken } = response.data;

        if (!user) {
          throw new Error("Backend did not return user data.");
        }

        // Persist token in localStorage as fallback if cookies are blocked
        // The __session cookie is the primary auth mechanism, but we keep
        // the Authorization header as a backup (e.g., Safari in private mode).
        const authToken = backendToken || token;
        if (authToken) {
          login(user, authToken);
        } else {
          // Cookie-only mode: just update user state
          useAuthStore.setState({ user, isAuthenticated: true });
        }

        setStatus("success");
        toast.success(`Welcome back, ${user.name || user.email || ""}!`);

        // Give the user a moment to see the success state, then redirect
        setTimeout(() => {
          navigate("/", { replace: true });
        }, 1500);
      })
      .catch((err) => {
        const message =
          err.response?.data?.error ||
          err.response?.data?.message ||
          err.message ||
          "Session verification failed.";

        setStatus("error");
        setErrorMessage(message);
        toast.error(message);
      });
  }, [searchParams, login, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f8fafc] px-4">
      <div className="max-w-md w-full bg-white rounded-xl border border-[#eaeaea] shadow-sm p-8 text-center">
        <div className="flex justify-center mb-6">
          <div className="w-16 h-16 rounded-full bg-[#f0fdf4] flex items-center justify-center">
            {status === "checking" || status === "loading" ? (
              <Loader2 size={32} className="text-[#044b3b] animate-spin" />
            ) : status === "success" ? (
              <CheckCircle2 size={32} className="text-[#16a34a]" />
            ) : (
              <AlertCircle size={32} className="text-[#dc2626]" />
            )}
          </div>
        </div>

        <h1 className="text-xl font-bold text-[#1e293b] mb-2">
          {status === "checking" && "Checking authentication…"}
          {status === "loading" && "Verifying your session…"}
          {status === "success" && "Authentication successful!"}
          {status === "error" && "Authentication failed"}
        </h1>

        <p className="text-sm text-[#64748b] mb-6">
          {status === "checking" &&
            "We're reading the token from your main site sign-in."}
          {status === "loading" &&
            "Please wait while we validate your credentials and establish a secure session."}
          {status === "success" &&
            "Your session is active. Redirecting you to the dashboard…"}
          {status === "error" && errorMessage}
        </p>

        {status === "success" && (
          <button
            onClick={() => navigate("/", { replace: true })}
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-[#044b3b] text-white rounded-lg text-sm font-medium hover:bg-[#033629] transition-colors"
          >
            <span>Go to Dashboard</span>
            <ArrowRight size={16} />
          </button>
        )}

        {status === "error" && (
          <div className="space-y-3">
            <button
              onClick={() =>
                (window.location.href = "https://travioafrica.com/login")
              }
              className="inline-flex items-center gap-2 px-6 py-2.5 bg-[#044b3b] text-white rounded-lg text-sm font-medium hover:bg-[#033629] transition-colors"
            >
              <Shield size={16} />
              <span>Log in on Main Site</span>
            </button>
            <p className="text-xs text-[#9e9e9e]">
              After logging in, click "Become a supplier" again.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
