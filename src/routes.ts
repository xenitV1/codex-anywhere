/**
 * codex-anywhere — HTTP Route Handlers
 *
 * Handles all non-responses endpoints: health, stats, models, context, pass-through.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { UPSTREAM, KEY, AVAILABLE_MODELS, ACTIVE_MODEL, CONTEXT_WINDOW } from "./config.js";
import { getModelInfo, getAllModels, getAllModelsUnfiltered, isCatalogReady } from "./models.js";
import { sessionUsage } from "./session.js";
import { readBody } from "./handler.js";
import { VERSION } from "./version.js";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function contextBar(used: number, total: number): string {
  const width = 30;
  const pct = total > 0 ? used / total : 0;
  const filled = Math.min(Math.round(pct * width), width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const compact = Math.floor(total * 0.9);
  const compactMark = Math.round((compact / total) * width);
  let line2 = " ".repeat(compactMark) + "↑ compact here";
  return `[${bar}] ${pct.toFixed(1)}%\n ${formatTokens(used)} / ${formatTokens(total)} tokens\n${line2}`;
}

export function handleHealth(res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    upstream: UPSTREAM,
    hasApiKey: !!KEY,
    version: VERSION,
  }));
}

export function handleStats(res: ServerResponse) {
  const totalUsed = sessionUsage.totalInputTokens + sessionUsage.totalOutputTokens;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    cumulative: {
      input_tokens: sessionUsage.totalInputTokens,
      output_tokens: sessionUsage.totalOutputTokens,
      reasoning_tokens: sessionUsage.totalReasoningTokens,
      total_tokens: totalUsed,
    },
    request_count: sessionUsage.requestCount,
    model: sessionUsage.lastModel,
    note: "Cumulative proxy session usage. Codex tracks conversation context independently using response.usage data.",
  }, null, 2));
}

export function handleModelsList(res: ServerResponse, search: string) {
  const entries = Object.entries(getAllModelsUnfiltered())
    .filter(([id]) => !search || id.toLowerCase().includes(search))
    .map(([id, info]) => ({
      id,
      context_window: info?.context_window || CONTEXT_WINDOW || 200000,
      max_output: info.max_output,
      reasoning: info.reasoning,
      tool_call: info.tool_call,
      provider: info.provider_name,
      compact_threshold: Math.floor((info?.context_window || CONTEXT_WINDOW || 200000) * 0.9),
    }))
    .sort((a, b) => b.context_window - a.context_window);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    total: entries.length,
    source: "models.dev + builtin",
    models: entries,
  }, null, 2));
}

/**
 * /models/filtered — returns only the provider-filtered models.
 * Used by CLI for model selection during install/config.
 */
export function handleModelsFiltered(res: ServerResponse) {
  const allFiltered = getAllModels();
  const entries = Object.entries(allFiltered)
    .map(([id, info]) => ({
      id,
      context_window: info?.context_window || CONTEXT_WINDOW || 200000,
      max_output: info.max_output,
      reasoning: info.reasoning,
      tool_call: info.tool_call,
      provider: info.provider_name,
      compact_threshold: Math.floor((info?.context_window || CONTEXT_WINDOW || 200000) * 0.9),
    }))
    .sort((a, b) => b.context_window - a.context_window);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    total: entries.length,
    catalog_ready: isCatalogReady(),
    active: ACTIVE_MODEL || "",
    available: AVAILABLE_MODELS || [],
    models: entries,
  }, null, 2));
}

export function handleModelInfo(res: ServerResponse, modelName: string) {
  const info = getModelInfo(modelName);
  if (!info) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Model '${modelName}' not found in catalog` }));
    return;
  }
  const ctxWindow = info?.context_window || CONTEXT_WINDOW || 200000;
  const compactAt = Math.floor(ctxWindow * 0.9);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    model: modelName,
    context_window: info?.context_window || CONTEXT_WINDOW || 200000,
    max_output: info.max_output,
    reasoning: info.reasoning,
    tool_call: info.tool_call,
    provider: info.provider_name,
    compact_threshold: compactAt,
    codex_config: `model_context_window = ${info?.context_window || CONTEXT_WINDOW || 200000}\nmodel_auto_compact_token_limit = ${compactAt}`,
  }, null, 2));
}

export function handleContext(res: ServerResponse, model: string) {
  const info = getModelInfo(model);
  const ctxWindow = info?.context_window || 0;
  const compactAt = ctxWindow ? Math.floor(ctxWindow * 0.9) : 0;
  const used = sessionUsage.totalInputTokens + sessionUsage.totalOutputTokens;
  const pct = ctxWindow ? ((used / ctxWindow) * 100).toFixed(1) : "N/A";
  const bar = ctxWindow ? contextBar(used, ctxWindow) : "[no model info]";

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    model,
    provider: info?.provider_name || "unknown",
    context_window: ctxWindow,
    compact_threshold: compactAt,
    used_tokens: used,
    usage_percent: ctxWindow ? `${pct}%` : "N/A",
    breakdown: {
      input_tokens: sessionUsage.totalInputTokens,
      output_tokens: sessionUsage.totalOutputTokens,
      reasoning_tokens: sessionUsage.totalReasoningTokens,
    },
    request_count: sessionUsage.requestCount,
    visual: bar,
  }, null, 2));
}


/** Format a model slug into a human-readable display name. */
function formatDisplayName(slug: string): string {
  return slug
    .split(/[-_]/)
    .map((part) => {
      if (/^\d/.test(part)) return part;
      if (/^(glm|gpt|llm|qwen|vllm|lmi)$/i.test(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export async function handlePassThrough(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const upstreamPath = UPSTREAM.replace(/\/$/, "") + pathname.replace("/v1", "");
  const passHeaders: Record<string, string> = { host: new URL(UPSTREAM).host };
  if (KEY) passHeaders.authorization = `Bearer ${KEY}`;
  // Forward content-type from original request (upstreams reject without it)
  const ct = req.headers["content-type"];
  if (ct) passHeaders["content-type"] = ct;
  try {
    const resp = await fetch(upstreamPath, {
      method: req.method || "GET",
      headers: passHeaders,
      body: ["GET", "HEAD"].includes(req.method || "GET") ? undefined : await readBody(req),
    });
    const body = await resp.text();
    const respCt = resp.headers.get("content-type") || "application/json";
    res.writeHead(resp.status, { "Content-Type": respCt });
    res.end(body);
  } catch (err: any) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: err.message } }));
  }
}

/**
 * Codex-compatible /v1/models endpoint.
 *
 * Codex expects a non-standard format: { models: ModelInfo[] }
 * where each model has "slug", "display_name", context_window, etc.
 * This is NOT the standard OpenAI format ({ object: "list", data: [...] }).
 *
 * Query params: ?client_version=0.99.0 (Codex always sends this)
 */
export function handleCodexModelsList(res: ServerResponse) {
  // Return real upstream model names as slugs. Codex uses these as available_models
  // for spawn_agent validation and TUI display. No GPT aliasing needed.
  const allModels = getAllModels();
  const models = Object.entries(allModels).map(([id, info]) => ({
    slug: id,
    display_name: formatDisplayName(id),
    description: `${info.provider_name || "Unknown"} model — ${formatTokens(info?.context_window || CONTEXT_WINDOW || 200000)} context`,
    default_reasoning_level: info.reasoning ? "medium" : null,
    supported_reasoning_levels: info.reasoning
      ? [
          { effort: "low", description: "low" },
          { effort: "medium", description: "medium" },
          { effort: "high", description: "high" },
        ]
      : [],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: "",
    model_messages: null,
    supports_reasoning_summaries: info.reasoning,
    default_reasoning_summary: info.reasoning ? "auto" : null,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "json",
    web_search_tool_type: "disabled",
    truncation_policy: { mode: "bytes", limit: 10000 },
    supports_parallel_tool_calls: info.tool_call,
    supports_image_detail_original: false,
    context_window: info?.context_window || CONTEXT_WINDOW || 200000,
    max_context_window: info?.context_window || CONTEXT_WINDOW || 200000,
    auto_compact_token_limit: Math.floor((info?.context_window || CONTEXT_WINDOW || 200000) * 0.9),
    effective_context_window_percent: 95,
    experimental_supported_tools: info.tool_call ? ["function"] : [],
    input_modalities: ["text"],
    supports_search_tool: false,
  }));

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ models }));
}
