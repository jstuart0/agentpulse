import { readFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8")) as {
	version: string;
};

export default defineConfig({
	plugins: [react()],
	define: {
		"import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version),
	},
	root: "src/web",
	resolve: {
		alias: {
			"@web": path.resolve(__dirname, "src/web"),
			"@shared": path.resolve(__dirname, "src/shared"),
		},
	},
	build: {
		outDir: "../../dist/web",
		emptyOutDir: true,
	},
	server: {
		port: 5173,
		proxy: {
			"/api": {
				target: "http://localhost:3000",
				changeOrigin: true,
			},
			// /app-api is the browser-facing path used by the React frontend
			// (BROWSER_WS_PATH = /app-api/v1/ws). The proxy must forward WS
			// upgrades so Origin: http://localhost:5173 reaches the API server,
			// which validates it against ALLOWED_ORIGINS.
			"/app-api": {
				target: "http://localhost:3000",
				changeOrigin: true,
				ws: true,
			},
			"/ws": {
				target: "ws://localhost:3000",
				ws: true,
			},
		},
	},
});
