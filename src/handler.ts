/**
 * codex-anywhere — Responses API Handler
 *
 * Handles POST /v1/responses requests, converts to chat/completions,
 * forwards to upstream, and converts response back.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { UPSTREAM, KEY, FILTER_NON_FUNCTION_TOOLS, ACTIVE_MODEL, AVAILABLE_MODELS, resolveModel, CONTEXT_WINDOW } from "./config.js";
import { getModelInfo } from "./models.js";
import { updateSessionUsage } from "./session.js";
import { responsesInputToChatMessages, responsesToolsToChatTools, chatToResponses } from "./converters.js";
import { streamChatToResponses } from "./streaming.js";
import { proxyLog } from "./debug.js";
import { logCollabToolsRequest, logCollabNonStreamResponse } from "./collab-debug.js";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

export async function handleResponsesRequest(
  req: IncomingMessage,
  res: ServerResponse,
) {
  const startedAt = Date.now();
  let body: Record<string, any>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
    return;
  }

  const authHeader = req.headers.authorization || "";
  const apiKey = KEY || authHeader.replace("Bearer ", "");
  if (KEY && authHeader) {
    proxyLog("[AUTH] Using configured API key (ignoring incoming Authorization header)");
  }

  const chatMessages = responsesInputToChatMessages(body);
  const { tools, toolNamespaces } = responsesToolsToChatTools(body.tools, FILTER_NON_FUNCTION_TOOLS);
  const requestedModel = body.model || "default";
  const stream = body.stream !== false;

  const activeUpstream = resolveModel(ACTIVE_MODEL) || ACTIVE_MODEL;
  let model = resolveModel(requestedModel);
  if (!model || model === requestedModel) {
    const available = AVAILABLE_MODELS.length > 0 ? AVAILABLE_MODELS : [ACTIVE_MODEL];
    const allUpstream = available.map(m => resolveModel(m) || m);
    if (!allUpstream.includes(requestedModel) && activeUpstream) {
      proxyLog(`[MODEL] Mapping unknown model "${requestedModel}" → "${activeUpstream}"`);
      model = activeUpstream;
    } else {
      model = requestedModel;
    }
  } else {
    proxyLog(`[ALIAS] "${requestedModel}" → "${model}"`);
  }

  const info = getModelInfo(model);
  const chatRequest: Record<string, unknown> = {
    model,
    messages: chatMessages,
    stream,
    stream_options: { include_usage: true },
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
  };

  // Set max_tokens to prevent upstream truncation (defaults are often 4096).
  // Known models: use models.dev max_output. Unknown models: cap at 16384 to
  // avoid sending unrealistic values that upstreams reject (e.g. 128K to Claude).
  const maxTokens = info?.max_output || Math.min(CONTEXT_WINDOW || 16384, 16384);
  (chatRequest as any).max_tokens = maxTokens;
  proxyLog(`[PROXY] max_tokens=${maxTokens} (known=${!!info?.max_output})`);

  proxyLog(
    `[PROXY] +0ms model=${model} msgs=${chatMessages.length} ` +
    `tools=${tools?.length || 0} stream=${stream}`,
  );
  const flatToolNames = tools?.map((t) => t.function?.name || t.name).filter(Boolean) as string[] || [];
  if (tools?.length) {
    proxyLog(`[TOOLS] ${flatToolNames.join(", ")}`);
  }
  logCollabToolsRequest(body.tools, toolNamespaces, flatToolNames);
  const ctxWindow = info?.context_window || CONTEXT_WINDOW || 200000;
  const compactAt = Math.floor(ctxWindow * 0.9);
  if (info) {
    proxyLog(
      `[MODEL] ${model}: context=${formatTokens(info.context_window)} ` +
      `output=${formatTokens(info.max_output)} compact_at=${formatTokens(compactAt)} ` +
      `reasoning=${info.reasoning} tool_call=${info.tool_call}`,
    );
  } else {
    proxyLog(`[MODEL] ${model}: unknown — using config context_window=${formatTokens(ctxWindow)} compact_at=${formatTokens(compactAt)}`);
  }

  const upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  const upstreamResp = await fetch(
    `${UPSTREAM.replace(/\/$/, "")}/chat/completions`,
    { method: "POST", headers: upstreamHeaders, body: JSON.stringify(chatRequest) },
  );

  proxyLog(`[PROXY] +${Date.now() - startedAt}ms upstream connected status=${upstreamResp.status}`);

  if (!upstreamResp.ok) {
    const errText = await upstreamResp.text();
    console.error(`[UPSTREAM ${upstreamResp.status}] ${errText.slice(0, 300)}`);
    res.writeHead(upstreamResp.status, { "Content-Type": "application/json" });
    res.end(errText);
    return;
  }

  if (!stream) {
    const chatResult = await upstreamResp.json();
    const resp = chatToResponses(chatResult, toolNamespaces);
    logCollabNonStreamResponse(chatResult, toolNamespaces, Date.now() - startedAt);
    updateSessionUsage(chatResult.usage, model);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(resp));
    return;
  }

  streamChatToResponses(upstreamResp, res, model, {
    isReasoning: info?.reasoning ?? false,
    startedAt,
    toolNamespaces,
  });
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
