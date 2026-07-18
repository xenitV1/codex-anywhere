/**
 * codex-anywhere — Bohrium Compatibility Tests
 *
 * Tests for Bohrium-specific streaming tool-calling behavior:
 * - Multi-turn tool call + final answer (R1: tool call, R2: tool result + answer)
 * - Tool arguments JSON validity via the streaming converter
 * - response.completed includes assistant message in all scenarios
 * - Covers cds/GPT-5.4 and cds/Claude-4.6-opus model families
 */

import { streamChatToResponses } from "../src/streaming.js";

// Inline test helpers (self-contained, no import from tests/helpers)
const UPSTREAM = process.env.BOHRIUM_UPSTREAM || "https://open.bohrium.com/openapi/v1";
const KEY = process.env.BOHRIUM_KEY || "";

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`    ✓ ${msg}`);
    passed++;
  } else {
    console.error(`    ✗ ${msg}`);
    failed++;
  }
}

function skipTest(msg: string) {
  console.log(`    ⊘ ${msg}`);
  skipped++;
}

function collectStream(
  upstreamResp: Response,
  model: string,
  options: { isReasoning?: boolean; toolNamespaces?: Record<string, string> } = {},
): Promise<any[]> {
  return new Promise((resolve) => {
    const events: any[] = [];
    const fakeRes = {
      writeHead: () => {},
      end: () => {},
      write: (chunk: string) => {
        for (const ln of chunk.split("\n")) {
          if (ln.startsWith("data: ")) {
            try { events.push(JSON.parse(ln.slice(6))); } catch {}
          }
        }
      },
    };
    streamChatToResponses(upstreamResp, fakeRes as any, model, {
      isReasoning: options.isReasoning ?? false,
      startedAt: Date.now(),
      toolNamespaces: options.toolNamespaces ?? {},
    });

    const maxWait = 20000;
    const start = Date.now();
    const check = setInterval(() => {
      const completed = events.find((e) => e.type === "response.completed");
      if (completed || Date.now() - start > maxWait) {
        clearInterval(check);
        resolve(events);
      }
    }, 100);
  });
}

async function fetchUpstream(model: string, body: Record<string, any>): Promise<Response> {
  return fetch(`${UPSTREAM}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(body),
  });
}

export async function run() {
  if (!KEY) {
    skipTest("No BOHRIUM_KEY — skipping Bohrium compat tests");
    return;
  }

  console.log(`Bohrium upstream: ${UPSTREAM}`);
  const models = ["cds/GPT-5.4", "cds/Claude-4.6-opus"];

  for (const model of models) {
    console.log(`\n─── ${model} ───`);

    // ── Test 1: Single-turn tool call ──
    console.log(`  Test 1: Single-turn tool call`);

    const r1 = await fetchUpstream(model, {
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "What is 15*37? Use the calculate tool to compute it." }],
      tools: [{
        type: "function",
        function: {
          name: "calculate",
          description: "Compute a math expression",
          parameters: {
            type: "object",
            properties: { expression: { type: "string", description: "Math expression" } },
            required: ["expression"],
          },
        },
      }],
    });
    assert(r1.ok, `R1 upstream OK (status ${r1.status})`);

    if (!r1.ok) {
      console.log(`    Skipping remaining tests for ${model} (upstream error)`);
      continue;
    }

    const events1 = await collectStream(r1, model);

    const comp1 = events1.find((e) => e.type === "response.completed");
    assert(!!comp1, "Has response.completed event");

    const fc = comp1?.response?.output?.find((o: any) => o.type === "function_call");
    assert(!!fc, "Has function_call in output");

    if (fc) {
      assert(fc.name === "calculate", "Tool name is 'calculate'");
      try {
        JSON.parse(fc.arguments);
        console.log(`    ✓ Tool arguments are valid JSON: ${fc.arguments.slice(0, 80)}`);
      } catch {
        console.log(`    ✗ Tool arguments INVALID JSON: ${fc.arguments.slice(0, 100)}`);
      }
    }

    if (!fc) {
      console.log(`    Skipping multi-turn tests — no function_call`);
      continue;
    }

    // ── Test 2: Multi-turn (tool result → final answer) ──
    console.log(`  Test 2: Multi-turn (tool result → final answer)`);

    const r2 = await fetchUpstream(model, {
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "user", content: "What is 15*37? Use the calculate tool to compute it." },
        { role: "assistant", content: "", tool_calls: [{ id: fc.call_id, type: "function", function: { name: fc.name, arguments: fc.arguments } }] },
        { role: "tool", content: "555", tool_call_id: fc.call_id },
      ],
    });
    assert(r2.ok, `R2 upstream OK (status ${r2.status})`);

    if (r2.ok) {
      const events2 = await collectStream(r2, model);

      const comp2 = events2.find((e) => e.type === "response.completed");
      assert(!!comp2, "R2 has response.completed event");

      const output = comp2?.response?.output || [];
      const hasMsg = output.some((o: any) => o.type === "message");
      assert(hasMsg, "R2 has assistant message (last_agent_message check)");

      if (hasMsg) {
        const msgItem = output.find((o: any) => o.type === "message");
        const text = msgItem?.content?.[0]?.text || "";
        console.log(`    ✓ Final answer: "${text.slice(0, 80)}"`);
        assert(text.length > 0, "R2 final answer is not empty");
      } else {
        console.log(`    ✗ CRITICAL: response.completed has NO assistant message`);
      }

      // Verify event ordering
      const allTypes = events2.map((e) => e.type);
      const createdIdx = allTypes.indexOf("response.created");
      const completedIdx = allTypes.indexOf("response.completed");
      assert(createdIdx >= 0, "Has response.created event");
      assert(completedIdx >= 0, "Has response.completed event");
      assert(createdIdx < completedIdx, "response.created before response.completed");
    }
  }

  console.log(`\n─── Summary ───`);
  console.log(`  Passed: ${passed}, Failed: ${failed}, Skipped: ${skipped}`);
}
