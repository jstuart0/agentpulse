import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
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
			"/ws": {
				target: "ws://localhost:3000",
				ws: true,
			},
		},
	},
});
