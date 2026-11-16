import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

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

export function approvalPrompt(method: string, params: Record<string, unknown>, scope: string) {
  const clean = (value: string) => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
  const rows: string[] = [];
  const visit = (name: string, value: unknown, indent = "") => {
    if (value === undefined) return;
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      rows.push(`${indent}${clean(name)}:${entries.length ? "" : Array.isArray(value) ? " (empty list)" : " (empty object)"}`);
      for (const [key, child] of entries) visit(key, child, `${indent}  `);
    } else rows.push(`${indent}${clean(name)}: ${clean(String(value))}`);
  };
  const { command, commandLine, cwd, reason, ...rest } = params;
  for (const [key, value] of Object.entries({ command, commandLine, cwd, reason, ...rest })) visit(key, value);
  const full = `Codex approval · ${method}\n${rows.join("\n")}\n\n${scope}`;
  const compact = `Codex approval · ${method}\n${rows.slice(0, 6).join("\n")}\n${rows.length > 6 ? "More request details: expand before approving.\n" : ""}${scope}`;
  return { compact, full };
}

// Factories are rebound in headless children. Only main-session lifecycle events may own the UI.
let root: { ctx: ExtensionContext; sessionId: string; controller: AbortController; parsers: RequestParsers } | undefined;
export function releaseRoot(ctx?: ExtensionContext) {
  if (ctx && root?.sessionId !== ctx.sessionManager.getSessionId()) return;
  root?.controller.abort();
  root = undefined;
}
export function captureRoot(ctx: ExtensionContext, parsers: RequestParsers) {
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


export async function onRequest(request: NativeRequest, owner: typeof root | null = root) {
  const approval = request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval";
  const permissions = request.method === "item/permissions/requestApproval";
  const legacy = request.method === "applyPatchApproval" || request.method === "execCommandApproval";
  const empty = approval ? { decision: "decline" }
    : permissions ? { permissions: {}, scope: "turn" }
    : legacy ? { decision: { denied: { rejection: "User approval was not granted" } } }
    : request.method === "mcpServer/elicitation/request" ? { action: "cancel" } : { answers: {} };
  if (!owner?.ctx.hasUI || request.signal.aborted || owner.controller.signal.aborted) return empty;
  const signal = AbortSignal.any([request.signal, owner.controller.signal]);
  const current = () => !signal.aborted && root === owner;
  const ui = owner.ctx.ui;
  if (approval || permissions || legacy) {
    const params = request.params as Record<string, unknown>;
    if (!params || typeof params !== "object" || Array.isArray(params)) return empty;
    if (permissions && (!params.permissions || typeof params.permissions !== "object" || Array.isArray(params.permissions))) return empty;
    if (request.method === "item/commandExecution/requestApproval" && params.availableDecisions != null
      && (!Array.isArray(params.availableDecisions) || !params.availableDecisions.includes("accept"))) return empty;
    const scope = permissions ? "Approve these permissions for this turn only?" : "Approve only this request?";
    const prompt = approvalPrompt(request.method, params, scope);
    let accepted = false;
    if (ui.approve) accepted = await ui.approve(prompt, { signal }) === "once";
    else {
      let full = false;
      for (;;) {
        const selected = await ui.select(full ? prompt.full : prompt.compact,
          ["Decline", "Approve once", "View full details"], { signal });
        if (!current()) return empty;
        if (selected === "View full details") { full = true; continue; }
        accepted = selected === "Approve once";
        break;
      }
    }
    if (!current() || !accepted) return empty;
    if (permissions) return { permissions: params.permissions, scope: "turn" };
    if (legacy) return { decision: "approved" };
    return { decision: "accept" };
  }
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
  if (!["form", "openai/form", "openaiForm"].includes(params.mode ?? "") || /approval|permission|mcp_tool_call/i.test(JSON.stringify(params._meta ?? {}))) return { action: "decline" };
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

export function createRequestParsers(z: ExtensionAPI["zod"]): RequestParsers {
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
  return {
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
}
