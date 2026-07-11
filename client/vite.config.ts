import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "../shared"),
      react: path.resolve(__dirname, "./node_modules/react"),
      "react/jsx-runtime": path.resolve(__dirname, "./node_modules/react/jsx-runtime.js"),
      "react/jsx-dev-runtime": path.resolve(__dirname, "./node_modules/react/jsx-dev-runtime.js"),
      "react-dom": path.resolve(__dirname, "./node_modules/react-dom"),
      "react-dom/client": path.resolve(__dirname, "./node_modules/react-dom/client.js"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "^/api(?:/|$)": {
        target: "http://localhost:3000",
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
