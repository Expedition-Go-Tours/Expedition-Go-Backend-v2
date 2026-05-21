import { useEffect } from "react";
import Providers from "./providers";
import AppRoutes from "./routes";
import ErrorBoundary from "@/components/shared/ErrorBoundary";
import { initAuthFromStorage } from "@/stores/authStore";

function App() {
  // Hydrate auth state from localStorage on first mount so the user
  // isn't treated as logged-out while the cookie is being verified.
  useEffect(() => {
    initAuthFromStorage();
  }, []);

  return (
    <ErrorBoundary>
      <Providers>
        <AppRoutes />
      </Providers>
    </ErrorBoundary>
  );
}

export default App;
