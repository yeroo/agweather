import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// workers-oauth-provider imports `WorkerEntrypoint` from the workerd-only
		// `cloudflare:workers` module. Tests run in plain Node, so point it at a stub.
		alias: {
			"cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		// Process the provider through Vite (not Node's loader) so the alias above applies inside it.
		server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
		include: ["test/**/*.test.ts"],
	},
});
