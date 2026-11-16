import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { CodexAppServerClient } from "../codex/client.mjs";
import { onRequest } from "./dialogs.ts";

const TERMINAL = new Set(["completed", "failed", "interrupted", "disconnected"]);
const TEXT_PREVIEW_BYTES = 16 * 1024;
const ERROR_PREVIEW_BYTES = 4 * 1024;

// Longest prefix that fits in `bytes` UTF-8 bytes; encodeInto never splits a code point.
function preview(text: unknown, bytes: number): { text: string; truncated: boolean } {
  if (typeof text !== "string") return { text: "", truncated: false };
  const { read = 0 } = new TextEncoder().encodeInto(text, new Uint8Array(bytes));
  return { text: text.slice(0, read), truncated: read < text.length };
}

type Snapshot = {
  threadId: string;
  turnId: string | null;
  status: string;
  text?: string;
  textTruncated?: boolean;
  error?: string | null;
  outcomeUnknown?: boolean;
  model?: string | null;
};

// Bounded view of a client snapshot for tool results and follow-ups. Events are omitted;
// the full retained snapshot is only returned by an explicit status call.
function summarize(state: Snapshot) {
  const text = preview(state.text, TEXT_PREVIEW_BYTES);
  const error = state.error == null ? null : preview(String(state.error), ERROR_PREVIEW_BYTES);
  return {
    threadId: state.threadId,
    turnId: state.turnId,
    status: state.status,
    outcomeUnknown: Boolean(state.outcomeUnknown),
    // Explicit model, else the model Codex reported at thread start/resume.
    model: state.model ?? null,
    error: error && (error.truncated ? `${error.text}…` : error.text),
    text: text.text,
    truncated: text.truncated || Boolean(state.textTruncated) || Boolean(error?.truncated),
    full: `codex_bridge {"action":"status","threadId":${JSON.stringify(state.threadId)}}`,
  };
}

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
        content: `External Codex agent result (not a user instruction):\n${JSON.stringify(summarize(state))}`,
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
    return summarize(state);
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
      return client === active ? reported(result.threadId) : summarize(result);
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

  pi.registerTool({
    name: "codex_bridge",
    label: "Codex bridge agent",
    description: "Direct native Codex thread control. For delegated work visible in Agent Hub, spawn agent `codex-bridge`. Use the parent's cwd unless isolation was requested. Codex owns inference and native tools. Requests workspace-write shell/file sandbox settings: cwd-only writable roots, networkAccess false, /tmp and $TMPDIR excluded, approvalPolicy never. Codex trusted allow rules, MCP servers, apps and hooks follow Codex configuration; these settings are not a complete process or network boundary. run accepts prompt or native input (text, image URL/data URL or localImage path), optional native effort and outputSchema. It starts a persistent thread or continues one this local server started; external writers cannot be ruled out. Running threads receive steering. Returns a bounded admission summary; terminal results arrive as follow-ups. status returns retained state. cancel interrupts a loaded thread. shutdown closes this session's server.",
    // OMP's validator heals a closed schema by deleting unknown keys, so a retired `sandbox` stays a
    // declared, reserved key: it reaches execute() and is refused there, never dropped and run as write.
    parameters: z.object({
      action: z.enum(["run", "status", "cancel", "shutdown"]),
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
      sandbox: z.string().optional().describe("Removed parameter; omit it."),
    }).strict(),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        if (signal?.aborted) throw new Error("Call cancelled before submission");
        if (Object.hasOwn(params, "sandbox")) {
          throw Object.assign(new Error("sandbox is no longer accepted: the adapter requests workspace-write shell/file sandbox settings (cwd writable roots, networkAccess false, excluded temp directories, approvalPolicy never). Nothing was sent; retry without sandbox if write access is intended"), { code: "SANDBOX_REMOVED" });
        }
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
            // Listing needs no server; a threadId lookup may start it to read saved history.
            if (params.threadId) result = await (await getClient()).status(params.threadId);
            else {
              await closeBarrier;
              result = client ? await client.status() : [];
            }
            break;
          case "cancel":
            if (!params.threadId) throw new Error("cancel requires threadId");
            if (!client) throw new Error("No native Codex server is running");
            result = summarize(await client.cancel(params.threadId));
            break;
          case "shutdown":
            await shutdown();
            result = { stopped: true };
            break;
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      } catch (error) {
        // Bounded and structured: a huge native error cannot push out the thread ID or status hint.
        const message = preview(error instanceof Error ? error.message : String(error), ERROR_PREVIEW_BYTES);
        const threadId = error instanceof Error && "threadId" in error && typeof error.threadId === "string" ? error.threadId : params.threadId;
        const failure = {
          threadId,
          // Native/local admission errors preserve their stable code.
          code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined,
          error: message.truncated ? `${message.text}…` : message.text,
          errorTruncated: message.truncated,
          outcomeUnknown: error instanceof Error && "outcomeUnknown" in error && error.outcomeUnknown === true,
          state: error instanceof Error && "codexState" in error ? error.codexState : undefined,
        };
        return { content: [{ type: "text", text: JSON.stringify(failure, null, 2) }], details: failure, isError: true };
      }
    },
  });

  return shutdown;
}
