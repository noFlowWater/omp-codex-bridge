import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { CustomMessageComponent } from "@oh-my-pi/pi-tui/chat/custom-message";
import { CodexAppServerClient } from "../codex/client.mjs";
import { TERMINAL as NATIVE_TERMINAL } from "../codex/protocol.mjs";
import { onRequest } from "./dialogs.ts";
import { errorDetails, readOnlyAction, registerOperator } from "./operator.ts";
import { operatorContent, summarizeRun } from "./presentation.ts";

const TERMINAL = new Set(["completed", "failed", "interrupted", "disconnected"]);

const terminalKey = (state: { threadId: string; turnId?: string | null; status: string }) =>
  `${state.threadId}/${state.turnId ?? ""}/${state.status}`;

export function registerDirectTool(pi: ExtensionAPI, options: { onRateLimits?: (params: unknown) => void } = {}) {
  const z = pi.zod;
  let client: CodexAppServerClient | undefined;
  let unsubscribe: (() => void) | undefined;
  let closeBarrier: Promise<void> = Promise.resolve();
  // Threads this session ran or explicitly forked; inspection never grants ownership.
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
      client = new CodexAppServerClient({
        onRequest: onRequest.forClient(),
        onNotification(method: string, params: unknown) {
          if (method === "account/rateLimits/updated") options.onRateLimits?.(params);
        },
      });
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

  async function nameThread(active: CodexAppServerClient, threadId: string, name?: string) {
    if (name === undefined || client !== active) return undefined;
    try { await active.setThreadName(threadId, name); }
    catch (error) { return String(error instanceof Error ? error.message : error).slice(0, 300); }
    return undefined;
  }

  async function waitForTerminal(active: CodexAppServerClient, threadId: string, signal?: AbortSignal) {
    if (TERMINAL.has(active.snapshot(threadId)?.status)) return;
    await new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const cancelled = () => Object.assign(new Error("Call cancelled while waiting for native completion; inspect status before continuing."), { name: "AbortError", code: "ABORT_ERR", threadId });
      const finish = (error?: unknown) => {
        unsubscribe();
        signal?.removeEventListener("abort", abort);
        if (error === undefined) resolve(); else reject(error);
      };
      const check = () => { if (TERMINAL.has(active.snapshot(threadId)?.status)) finish(signal?.aborted ? cancelled() : undefined); };
      const abort = () => {
        void active.cancel(threadId).then(
          () => finish(cancelled()),
          error => finish(Object.assign(error, { threadId })),
        );
      };
      unsubscribe = active.subscribe(event => { if (event.threadId === threadId) check(); });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else check();
    });
  }

  async function run(params: { threadId?: string; prompt?: string; input?: unknown[]; cwd: string; model?: string; effort?: string; outputSchema?: unknown; name?: string; serviceTier?: string }, signal?: AbortSignal, waitForCompletion = false) {
    // A shutdown/session switch during admission replaces the client; the old continuation
    // must not touch the new session's ownership, delivery or hold state.
    const admissionBarrier = closeBarrier;
    const active = await getClient();
    if (admissionBarrier !== closeBarrier) throw new Error("Session changed before native admission; nothing was sent");
    // Local ownership prevents accidental attachment; it cannot detect external writers.
    if (params.threadId && !owned.has(params.threadId)) {
      throw Object.assign(new Error(`Thread ${params.threadId} was not started by this session's Codex server; local ownership is required to continue it. External writers cannot be ruled out. Inspect it with status. To preserve saved context through a finished turn, fork this thread and run the returned continuation arguments; or run without threadId to start a new thread`), { threadId: params.threadId, code: "THREAD_NOT_OWNED" });
    }
    runsInFlight++;
    try {
      const { name, ...native } = params;
      let result = await active.run({ ...native, signal });
      const nameWarning = await nameThread(active, result.threadId, name);
      if (waitForCompletion) {
        await waitForTerminal(active, result.threadId, signal);
        result = active.snapshot(result.threadId) ?? result;
      }
      return { ...(client === active ? reported(result.threadId) : summarizeRun(result)), ...(nameWarning ? { nameWarning } : {}) };
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

  async function fork(params: { threadId: string; lastTurnId?: string; name?: string }) {
    const admissionBarrier = closeBarrier;
    const active = await getClient();
    if (admissionBarrier !== closeBarrier) throw new Error("Session changed before native admission; nothing was sent");
    // Read only: freeze a finished source boundary without adopting or resuming the source.
    let cursor: string | undefined;
    const cursors = new Set<string>();
    let sourceCwd: string | undefined;
    let boundary: string | undefined;
    for (;;) {
      const source = await active.getThreadDetails(params.threadId, { limit: 100, cursor });
      sourceCwd = source.thread.cwd;
      if (typeof sourceCwd !== "string" || !sourceCwd) throw new Error("Source history did not report cwd; no fork was sent");
      const turn = source.turns.data.find(turn => params.lastTurnId ? turn.id === params.lastTurnId : NATIVE_TERMINAL.has(turn.status));
      if (turn) {
        if (!NATIVE_TERMINAL.has(turn.status)) throw new Error("Fork boundary must be a finished turn");
        boundary = turn.id;
        break;
      }
      const next = source.turns.nextCursor;
      if (!next) throw new Error(params.lastTurnId ? "Finished fork boundary was not found in source history" : "Source has no finished turn boundary to fork");
      if (cursors.has(next)) throw new Error("Native history returned a repeated cursor");
      cursors.add(next);
      cursor = next;
    }
    if (client !== active || admissionBarrier !== closeBarrier) throw new Error("Session changed before native admission; nothing was sent");
    const result = await active.fork({
      threadId: params.threadId, lastTurnId: boundary, cwd: sourceCwd,
      onThread: (threadId: string) => {
        if (client === active) owned.add(threadId);
      },
    });
    const nameWarning = await nameThread(active, result.threadId, params.name);
    return {
      forked: true, threadId: result.threadId, cwd: result.cwd,
      sourceThreadId: params.threadId, lastTurnId: boundary, inferenceStarted: false,
      ...(nameWarning ? { nameWarning } : {}),
      scope: "Direct-tool thread only; not an Agent Hub worker. Original thread unchanged.",
      continuation: { tool: "codex_bridge", action: "run", threadId: result.threadId, cwd: result.cwd },
    };
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

  registerOperator(pi, { getClient, status, fork });
  pi.registerMessageRenderer("codex-bridge-result", (message, options) => {
    if (options.expanded || typeof message.content !== "string") return undefined;
    const result = JSON.parse(message.content.slice(message.content.indexOf("\n") + 1));
    return new CustomMessageComponent({ ...message, customType: "Codex result", content: operatorContent("status", result) ?? "" });
  });

  pi.registerTool({
    name: "codex_bridge",
    label: "Codex bridge agent",
    description: "Direct native Codex control, outside Agent Hub. For Agent Hub delegation, spawn agent codex-bridge. run starts or continues a locally owned thread; active turns receive steering. fork creates a locally owned direct thread through a finished source boundary (completed, failed or interrupted), preserving source cwd and original history, with no inference; continue via run. Uses parent's cwd unless isolation requested. Inherits native Codex permissions/environment; optional OMP_CODEX_BRIDGE_CONFIG JSON provides operator-set native overrides. Approval requests require explicit user confirmation; unavailable UI declines them. run accepts prompt/native input, effort, outputSchema, optional name and native serviceTier for a new turn only. Omitted serviceTier preserves native defaults; availability, quota use and cost depend on the account/model. Returns bounded execution/activity/plan/file-change metadata. Print text/JSON run waits and returns terminal output; interactive TUI/RPC run returns admission and terminal results arrive as follow-ups. status reads retained state; diagnose inspects native availability. history and details inspect saved native history without ownership/resume/replay. includeDiff explicitly includes bounded native diff which may expose secrets and is not a complete audit. cancel interrupts a locally loaded thread. shutdown closes this session's server.",
    parameters: z.object({
      action: z.enum(["run", "fork", "status", "diagnose", "history", "details", "cancel", "shutdown"]),
      threadId: z.string().min(1).optional(),
      prompt: z.string().min(1).optional(),
      cwd: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      name: z.string().min(1).optional().describe("Native thread name for run or fork."),
      serviceTier: z.string().min(1).optional().describe("Native service tier for a new turn only; omitted inherits native default. Availability is account/model dependent."),
      lastTurnId: z.string().min(1).optional().describe("Finished source turn boundary for fork; omitted selects latest completed, failed or interrupted turn."),
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
      const value = result.details;
      if (value === undefined) return new CustomMessageComponent({ role: "custom", customType: "Codex working", content: "Waiting for the native result.", display: true, timestamp: Date.now() });
      const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const label = data.error && !data.status ? "error" : data.connection ? "doctor" : data.thread ? "details" : Array.isArray(data.data) ? "history" : "status";
      const content = options.expanded ? `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
        : data.stopped ? "Codex server stopped." : operatorContent(label, Array.isArray(value) ? { threads: value } : value) ?? "";
      return new CustomMessageComponent({ role: "custom", customType: "Codex result", content, display: true, timestamp: Date.now() });
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
              name: params.name,
              serviceTier: params.serviceTier,
            }, signal, ctx.mode === "json" || ctx.mode === "print");
            break;
          case "fork":
            if (!params.threadId) throw new Error("fork requires threadId");
            result = await fork({ threadId: params.threadId, lastTurnId: params.lastTurnId, name: params.name });
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
        if (signal?.aborted && (ctx.mode === "json" || ctx.mode === "print")) console.error(`Codex print call cancelled: ${failure.error}`);
        return { content: [{ type: "text", text: JSON.stringify(failure, null, 2) }], details: failure, isError: true };
      }
    },
  });

  return shutdown;
}
