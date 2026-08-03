import { fileURLToPath } from "node:url";
import { defineConfig, type ViteDevServer } from "vite";
import { createWireServer } from "../../test/wire-server.ts";

const harnessRoot = fileURLToPath(new URL(".", import.meta.url));

/** 08-ui §4–5 — real-browser harness backed by the exact in-test wire route table. */
export default defineConfig(async () => {
  const wire = await createWireServer({ islandApp: true });
  wire.state.posture = "rules";
  // §16 law 3 (/byo-embed-failed) — a terminally failed build carrying the
  // EXACT sentence the wave E2E photographed in a real user's thread on
  // 2026-08-03. It is a developer's sentence (a component name, an unevaluated
  // expression) and the embed must not print any of it. Harness-only: the unit
  // wire fixture seeds no failed apps, so nothing else sees this row.
  wire.state.failedApps.set("app_build_failed", {
    reason: "This app wasn't created, because it didn't pass the checks that keep an app honest:"
      + " the `value` expression is a declarative string that the DataTable does not evaluate,"
      + " not JavaScript: amount / sum(spending.data.amount)",
    retryable: true,
    prompt: "a board showing where my money goes each month",
  });

  return {
    root: harnessRoot,
    clearScreen: false,
    // The harness imports the package's source entry files directly (the same
    // entries the subpath exports point at): a self-import by package name is
    // not a layering edge the dependency guard can tell apart from a real one.
    server: {
      host: "127.0.0.1",
      // Ephemeral by default so parallel lanes never collide; playwright.config
      // reserves a free port and passes it via env + the CLI --port flag.
      port: Number(process.env.VENDO_HARNESS_PORT) || 4_173,
      strictPort: true,
      proxy: {
        "/api/vendo": {
          target: wire.url,
          changeOrigin: false,
          rewrite: (path: string) => path.replace(/^\/api\/vendo/, ""),
        },
      },
    },
    plugins: [{
      name: "vendo-wire-lifecycle",
      configureServer(server: ViteDevServer) {
        server.httpServer?.once("close", () => void wire.close());
      },
    }],
  };
});
