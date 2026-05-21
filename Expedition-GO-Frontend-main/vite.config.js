import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const rawAuthProxyTarget =
    env.VITE_AUTH_PROXY_TARGET || "https://expedition-go-tours-website.onrender.com";
  const authTargetUrl = new URL(rawAuthProxyTarget);
  const authProxyOrigin = authTargetUrl.origin;
  const authProxyBasePath = authTargetUrl.pathname.replace(/\/+$/, "");

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      proxy: {
        "/api/v1": {
          target: authProxyOrigin,
          changeOrigin: true,
          secure: true,
          rewrite: (requestPath) => {
            // Avoid accidental /api/v1/api/v1 duplication when target includes /api/v1.
            if (!authProxyBasePath || authProxyBasePath === "/") return requestPath;
            if (requestPath.startsWith(`${authProxyBasePath}/`) || requestPath === authProxyBasePath) {
              return requestPath;
            }
            return `${authProxyBasePath}${requestPath}`;
          },
        },
      },
    },
  };
});
