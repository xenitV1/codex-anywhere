/**
 * codex-anywhere — HTTP Server
 *
 * Creates the HTTP server, wires routes, starts listening.
 */

import { createServer } from "http";
import { PORT, UPSTREAM, KEY } from "./config.js";
import { startModelsRefresh } from "./models.js";
import { handleResponsesRequest } from "./handler.js";
import {
  handleHealth,
  handleStats,
  handleModelsList,
  handleModelsFiltered,
  handleModelInfo,
  handleContext,
  handlePassThrough,
  handleCodexModelsList,
} from "./routes.js";

export async function startServer() {
  // ─── Pre-flight: check if proxy already running on this port ──
  // If a healthy proxy is already listening, exit cleanly so systemd
  // treats this as success (no crash loop). Only check on Linux/macOS.
  if (process.env.CODEX_PROXY_TEST !== "1") {
    try {
      const resp = await fetch(`http://localhost:${PORT}/health`);
      if (resp.ok) {
        console.log(`Proxy already running on port ${PORT} — exiting (healthy).`);
        process.exit(0);
      }
    } catch {
      // Port not in use — safe to start
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // ─── Codex model catalog (GET /v1/models?client_version=...) ──
    if ((pathname === "/models" || pathname === "/v1/models") && req.method === "GET") {
      const isCodexClient = url.searchParams.has("client_version") ||
        req.headers["x-codex-installation-id"] !== undefined;
      if (isCodexClient) {
        handleCodexModelsList(res);
        return;
      }
    }

    // ─── Custom model catalog (search, JSON format) ────────────────
    if (pathname === "/models" || pathname === "/v1/models") {
      const search = url.searchParams.get("q")?.toLowerCase() || "";
      handleModelsList(res, search);
      return;
    }

    // ─── Filtered models (for CLI model selection) ─────────────────
    if (pathname === "/models/filtered" || pathname === "/v1/models/filtered") {
      handleModelsFiltered(res);
      return;
    }

    // ─── Single model info ─────────────────────────────────────────
    if (pathname.startsWith("/model/") || pathname.startsWith("/v1/model/")) {
      const modelName = decodeURIComponent(pathname.split("/").pop() || "");
      handleModelInfo(res, modelName);
      return;
    }

    // ─── Context usage ─────────────────────────────────────────────
    if (pathname === "/context" || pathname === "/v1/context") {
      const model = url.searchParams.get("model") || "";
      handleContext(res, model);
      return;
    }

    // ─── Health check ──────────────────────────────────────────────
    if (pathname === "/health") {
      handleHealth(res);
      return;
    }

    // ─── Stats ─────────────────────────────────────────────────────
    if (pathname === "/stats" || pathname === "/v1/stats") {
      handleStats(res);
      return;
    }

    // ─── Responses API (main proxy) ────────────────────────────────
    if (req.method === "POST" && pathname.includes("/responses")) {
      try {
        await handleResponsesRequest(req, res);
      } catch (err) {
        console.error("[ERROR]", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
      return;
    }

    // ─── Pass-through to upstream ──────────────────────────────────
    await handlePassThrough(req, res, pathname);
  });

  server.listen(PORT, () => {
    startModelsRefresh();
    console.log("");
    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║  codex-anywhere — Codex CLI with any provider        ║");
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log(`║  Proxy:    http://localhost:${PORT}`.padEnd(55) + "║");
    console.log(`║  Upstream: ${UPSTREAM}`.slice(0, 55).padEnd(55) + "║");
    console.log(`║  API Key:  ${KEY ? "✓ configured" : "✗ missing — set in config.toml"}`.slice(0, 55).padEnd(55) + "║");
    console.log("║  Endpoints:                                          ║");
    console.log("║    /health        — proxy status                     ║");
    console.log("║    /models        — model catalog (search)           ║");
    console.log("║    /v1/models     — Codex model catalog              ║");
    console.log("║    /model/X       — single model info                ║");
    console.log("║    /v1/responses  — Responses API proxy              ║");
    console.log("║    /context       — session token usage              ║");
    console.log("║    /stats         — cumulative token stats           ║");
    console.log("╚══════════════════════════════════════════════════════╝");
    console.log("");
  });

  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${PORT} in use. Change port in config.toml.`);
      process.exit(1);
    }
  });

  return server;
}
