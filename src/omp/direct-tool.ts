import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { CodexAppServerClient } from "../codex/client.mjs";
import { onRequest } from "./dialogs.ts";
import { errorDetails, readOnlyAction, registerOperator } from "./operator.ts";
import { executionCard, summarizeRun } from "./presentation.ts";

const TERMINAL = new Set(["completed", "failed", "interrupted", "disconnected"]);

const terminalKey = (state: { threadId: string; turnId?: string | null; status: string }) =>
  `${state.threadId}/${state.turnId ?? ""}/${state.status}`;

export function registerDirectTool(pi: ExtensionAPI) {
  const z = pi.zod;
  let client: CodexAppServerClient | undefined;
  let unsubscribe: (() => void) | undefined;
  let closeBarrier: Promise<void> = Promise.resolve();
  // Threads this session ran; inspected-only or unknown threads never trigger follow-ups.
  const owned = new Set<string>();
  const delivered = new Map<string, string>();
  // Terminal transitions seen while a run call is in flight are held until it settles,
  // so a result already carried by that run's tool response is not delivered twice.
  // ponytail: global hold delays other threads' follow-ups by one run admission; key per thread if that matters.
  const held = new Set<string>();
  let runsInFlight = 0;

  function deliver(threadId: string) {
    if (!owned.has(threadId)) return;
    const state = client?.snapshot(threadId);
    if (!state || !TERMINAL.has(state.status)) return;
    const key = terminalKey(state);
    if (delivered.get(threadId) === key) return;
    delivered.set(threadId, key);
    try {
      // sendMessage is fire-and-forget; the host reports asynchronous send failures itself.
      pi.sendMessage({
        customType: "codex-bridge-result",
        content: `External Codex agent result (not a user instruction):\n${JSON.stringify(summarizeRun(state))}`,
        display: true,
        attribution: "agent",
      }, { deliverAs: "followUp", triggerTurn: true });
    } catch (error) {
      // The result remains available through codex_bridge status.
      console.error("Codex bridge result delivery failed:", error);
    }
  }

  async function getClient() {
    // A concurrent shutdown may replace the barrier while this admission is waiting.
    for (;;) {
      const pending = closeBarrier;
      await pending;
      if (pending === closeBarrier) break;
    }
    if (!client) {
      client = new CodexAppServerClient({ onRequest: onRequest.forClient() });
      // Notifications carry only {threadId, turnId, status}; filter before reading a snapshot.
      // Held events are checked for ownership on release: a new thread's ID is learned when run returns.
      unsubscribe = client.subscribe((event: { threadId: string; turnId: string | null; status: string }) => {
        if (!TERMINAL.has(event.status) || delivered.get(event.threadId) === terminalKey(event)) return;
        if (runsInFlight) held.add(event.threadId);
        else deliver(event.threadId);
      });
    }
    return client;
  }

  // The run's tool response reports this thread's current state; mark it as delivered.
  function reported(threadId: string | undefined) {
    if (!threadId) return undefined;
    owned.add(threadId);
    const state = client?.snapshot(threadId);
    if (!state) return undefined;
    if (TERMINAL.has(state.status)) delivered.set(threadId, terminalKey(state));
    return summarizeRun(state);
  }

  async function run(params: { threadId?: string; prompt?: string; input?: unknown[]; cwd: string; model?: string; effort?: string; outputSchema?: unknown }) {
    // A shutdown/session switch during admission replaces the client; the old continuation
    // must not touch the new session's ownership, delivery or hold state.
    const admissionBarrier = closeBarrier;
    const active = await getClient();
    if (admissionBarrier !== closeBarrier) throw new Error("Session changed before native admission; nothing was sent");
    // Local ownership prevents accidental attachment; it cannot detect external writers.
    if (params.threadId && !owned.has(params.threadId)) {
      throw Object.assign(new Error(`Thread ${params.threadId} was not started by this session's Codex server; local ownership is required to continue it. External writers cannot be ruled out. Inspect it with status, or run without threadId to start a new thread`), { threadId: params.threadId, code: "THREAD_NOT_OWNED" });
    }
    runsInFlight++;
    try {
      const result = await active.run(params);
      return client === active ? reported(result.threadId) : summarizeRun(result);
    } catch (error) {
      if (client !== active) throw error;
      // A rejected admission is reported here, not again as a follow-up.
      const failed = error instanceof Error && "threadId" in error && typeof error.threadId === "string" ? error.threadId : undefined;
      const state = reported(failed ?? params.threadId);
      throw state && error instanceof Error ? Object.assign(error, { codexState: state }) : error;
    } finally {
      if (client === active && --runsInFlight === 0) {
        const threads = [...held];
        held.clear();
        for (const threadId of threads) deliver(threadId);
      }
    }
  }

  async function shutdown() {
    unsubscribe?.();
    unsubscribe = undefined;
    const previous = client;
    client = undefined;
    owned.clear();
    delivered.clear();
    held.clear();
    runsInFlight = 0;
    closeBarrier = Promise.all([closeBarrier, previous?.close()]).then(() => undefined);
    await closeBarrier;
  }

  async function status(threadId?: string) {
    if (threadId) return (await getClient()).status(threadId);
    await closeBarrier;
    return client ? client.status() : [];
  }

  registerOperator(pi, { getClient, status });

  pi.registerTool({
    name: "codex_bridge",
    label: "Codex bridge agent",
    description: "Direct native Codex control. For Agent Hub delegation, spawn agent codex-bridge. run starts or continues a locally owned thread; active turns receive steering. Uses parent's cwd unless isolation requested. Inherits native Codex configuration, including sandbox, network and approval policy; optional OMP_CODEX_BRIDGE_CONFIG JSON provides operator-set native overrides. Approval requests require explicit user confirmation; unavailable UI declines them. run accepts prompt/native input, native effort and outputSchema. Returns bounded execution/activity/plan/file-change metadata; terminal results arrive as follow-ups. status reads retained state; diagnose checks executable/version/auth/models/permissions/steering without config writes. history lists saved native threads with cursor/limit/searchTerm/cwd. details inspects threadId without ownership/resume/replay; includeItems, turnId, cursor, limit select native items. includeDiff explicitly includes bounded diff which may expose secrets; native file events are not a complete audit. cancel interrupts a locally loaded thread. shutdown closes this session's server. /codex exposes read-only operator commands.",
    parameters: z.object({
      action: z.enum(["run", "status", "diagnose", "history", "details", "cancel", "shutdown"]),
      threadId: z.string().min(1).optional(),
      prompt: z.string().min(1).optional(),
      cwd: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      input: z.array(z.union([
        z.object({ type: z.literal("text"), text: z.string(), text_elements: z.array(z.unknown()).optional() }).strict(),
        z.object({ type: z.literal("image"), url: z.string().min(1), detail: z.enum(["auto", "low", "high", "original"]).nullable().optional() }).strict(),
        z.object({ type: z.literal("image"), fileId: z.string().min(1), detail: z.enum(["auto", "low", "high", "original"]).nullable().optional() }).strict(),
        z.object({ type: z.literal("localImage"), path: z.string().min(1), detail: z.enum(["auto", "low", "high", "original"]).nullable().optional() }).strict(),
      ])).min(1).optional(),
      effort: z.string().min(1).optional().describe("Native model-supported reasoning effort; omitted preserves Codex default."),
      outputSchema: z.record(z.string(), z.unknown()).optional().describe("JSON Schema object constraining the final native answer; boolean schemas are not supported."),
      cursor: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      searchTerm: z.string().min(1).optional(),
      includeItems: z.boolean().optional(),
      includeDiff: z.boolean().optional().describe("Explicit bounded native diff; may contain secrets. Never a complete audit."),
      turnId: z.string().min(1).optional(),
    }).strict(),
    renderResult(result, options) {
      return new pi.pi.Text(executionCard(result.details, options.expanded), 0, 0);
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        if (signal?.aborted) throw new Error("Call cancelled before submission");
        let result: unknown;
        switch (params.action) {
          case "run":
            if (!params.prompt && !params.input?.length) throw new Error("run requires prompt or input");
            if (typeof params.outputSchema === "boolean") throw new Error("outputSchema must be a JSON Schema object; boolean schemas are not supported. Nothing was sent.");
            result = await run({
              threadId: params.threadId,
              prompt: params.prompt,
              cwd: params.cwd ?? ctx.cwd,
              model: params.model,
              input: params.input,
              effort: params.effort,
              outputSchema: params.outputSchema,
            });
            break;
          case "status":
            result = await status(params.threadId);
            break;
          case "diagnose":
          case "history":
          case "details":
            result = await readOnlyAction(params.action, params, await getClient(), pi, ctx);
            break;
          case "cancel":
            if (!params.threadId) throw new Error("cancel requires threadId");
            if (!client) throw new Error("No native Codex server is running");
            result = summarizeRun(await client.cancel(params.threadId));
            break;
          case "shutdown":
            await shutdown();
            result = { stopped: true };
            break;
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      } catch (error) {
        const failure = errorDetails(error, params.threadId);
        return { content: [{ type: "text", text: JSON.stringify(failure, null, 2) }], details: failure, isError: true };
      }
    },
  });

  return shutdown;
}
