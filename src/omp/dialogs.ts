import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createFormParsers, requestForm, type FormParams, type FormSchema } from "./forms.ts";

type QuestionParams = {
  isBlocking: boolean;
  delivery?: string;
  questions: { id: string; header: string; question: string; isSecret?: boolean; isOther?: boolean; options?: { label: string; description: string }[] | null }[];
};
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


async function requestAnswers(params: QuestionParams, ui: ExtensionContext["ui"], signal: AbortSignal, current: () => boolean) {
  const empty = { answers: {} };
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
    return requestAnswers(owner.parsers.questions.parse(request.params), ui, signal, current);
  }
  if (request.method !== "mcpServer/elicitation/request") throw new Error(`Unsupported native UI request: ${request.method}`);
  const params = owner.parsers.form.parse(request.params);
  return requestForm(params, owner.parsers.formSchema, ui, signal, current);
}

onRequest.forClient = () => {
  const owner = root ?? null;
  return (request: NativeRequest) => onRequest(request, owner);
};

export function createRequestParsers(z: ExtensionAPI["zod"]): RequestParsers {
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
    ...createFormParsers(z),
  };
}
