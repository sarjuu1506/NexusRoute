import { defineConfig } from "vite";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { handleApiRequest } from "./server/api.mjs";

const serverOnlyKeys = ["ORS_API_KEY", "TOMTOM_API_KEY", "GEMINI_API_KEY", "PORT"];

export default defineConfig(({ mode }) => {
  const loaded = loadEnv(mode, process.cwd(), "");
  for (const key of serverOnlyKeys) {
    if (!process.env[key] && loaded[key]) process.env[key] = loaded[key];
  }

  return {
    envPrefix: ["VITE_", "WAYFI_PUBLIC_"],
    plugins: [
      react(),
      {
        name: "wayfi-private-api",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (!request.url?.startsWith("/api/")) return next();
            void handleApiRequest(request, response);
          });
        }
      }
    ]
  };
});