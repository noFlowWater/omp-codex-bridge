import { AssistantMessageEventStream, validateJsonSchemaValue } from "@oh-my-pi/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { join } from "node:path";
import { CodexNativeClient } from "../lib/codex-bridge/client.mjs";
import {
  CODEX_NATIVE_API,
  CODEX_NATIVE_MODELS,
  CODEX_NATIVE_PROVIDER,
  createCodexNativeStream,
  fetchCodexNativeModels,
} from "../lib/codex-bridge/provider.mjs";

type QuestionParams = {
  isBlocking: boolean;
  delivery?: string;
  questions: { id: string; header: string; question: string; isSecret?: boolean; isOther?: boolean; options?: { label: string; description: string }[] | null }[];
};
type FormChoice = { const: string; title: string };
type FormField = {
  type: string; title?: string | null; description?: string | null; format?: string | null;
  enum?: string[]; enumNames?: string[] | null; oneOf?: FormChoice[];
  items?: { enum?: string[]; anyOf?: FormChoice[] };
  default?: unknown;
};
type FormSchema = { type: string; properties: Record<string, FormField>; required?: string[] | null };
type FormParams = { mode?: string; serverName: string; message: string; _meta?: unknown; requestedSchema?: unknown };
type RequestParsers = {
  questions: { parse(value: unknown): QuestionParams };
  form: { parse(value: unknown): FormParams };
  formSchema: { parse(value: unknown): FormSchema };
};
type NativeRequest = { method: string; params: unknown; signal: AbortSignal };

// Factories are rebound in headless children. Only main-session lifecycle events may own the UI.
let root: { ctx: ExtensionContext; sessionId: string; controller: AbortController; parsers: RequestParsers } | undefined;
function releaseRoot() {
  root?.controller.abort();
  root = undefined;
}
function captureRoot(ctx: ExtensionContext, parsers: RequestParsers) {
  if (ctx.agent.kind !== "main") return;
  const sessionId = ctx.sessionManager.getSessionId();
  if (root?.sessionId === sessionId && !root.controller.signal.aborted) {
    root.ctx = ctx;
    root.parsers = parsers;
    return;
  }
  releaseRoot();
  root = { ctx, sessionId, controller: new AbortController(), parsers };
}


async function onRequest(request: NativeRequest, owner: typeof root | null = root) {
  const empty = request.method === "mcpServer/elicitation/request" ? { action: "cancel" } : { answers: {} };
  if (!owner?.ctx.hasUI || request.signal.aborted || owner.controller.signal.aborted) return empty;
  const signal = AbortSignal.any([request.signal, owner.controller.signal]);
  const current = () => !signal.aborted && root === owner;
  const ui = owner.ctx.ui;
  if (request.method === "item/tool/requestUserInput") {
    const params = owner.parsers.questions.parse(request.params);
    if (!params.isBlocking && params.delivery !== "async") return empty;
    const optionalAnswers = !params.isBlocking && params.delivery === "async";
    const answers: Record<string, { answers: string[] }> = Object.create(null);
    if (ui.askDialog && params.questions.every(question => !question.isSecret && (!question.options?.length || question.isOther))) {
      const result = await ui.askDialog(params.questions.map(question => ({
        id: question.id, header: question.header, question: question.question, options: question.options ?? [], multi: false,
      })), { signal });
      if (!current() || result?.kind !== "submit" || !optionalAnswers && result.results.length !== params.questions.length) return empty;
      const seen = new Set<string>();
      for (const item of result.results) {
        if (seen.has(item.id) || !params.questions.some(question => question.id === item.id)) return empty;
        seen.add(item.id);
      }
      for (const question of params.questions) {
        const item = result.results.find(entry => entry.id === question.id);
        if (!item || item.timedOut) {
          if (optionalAnswers) continue;
          return empty;
        }
        if (item.selectedOptions.length > 1 || item.selectedOptions.some(value => !question.options?.some(option => option.label === value))) return empty;
        const custom = item.customInput?.trim() ? item.customInput : undefined;
        if (custom && item.selectedOptions.length) return empty;
        const values = custom ? [custom] : item.selectedOptions;
        if (!values.length && optionalAnswers) continue;
        if (values.length !== 1 || custom && question.options?.length && !question.isOther) return empty;
        answers[question.id] = { answers: values };
      }
    } else {
      for (const question of params.questions) {
        if (!current()) return empty;
        const title = `${question.header}\n${question.question}`;
        let value: string | undefined;
        if (question.options?.length && !question.isSecret) {
          const options: { label: string; description?: string }[] = question.options.map(option => ({ ...option }));
          let other = "Other (type your own)";
          while (options.some(option => option.label === other)) other += "…";
          if (question.isOther) options.push({ label: other });
          let skip = "Skip this question";
          while (options.some(option => option.label === skip)) skip += "…";
          if (optionalAnswers) options.push({ label: skip });
          value = await ui.select(title, options, { signal });
          if (optionalAnswers && value === skip) continue;
          if (value === other && question.isOther) value = await ui.input(title, undefined, { signal });
          else if (value !== undefined && !question.options.some(option => option.label === value)) return empty;
        } else {
          if (optionalAnswers) {
            const choice = await ui.select(title, ["Answer", "Skip this question"], { signal });
            if (!current() || choice === undefined) return empty;
            if (choice === "Skip this question") continue;
            if (choice !== "Answer") return empty;
          }
          value = await ui.input(title, undefined, { signal, secret: question.isSecret === true });
        }
        if (!current() || value === undefined) return empty;
        if (optionalAnswers && !value.trim()) continue;
        answers[question.id] = { answers: [value] };
      }
    }
    return current() ? { answers } : empty;
  }
  if (request.method !== "mcpServer/elicitation/request") throw new Error(`Unsupported native UI request: ${request.method}`);
  const params = owner.parsers.form.parse(request.params);
  // Known approval markers are declined. Unmarked MCP workflows still require explicit submission.
  if (params.mode !== "form" || /approval|permission|mcp_tool_call/i.test(JSON.stringify(params._meta ?? {}))) return { action: "decline" };
  let schema: FormSchema;
  try { schema = owner.parsers.formSchema.parse(params.requestedSchema); } catch {
    ui.notify("MCP form declined: unsupported form schema.", "warning");
    return { action: "decline" };
  }
  // OMP's JSON Schema validator does not implement `format`; do not accept it as enforced.
  if (Object.values(schema.properties).some(field => field.format != null)) {
    ui.notify("MCP form declined: string format validation is unsupported by this host.", "warning");
    return { action: "decline" };
  }
  const content: Record<string, unknown> = Object.create(null);
  for (const [key, field] of Object.entries(schema.properties)) {
    if (!current()) return empty;
    const title = `${params.serverName}: ${params.message}\n${field.title ?? key}${field.description ? `\n${field.description}` : ""}`;
    const required = schema.required?.includes(key);
    if (!required) {
      const choice = await ui.select(`${title}\nOptional field`, ["Provide value", "Omit field"], { signal });
      if (!current() || choice === undefined) return empty;
      if (choice === "Omit field") continue;
      if (choice !== "Provide value") return empty;
    }
    let value: unknown;
    const choices = field.enum ?? field.oneOf?.map(entry => entry.const);
    if (field.type === "boolean") {
      const selected = await ui.select(title, ["true", "false"], { signal });
      if (selected !== "true" && selected !== "false") return empty;
      value = selected === "true";
    } else if (field.type === "string" && Array.isArray(choices)) {
      const options = choices.map((entry, index) => ({
        label: entry, description: field.oneOf?.[index]?.title ?? field.enumNames?.[index],
      }));
      value = await ui.select(title, options, { signal });
    } else {
      const text = await ui.input(title, field.type === "string" ? undefined : `JSON ${JSON.stringify(field)}`, { signal });
      if (text === undefined) return empty;
      try { value = field.type === "string" ? text : JSON.parse(text); } catch { return { action: "decline" }; }
    }
    if (!current() || value === undefined) return empty;
    // Keep the original complete schema for validation; the parsed view only drives rendering.
    content[key] = value;
  }
  const validation = validateJsonSchemaValue(params.requestedSchema, content);
  if (!validation.success) {
    ui.notify("MCP form declined: submitted values do not satisfy the requested schema.", "warning");
    return { action: "decline" };
  }
  const submit = await ui.select(`${params.serverName}: ${params.message}\nSubmit these answers?`, ["Submit answers", "Decline"], { signal });
  if (!current() || submit === undefined) return empty;
  return submit === "Submit answers" ? { action: "accept", content } : { action: "decline" };
}
onRequest.forClient = () => {
  const owner = root ?? null;
  return (request: NativeRequest) => onRequest(request, owner);
};

// Module scope: every session's factory registers this one function, so the process-global
// custom-API entry (last registration wins) always reaches the full per-session table.
// Session records live in the active OMP agent directory, never beside this extension's checkout.
const streamSimple = createCodexNativeStream({
  EventStream: AssistantMessageEventStream,
  stateDir: process.env.OMP_CODEX_BRIDGE_STATE_DIR || join(getAgentDir(), "codex-bridge-state"),
  onRequest,
});

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
    full: `codex_native {"action":"status","threadId":${JSON.stringify(state.threadId)}}`,
  };
}

const terminalKey = (state: { threadId: string; turnId?: string | null; status: string }) =>
  `${state.threadId}/${state.turnId ?? ""}/${state.status}`;

export default function (pi: ExtensionAPI) {
  // The Codex-backed task agent (agents/codex-bridge.md) runs on this provider; Codex keeps the
  // tool loop, OMP sees assistant events only. Every thread runs workspace-write in its cwd. The
  // static `default` id runs Codex's default model; discovery (native model/list, cached by OMP)
  // adds one profile per native model slug.
  pi.registerProvider(CODEX_NATIVE_PROVIDER, {
    baseUrl: "https://codex-bridge.invalid/",
    apiKey: "codex-bridge-uses-codex-login",
    api: CODEX_NATIVE_API,
    streamSimple,
    models: CODEX_NATIVE_MODELS,
    fetchDynamicModels: () => fetchCodexNativeModels(),
  });

  const z = pi.zod;
  const choiceSchema = z.object({ const: z.string(), title: z.string() }).strict();
  const formField = z.object({
    type: z.enum(["string", "number", "integer", "boolean", "array"]),
    title: z.string().nullable().optional(), description: z.string().nullable().optional(),
    format: z.enum(["email", "uri", "date", "date-time"]).nullable().optional(),
    enum: z.array(z.string()).optional(), enumNames: z.array(z.string()).nullable().optional(),
    oneOf: z.array(choiceSchema).optional(),
    items: z.object({ type: z.literal("string").optional(), enum: z.array(z.string()).optional(), anyOf: z.array(choiceSchema).optional() }).strict().optional(),
    minimum: z.number().nullable().optional(), maximum: z.number().nullable().optional(),
    minLength: z.number().int().nonnegative().nullable().optional(), maxLength: z.number().int().nonnegative().nullable().optional(),
    minItems: z.number().int().nonnegative().nullable().optional(), maxItems: z.number().int().nonnegative().nullable().optional(),
    default: z.unknown().optional(),
  }).strict();
  const parsers: RequestParsers = {
    questions: z.object({
      isBlocking: z.boolean(),
      delivery: z.string().optional(),
      questions: z.array(z.object({
        id: z.string(), header: z.string(), question: z.string(),
        isSecret: z.boolean().optional(), isOther: z.boolean().optional(),
        options: z.array(z.object({ label: z.string(), description: z.string() })).nullable().optional(),
      })),
    }),
    form: z.object({
      mode: z.string().optional(), serverName: z.string(), message: z.string(), _meta: z.unknown().optional(),
      requestedSchema: z.unknown().optional(),
    }),
    formSchema: z.object({
      $schema: z.string().nullable().optional(),
      type: z.literal("object"), properties: z.record(z.string(), formField), required: z.array(z.string()).nullable().optional(),
    }).strict(),
  };
  let client: CodexNativeClient | undefined;
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
      client = new CodexNativeClient({ onRequest: onRequest.forClient() });
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

  pi.on("session_start", (_event, ctx) => captureRoot(ctx, parsers));
  pi.on("session_switch", async (_event, ctx) => {
    const stopped = shutdown();
    captureRoot(ctx, parsers);
    await stopped;
  });
  pi.on("session_before_switch", async (_event, ctx) => {
    if (ctx.agent.kind === "main") releaseRoot();
    await streamSimple.close(ctx.sessionManager.getSessionId());
  });
  pi.on("before_agent_start", (_event, ctx) => captureRoot(ctx, parsers));
  pi.on("session_before_compact", (event, ctx) => streamSimple.beforeCompact(event, ctx));
  pi.on("session_compact", (event, ctx) => streamSimple.afterCompact(event, ctx));
  pi.on("session_before_tree", (event, ctx) => streamSimple.beforeTree(event, ctx));
  pi.on("session_tree", (event, ctx) => streamSimple.afterTree(event, ctx));
  pi.on("context", (event, ctx) => streamSimple.context(event, ctx));
  pi.on("before_provider_request", (event, ctx) => streamSimple.beforeProviderRequest(event, ctx));
  pi.on("session_clear", async (_event, ctx) => {
    if (ctx.agent.kind === "main") releaseRoot();
    await streamSimple.clear(ctx.sessionManager.getSessionId());
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx?.agent.kind === "main" && root?.sessionId === ctx.sessionManager.getSessionId()) releaseRoot();
    if (ctx) await streamSimple.close(ctx.sessionManager.getSessionId());
    await shutdown();
  });
}
