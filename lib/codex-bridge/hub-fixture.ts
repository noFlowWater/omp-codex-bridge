// TEST-ONLY orchestrator for a real-OMP Agent Hub smoke of the codex-bridge task agent. Load it only
// through hub-fixture.sh (or an explicit `-e`); it is not in extensions/ and never auto-loads.
//
// It is an official command-backed provider that runs no model: on the first request that offers the
// `task` tool it emits exactly one real `task` tool call spawning the `codex-bridge` agent, and answers
// every other request with fixed text. OMP then runs the real task tool, registry, Agent Hub and RPC
// subagent paths, while the child runs the production codex-bridge provider against the fake app-server
// selected by PATH/CODEX_HOME. The zero costs and window sizes below are fixture values, not real
// model metadata.
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync } from "node:fs";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export default function (pi: ExtensionAPI) {
  pi.registerCommand("codex-fixture-reload", {
    description: "TEST-ONLY: exercise the official session reload API without model inference.",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await ctx.reload();
      pi.appendEntry("codex-hub-fixture-reloaded", { sessionId: ctx.sessionManager.getSessionId() });
    },
  });
  pi.registerProvider("codex-hub-fixture", {
    baseUrl: "https://codex-hub-fixture.invalid/",
    apiKey: "codex-hub-fixture-no-key",
    api: "codex-hub-fixture-api",
    streamSimple(model, context, options) {
      if (process.env.CODEX_HUB_FIXTURE_DISPATCH) appendFileSync(process.env.CODEX_HUB_FIXTURE_DISPATCH, `${JSON.stringify({ sessionId: options?.sessionId, model: model.id })}\n`);
      const stream = new AssistantMessageEventStream();
      // CODEX_HUB_FIXTURE_DIRECT_SANDBOX: instead of the task call, one direct `codex_bridge` run carrying the
      // removed `sandbox` argument with that value; the real OMP tool path must refuse it (SANDBOX_REMOVED).
      const retiredSandbox = process.env.CODEX_HUB_FIXTURE_DIRECT_SANDBOX;
      const directArgs = process.env.CODEX_HUB_FIXTURE_DIRECT_JSON ? JSON.parse(process.env.CODEX_HUB_FIXTURE_DIRECT_JSON) : undefined;
      const direct = Boolean(retiredSandbox || directArgs);
      const tool = direct ? "codex_bridge" : "task";
      // One call per session: once any tool result exists, the parent only answers with text.
      const spawn = Boolean(context.tools?.some(entry => entry.name === tool))
        && !context.messages.some(message => message.role === "toolResult");
      const call = {
        type: "toolCall" as const,
        id: `codex-hub-fixture-${tool}`,
        name: tool,
        arguments: direct ? directArgs ?? { action: "run", prompt: "fixture: removed sandbox argument must be refused", sandbox: retiredSandbox } : {
          // hub-smoke.mjs passes a rich context (markdown, code, quoted headings) to check it reaches Codex whole.
          context: process.env.CODEX_HUB_FIXTURE_CONTEXT || "Codex bridge Hub fixture (test-only; fake app-server, no model inference).",
          tasks: [{
            name: "CodexChild",
            agent: "codex-bridge",
            task: "Inspect the current directory without edits and report what you find.",
            solutionSpace: "fixture: fixed inspection",
            ...(process.env.CODEX_HUB_FIXTURE_SCHEMA ? { outputSchema: JSON.parse(process.env.CODEX_HUB_FIXTURE_SCHEMA), schemaMode: "strict" } : {}),
            ...(process.env.CODEX_HUB_FIXTURE_EFFORT ? { effort: process.env.CODEX_HUB_FIXTURE_EFFORT } : {}),
            // CODEX_HUB_FIXTURE_MODEL: an exact per-call selector (hub-fixture.sh enables the gate for it).
            ...(process.env.CODEX_HUB_FIXTURE_MODEL ? { model: process.env.CODEX_HUB_FIXTURE_MODEL } : {}),
          }],
        },
      };
      const text = { type: "text" as const, text: "codex-hub-fixture parent reply (test-only, no model inference)." };
      const message = {
        role: "assistant" as const,
        content: [spawn ? call : text],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
        stopReason: spawn ? ("toolUse" as const) : ("stop" as const),
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (spawn) {
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
          stream.push({ type: "done", reason: "toolUse", message });
        } else {
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: message });
          stream.push({ type: "done", reason: "stop", message });
        }
      });
      return stream;
    },
    models: [{
      id: "orchestrator",
      name: "Codex Hub fixture orchestrator (TEST-ONLY, no inference)",
      reasoning: false,
      input: ["text"],
      cost: zero,
      contextWindow: 128000,
      maxTokens: 4096,
    }],
  });
}
