/**
 * codex-anywhere — API Format Converters
 *
 * Converts between OpenAI Responses API and Chat Completions API formats.
 */

/**
 * Force a value to be a string. Handles arrays, objects, null, undefined.
 */
function forceString(val: unknown): string {
  if (typeof val === "string") return val;
  if (val == null) return "";
  if (Array.isArray(val)) return JSON.stringify(val);
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

/**
 * Validate that a string is parseable JSON. Returns the parsed object
 * or null if invalid. Used to verify tool call arguments integrity.
 */
function validateArgsJSON(str: string): Record<string, any> | null {
  if (!str) return null;
  try {
    const parsed = JSON.parse(str);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function responsesInputToChatMessages(body: Record<string, any>): any[] {
  const messages: any[] = [];
  if (body.instructions) {
    messages.push({ role: "system", content: forceString(body.instructions) });
  }
  for (const item of body.input || []) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
    } else if (item.type === "message") {
      const role = item.role === "developer" ? "system" : item.role;
      const parts: string[] = [];
      const images: string[] = [];
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === "input_text" || c.type === "output_text" || c.type === "text") {
            parts.push(c.text || "");
          } else if (c.type === "input_image") {
            images.push("(image)");
          } else if (c.type === "input_file") {
            parts.push(`[file: ${c.filename || c.name || "unknown"}]`);
          } else if (c.type === "refusal") {
            parts.push(c.refusal || "(refused)");
          } else if (c.text) {
            parts.push(c.text);
          }
        }
      } else if (typeof item.content === "string") {
        parts.push(item.content);
      }
      if (images.length > 0) {
        parts.push(
          `[User attached ${images.length} image(s). ` +
          `You cannot view images. ` +
          `If a vision/image analysis tool is available, use it to analyze the image. ` +
          `Otherwise, tell the user you cannot analyze images and continue with the next task.]`,
        );
      }
      const content = parts.join("");
      // If the previous message is an assistant (e.g., created by a preceding
      // function_call that was converted to an assistant message with tool_calls),
      // merge content into it instead of creating a consecutive assistant message.
      // Consecutive assistant messages are invalid in Chat Completions API and
      // cause upstream providers to silently drop or mishandle the response.
      if (content && role === "assistant" && messages.length > 0) {
        const prev = messages[messages.length - 1];
        if (prev.role === "assistant") {
          prev.content = prev.content ? prev.content + content : content;
        } else {
          messages.push({ role, content });
        }
      } else if (content) {
        messages.push({ role, content });
      }
    } else if (item.type === "function_call") {
      // Validate and sanitize arguments — reject malformed JSON
      let fcArgs = item.arguments || "{}";
      if (!validateArgsJSON(fcArgs)) {
        fcArgs = "{}";
      }
      const newToolCall = {
        id: item.call_id || item.id,
        type: "function" as const,
        function: { name: item.name, arguments: fcArgs },
      };
      // Merge into previous assistant message if possible (avoids consecutive assistant messages)
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        if (!lastMsg.tool_calls) lastMsg.tool_calls = [];
        lastMsg.tool_calls.push(newToolCall);
      } else {
        messages.push({
          role: "assistant",
          content: "",
          tool_calls: [newToolCall],
        });
      }
    } else if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        content: forceString(item.output),
        tool_call_id: item.call_id,
      });
    }
  }
  if (messages.length === 0) messages.push({ role: "user", content: "Hello." });
  return messages;
}

/**
 * Convert Responses API tools to chat/completions function tools.
 *
 * Handles:
 * - "function" type → standard function tool
 * - "custom" / freeform (e.g. apply_patch) → function tool with string parameter
 * - "namespace" (MCP grouped tools) → flattened to individual function tools
 * - "web_search", "image_generation", "local_shell", "tool_search" → filtered out
 *   (these are OpenAI Responses API built-ins with no chat/completions equivalent)
 */
/**
 * Tool names that are handled client-side by Codex CLI.
 * For these tools, we strip the "model" parameter from the tool definition
 * because Codex tries to validate the model against its available_models list
 * (which is empty for non-OpenAI providers). Without a model param,
 * Codex inherits the parent model automatically.
 */
const CODEX_AGENT_TOOLS = new Set([
  "spawn_agent",
]);

/**
 * Tool names that Codex manages locally and should have their
 * output_schema stripped to avoid confusing non-OpenAI providers.
 */
const CODEX_LOCAL_TOOLS = new Set([
  "spawn_agent",
  "send_input",
  "send_message",
  "followup_task",
  "wait_agent",
  "close_agent",
  "resume_agent",
  "list_agents",
]);

export interface ChatToolsConversion {
  tools: any[] | undefined;
  /** Maps flattened tool name → Responses API namespace (e.g. spawn_agent → multi_agent_v1). */
  toolNamespaces: Record<string, string>;
}

export function responsesToolsToChatTools(
  tools: any[] | undefined,
  filterNonFunction: boolean,
): ChatToolsConversion {
  const toolNamespaces: Record<string, string> = {};
  if (!tools || tools.length === 0) {
    return { tools: undefined, toolNamespaces };
  }

  const result: any[] = [];

  for (const t of tools) {
    const type = t.type || "function";

    // Standard function tool — pass through
    if (type === "function") {
      const fnDef: any = {
        name: t.name,
        description: t.description,
        parameters: t.parameters ? JSON.parse(JSON.stringify(t.parameters)) : undefined,
      };

      // Strip "model" parameter from Codex agent tools so they inherit
      // the parent model instead of sending an unknown model name.
      if (CODEX_AGENT_TOOLS.has(t.name) && fnDef.parameters?.properties) {
        delete fnDef.parameters.properties.model;
        if (fnDef.parameters.required) {
          fnDef.parameters.required = fnDef.parameters.required.filter((r: string) => r !== "model");
        }
      }

      // Strip output_schema from Codex-local agent tools — non-OpenAI providers reject it.
      if (CODEX_LOCAL_TOOLS.has(t.name)) {
        delete fnDef.output_schema;
      }

      result.push({
        type: "function",
        function: fnDef,
      });
      continue;
    }

    // Freeform/custom tool (apply_patch) → convert to function with string input
    if (type === "custom") {
      result.push({
        type: "function",
        function: {
          name: t.name || "custom_tool",
          description: t.description || "Custom tool",
          parameters: {
            type: "object",
            properties: {
              input: { type: "string", description: "Tool input" },
            },
            required: ["input"],
          },
        },
      });
      continue;
    }

    // Namespace tool (MCP, multi_agent_v1, etc.) → flatten for chat/completions but
    // remember namespace so function_call items can be round-tripped to Codex.
    if (type === "namespace" && Array.isArray(t.tools)) {
      const namespace = t.name;
      for (const subTool of t.tools) {
        if (subTool.type === "function" || !subTool.type) {
          const subName = subTool.name;
          if (namespace && subName) {
            toolNamespaces[subName] = namespace;
          }
          result.push({
            type: "function",
            function: {
              name: subName,
              description: subTool.description || t.description || "",
              parameters: subTool.parameters || { type: "object", properties: {} },
            },
          });
        }
      }
      continue;
    }

    // Non-function types that can't be translated: web_search, image_generation,
    // local_shell, tool_search — filter out when filterNonFunction is true
    if (!filterNonFunction) {
      // If filtering is disabled, try to pass as-is (will likely be ignored by upstream)
      result.push({
        type: "function",
        function: {
          name: t.name || type,
          description: t.description || `${type} tool`,
          parameters: t.parameters || { type: "object", properties: {} },
        },
      });
    }
    // When filterNonFunction is true (default), these are silently dropped
  }

  return {
    tools: result.length > 0 ? result : undefined,
    toolNamespaces,
  };
}

export function chatToResponses(
  chatResult: Record<string, any>,
  toolNamespaces: Record<string, string> = {},
): Record<string, any> {
  const msg = chatResult.choices?.[0]?.message;
  const output: any[] = [];
  if (msg?.content) {
    output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: msg.content }] });
  }
  if (msg?.tool_calls) {
    for (const tc of msg.tool_calls) {
      const name = tc.function.name;
      // Validate arguments — fall back to "{}" if malformed
      let ctrArgs = tc.function.arguments;
      if (!validateArgsJSON(ctrArgs)) {
        ctrArgs = "{}";
      }
      const item: Record<string, any> = {
        type: "function_call",
        id: tc.id,
        call_id: tc.id,
        name,
        arguments: ctrArgs,
      };
      const namespace = toolNamespaces[name];
      if (namespace) item.namespace = namespace;
      output.push(item);
    }
  }
  const inputTokens = chatResult.usage?.prompt_tokens || 0;
  const outputTokens = chatResult.usage?.completion_tokens || 0;
  const reasoningTokens = chatResult.usage?.completion_tokens_details?.reasoning_tokens || 0;
  const cachedTokens = chatResult.usage?.prompt_tokens_details?.cached_tokens || 0;
  return {
    id: chatResult.id || "resp-" + Date.now(),
    object: "response",
    status: "completed",
    output,
    model: chatResult.model,
    usage: {
      input_tokens_details: { cached_tokens: cachedTokens },
      output_tokens: outputTokens,
      input_tokens: inputTokens,
      output_tokens_details: { reasoning_tokens: reasoningTokens },
      total_tokens: chatResult.usage?.total_tokens || 0,
    },
  };
}
