/**
 * codex-anywhere — Streaming SSE Converter
 *
 * Converts upstream chat/completions SSE stream to Responses API events.
 */

import type { ServerResponse } from "http";
import { updateSessionUsage, sessionUsage } from "./session.js";
import { proxyLog, DEBUG } from "./debug.js";
import { logCollabFunctionCall, logCollabToolsSummary } from "./collab-debug.js";

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Validate that a string is parseable JSON. Returns the parsed object
 * or null if invalid. Used to verify tool call arguments integrity.
 */
function validateJSON(str: string): Record<string, any> | null {
  if (!str) return null;
  try {
    const parsed = JSON.parse(str);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Attempt to repair truncated JSON by closing unterminated strings and braces.
 * Returns the repaired string or the original if repair is not possible.
 */
function repairJSON(str: string): string {
  let s = str.trim();
  if (!s) return "{}";
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (!inString) {
      if (c === "{" || c === "[") {
        stack.push(c);
      } else if (c === "}" || c === "]") {
        const opener = c === "}" ? "{" : "[";
        if (stack[stack.length - 1] === opener) {
          stack.pop();
        }
      }
    }
  }
  if (inString) s += '"';
  while (stack.length > 0) {
    const opener = stack.pop();
    s += opener === "{" ? "}" : "]";
  }
  return s;
}

function normalizeToolArguments(name: string, args: string): string {
  if (validateJSON(args)) return args;
  const repaired = repairJSON(args);
  if (validateJSON(repaired)) {
    proxyLog(`[PROXY] Repaired tool arguments for ${name}: ${args.slice(0, 80)} -> ${repaired.slice(0, 80)}`);
    return repaired;
  }
  // Security: never log raw argument content in normal operation — may contain user data.
  if (DEBUG) {
    const redacted = args.length > 40 ? args.slice(0, 20) + "…" + args.slice(-20) : args;
    console.error(`[PROXY] Invalid tool arguments for ${name} (len=${args.length}): ${redacted}`);
  } else {
    console.error(`[PROXY] Invalid tool arguments for ${name} (len=${args.length})`);
  }
  return "{}";
}

interface ToolCallState {
  id: string;
  name: string;
  arguments: string;
  fcItemId: string;
  outputIndex: number;
  added: boolean;
  done: boolean;
}

export interface StreamOptions {
  /** Model supports reasoning — emit synthetic reasoning item while waiting */
  isReasoning?: boolean;
  /** Request start time (performance logging) */
  startedAt?: number;
  /** Flattened tool name → Responses API namespace (from namespace tool defs). */
  toolNamespaces?: Record<string, string>;
}

export function streamChatToResponses(
  upstreamResp: Response,
  res: ServerResponse,
  model: string,
  options: StreamOptions = {},
) {
  const startedAt = options.startedAt ?? Date.now();
  const isReasoning = options.isReasoning ?? false;
  const toolNamespaces = options.toolNamespaces ?? {};

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const respId = `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const itemId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const reasoningItemId = `rs_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

  // Send response.created immediately — don't wait for upstream first byte
  res.write(sse("response.created", {
    type: "response.created",
    response: { id: respId, object: "response", status: "in_progress", model, output: [] },
  }));
  proxyLog(`[PROXY] +${Date.now() - startedAt}ms response.created sent`);

  let nextOutputIndex = 0;
  let reasoningOpen = false;
  let reasoningClosed = false;
  let reasoningOutputIndex = -1;

  let sentItemAdded = false;
  let messageOutputIndex = -1;
  let textContent = "";
  let usage: Record<string, any> | null = null;
  const toolCalls = new Map<number, ToolCallState>();

  let firstByteLogged = false;

  function openReasoningItem() {
    if (!isReasoning || reasoningOpen || reasoningClosed) return;
    reasoningOpen = true;
    reasoningOutputIndex = nextOutputIndex++;
    res.write(sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: reasoningOutputIndex,
      item: {
        type: "reasoning",
        id: reasoningItemId,
        summary: [],
        status: "in_progress",
      },
    }));
    proxyLog(`[PROXY] +${Date.now() - startedAt}ms reasoning item opened`);
  }

  function closeReasoningItem() {
    if (!reasoningOpen || reasoningClosed) return;
    reasoningClosed = true;
    reasoningOpen = false;
    res.write(sse("response.output_item.done", {
      type: "response.output_item.done",
      output_index: reasoningOutputIndex,
      item: {
        type: "reasoning",
        id: reasoningItemId,
        summary: [{ type: "summary_text", text: "" }],
        status: "completed",
      },
    }));
  }

  // Reasoning items are opened on-demand when upstream sends reasoning_content.
  // No synthetic pre-open — avoid empty reasoning items when model produces no text.

  function ensureMessageItem() {
    closeReasoningItem();
    if (sentItemAdded) return;
    sentItemAdded = true;
    messageOutputIndex = nextOutputIndex++;
    res.write(sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: messageOutputIndex,
      item: { type: "message", id: itemId, role: "assistant", content: [], status: "in_progress" },
    }));
    res.write(sse("response.content_part.added", {
      type: "response.content_part.added",
      output_index: messageOutputIndex,
      content_index: 0,
      part: { type: "output_text", text: "" },
    }));
  }

  function getOrCreateTool(idx: number): ToolCallState {
    if (!toolCalls.has(idx)) {
      toolCalls.set(idx, {
        id: `call_${idx}`,
        name: "",
        arguments: "",
        fcItemId: `fc_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}_${idx}`,
        outputIndex: nextOutputIndex++,
        added: false,
        done: false,
      });
    }
    return toolCalls.get(idx)!;
  }

  function functionCallItem(state: ToolCallState, extra: Record<string, unknown> = {}) {
    const item: Record<string, unknown> = {
      type: "function_call",
      id: state.fcItemId,
      call_id: state.id,
      name: state.name,
      ...extra,
    };
    const namespace = toolNamespaces[state.name];
    if (namespace) item.namespace = namespace;
    return item;
  }

  function ensureToolAdded(state: ToolCallState) {
    if (state.added || !state.name) return;
    state.added = true;
    closeReasoningItem();
    res.write(sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: state.outputIndex,
      item: {
        ...functionCallItem(state, { arguments: "", status: "in_progress" }),
      },
    }));
    const elapsed = Date.now() - startedAt;
    proxyLog(`[PROXY] +${elapsed}ms tool added: ${state.name} idx=${state.outputIndex}`);
    logCollabFunctionCall({
      phase: "added",
      elapsedMs: elapsed,
      name: state.name,
      callId: state.id,
      fcItemId: state.fcItemId,
      outputIndex: state.outputIndex,
      namespace: toolNamespaces[state.name],
    });
  }

  function finalizeTool(state: ToolCallState) {
    if (state.done) return;
    if (!state.added && state.name) ensureToolAdded(state);
    if (!state.added) return;
    state.arguments = normalizeToolArguments(state.name, state.arguments);
    state.done = true;
    const item = functionCallItem(state, { arguments: state.arguments, status: "completed" });
    res.write(sse("response.output_item.done", {
      type: "response.output_item.done",
      output_index: state.outputIndex,
      item,
    }));
    const elapsed = Date.now() - startedAt;
    proxyLog(`[PROXY] +${elapsed}ms tool done: ${state.name}`);
    logCollabFunctionCall({
      phase: "done",
      elapsedMs: elapsed,
      name: state.name,
      callId: state.id,
      fcItemId: state.fcItemId,
      outputIndex: state.outputIndex,
      namespace: toolNamespaces[state.name],
      arguments: state.arguments,
    });
    if (DEBUG && state.name) {
      proxyLog(`[COLLAB]   output_item.done item: ${JSON.stringify(item)}`);
    }
  }

  function finalizeAllTools() {
    for (const state of toolCalls.values()) finalizeTool(state);
  }

  function sendCompletion() {
    closeReasoningItem();

    // Guarantee at least one message item in output.
    // Reasoning models may produce no visible text after thinking — without this,
    // response.completed would have an empty output, causing last_agent_message=null.
    // Base suppression on tools actually emitted/finalized, not toolCalls.size:
    // getOrCreateTool() can create unnamed states from truncated fragments that
    // finalize without output, and we must not let them suppress the fallback.
    const hasEmittedTool = [...toolCalls.values()].some((tc) => tc.added);
    if (!sentItemAdded && !hasEmittedTool) {
      ensureMessageItem();
    }

    if (sentItemAdded) {
      // Send response.output_text.done before closing the message item
      res.write(sse("response.output_text.done", {
        type: "response.output_text.done",
        output_index: messageOutputIndex,
        content_index: 0,
      }));
      res.write(sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: messageOutputIndex,
        item: {
          type: "message",
          id: itemId,
          role: "assistant",
          content: textContent ? [{ type: "output_text", text: textContent }] : [],
          status: "completed",
        },
      }));
    }

    finalizeAllTools();
    logCollabToolsSummary(
      Date.now() - startedAt,
      [...toolCalls.values()].map((t) => ({
        name: t.name,
        id: t.id,
        done: t.done,
        arguments: t.arguments,
      })),
      toolNamespaces,
    );
    updateSessionUsage(usage, model);

    const inputTokens = usage?.prompt_tokens || 0;
    const outputTokens = usage?.completion_tokens || 0;
    const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens || 0;
    const cachedTokens = usage?.prompt_tokens_details?.cached_tokens || 0;
    const totalTokens = usage?.total_tokens || 0;

    // Collect all emitted output items with their output_index, then sort by index
    // so the terminal response matches the emitted event sequence.
    const allOutputs: Array<{ index: number; item: Record<string, any> }> = [];

    if (sentItemAdded) {
      allOutputs.push({
        index: messageOutputIndex,
        item: {
          type: "message",
          id: itemId,
          role: "assistant",
          content: textContent ? [{ type: "output_text", text: textContent }] : [],
          status: "completed",
        },
      });
    }

    if (reasoningClosed) {
      allOutputs.push({
        index: reasoningOutputIndex,
        item: {
          type: "reasoning",
          id: reasoningItemId,
          summary: [{ type: "summary_text", text: "" }],
          status: "completed",
        },
      });
    }

    for (const tc of toolCalls.values()) {
      if (!tc.done) continue;
      allOutputs.push({
        index: tc.outputIndex,
        item: {
          ...functionCallItem(tc, { arguments: tc.arguments, status: "completed" }),
        },
      });
    }

    // Sort by output_index to preserve emission order
    allOutputs.sort((a, b) => a.index - b.index);

    res.write(sse("response.completed", {
      type: "response.completed",
      response: {
        id: respId,
        object: "response",
        status: "completed",
        model,
        output: allOutputs.map((o) => o.item),
        usage: {
          input_tokens: inputTokens,
          input_tokens_details: { cached_tokens: cachedTokens },
          output_tokens: outputTokens,
          output_tokens_details: { reasoning_tokens: reasoningTokens },
          total_tokens: totalTokens,
        },
      },
    }));

    proxyLog(
      `[PROXY] +${Date.now() - startedAt}ms completed | ` +
      `tokens in=${inputTokens} out=${outputTokens} tools=${toolCalls.size}`,
    );
    if (DEBUG) {
      console.log(
        `[PROXY] Session: input=${sessionUsage.totalInputTokens} ` +
        `output=${sessionUsage.totalOutputTokens} requests=${sessionUsage.requestCount}`,
      );
    }
  }

  const reader = upstreamResp.body!.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { sendCompletion(); res.end(); return; }

        if (!firstByteLogged) {
          firstByteLogged = true;
          proxyLog(`[PROXY] +${Date.now() - startedAt}ms first upstream byte`);
        }

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") { sendCompletion(); res.end(); return; }

          try {
            const parsed = JSON.parse(data);
            if (parsed.usage) usage = parsed.usage;
            const choice = parsed.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta || {};

            // Upstream reasoning content (DeepSeek reasoner, some OpenAI-compatible)
            if (delta.reasoning_content || delta.reasoning) {
              if (reasoningOutputIndex < 0) openReasoningItem();
              const rDelta = delta.reasoning_content || delta.reasoning || "";
              res.write(sse("response.reasoning_text.delta", {
                type: "response.reasoning_text.delta",
                output_index: reasoningOutputIndex,
                content_index: 0,
                delta: rDelta,
              }));
            }

            // Use strict check — empty string is valid content (e.g. Claude prefix chunk)
            if (delta.content !== undefined && delta.content !== null) {
              ensureMessageItem();
              textContent += delta.content;
              res.write(sse("response.output_text.delta", {
                type: "response.output_text.delta",
                output_index: messageOutputIndex,
                content_index: 0,
                delta: delta.content,
              }));
            }

            if (delta.tool_calls) {
              closeReasoningItem();
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const state = getOrCreateTool(idx);
                if (tc.id) state.id = tc.id;
                if (tc.function?.name) state.name = tc.function.name;
                // Strict check — arguments fragment may be empty string
                if (tc.function?.arguments !== undefined && tc.function?.arguments !== null) {
                  state.arguments += tc.function.arguments;
                }
                ensureToolAdded(state);
              }
            }

            if (choice.finish_reason === "tool_calls") {
              finalizeAllTools();
            }
          } catch (err) {
            // Log malformed chunks for debugging
            if (DEBUG) {
              console.error(`[STREAM] Malformed chunk: ${data.slice(0, 200)}`, err);
            }
          }
        }
      }
    } catch (err) {
      console.error("[STREAM ERROR]", err);
      sendCompletion();
      res.end();
    }
  })();
}
