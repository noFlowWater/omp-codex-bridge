import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { bounded } from "../codex/protocol.mjs";
import { projectItem } from "../codex/inspection.mjs";

// Byte limits are for transport payloads; screenLine below limits displayed characters instead.
export function utf8Preview(text: unknown, bytes: number): { text: string; truncated: boolean } {
  if (typeof text !== "string") return { text: "", truncated: false };
  const { read = 0 } = new TextEncoder().encodeInto(text, new Uint8Array(bytes));
  return { text: text.slice(0, read), truncated: read < text.length };
}

function screenLine(value: unknown, characters = 500): string {
  const text = String(value ?? "unknown").replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
  return text.length > characters ? `${text.slice(0, characters)}… [truncated]` : text;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function quotaWindow(name: string, window: Record<string, unknown>) {
  const minutes = window.windowDurationMins;
  const label = typeof minutes === "number" && minutes > 0
    ? minutes % 1440 === 0 ? `${minutes / 1440}-day usage` : minutes % 60 === 0 ? `${minutes / 60}-hour usage` : `${minutes}-minute usage`
    : name === "primary" ? "Usage window 1" : "Usage window 2";
  const date = typeof window.resetsAt === "number" ? new Date(window.resetsAt * 1000) : undefined;
  const reset = date && Number.isFinite(date.getTime()) ? ` · resets ${date.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  })}` : "";
  return { label, value: `${window.usedPercent}% used${reset}` };
}

// Human diagnostics share the native message renderer; transport responses stay intact.
export function operatorCard(label: string, value: unknown): string | undefined {
  const result = objectRecord(value);
  const line = (name: string, value: unknown) => `${name.padEnd(15)}  ${screenLine(value)}`;
  const threadSummary = (value: unknown) => {
    const data = objectRecord(value);
    const state = objectRecord(data.snapshot ?? data.state ?? data);
    const thread = objectRecord(data.thread);
    const execution = objectRecord(state.execution);
    const failure = objectRecord(state.commandFailure);
    const tokens = objectRecord(state.usage ?? state.turnUsage).totalTokens;
    return [line("Thread", state.threadId ?? thread.id), line("Status", state.status ?? (data.forked ? "forked" : "unknown")),
      ...(state.name || thread.name ? [line("Name", state.name ?? thread.name)] : []),
      ...(execution.model || state.model ? [line("Model", execution.model ?? state.model)] : []),
      ...(execution.requestedReasoningEffort ? [line("Requested effort", execution.requestedReasoningEffort)] : []),
      ...(execution.requestedServiceTier ? [line("Requested tier", execution.requestedServiceTier)] : []),
      ...(execution.serviceTier ? [line("Effective tier", execution.serviceTier)] : []),
      ...(execution.cwd || state.cwd || thread.cwd ? [line("Directory", execution.cwd ?? state.cwd ?? thread.cwd)] : []),
      ...(state.error || data.error ? [line("Error", state.error ?? data.error)] : []),
      ...(state.commandFailure ? [line("Command failed", `exit ${screenLine(failure.exitCode)}`)] : []),
      ...(typeof tokens === "number" ? [line("Tokens", tokens.toLocaleString("en-US")), line("Cost", "Not reported")] : []),
      ...(state.outcomeUnknown || data.outcomeUnknown ? ["Outcome unknown. Do not automatically retry, resume or replay."] : []),
      ...(data.forked ? ["Created a direct-tool thread. No inference started."] : []),
      ...(data.nameWarning ? [line("Name warning", data.nameWarning)] : []),
    ].join("\n");
  };
  if (result.cancelled === true) return "Cancelled.";
  if (label === "error") return [
    ...(result.state ? [threadSummary(value)] : [line("Error", result.error)]),
    ...(result.code === undefined ? [] : [line("Code", result.code)]),
    ...(result.threadId ? [line("Thread", result.threadId)] : []),
    ...(result.outcomeUnknown ? ["Outcome unknown. Do not automatically retry, resume or replay."] : []),
    ...(result.remedy ? [screenLine(result.remedy, 1000)] : []),
  ].join("\n");
  if (label === "tier") return [line("Service tier", result.serviceTier), screenLine(result.scope),
    ...(result.note ? [screenLine(result.note)] : [])].join("\n");
  if (label === "fork" || label === "details" || (label === "history" && result.thread)) {
    return [threadSummary(value), "Full details: expand or use --json after the subcommand."].join("\n");
  }
  if (label === "history" && result.forked) return threadSummary(value);
  if (label === "history" && Array.isArray(result.data)) return [
    ...result.data.map(thread => { const row = objectRecord(thread); return `${screenLine(row.id)}  ${screenLine(row.name ?? row.preview ?? "(unnamed)", 120)}`; }),
    ...(result.nextCursor ? ["More threads available; use --json for the continuation cursor."] : []),
  ].join("\n") || "No saved threads.";
  if (label === "status") {
    if (!Array.isArray(result.threads)) return threadSummary(value);
    return [...(result.threads.length ? [line("Threads", result.threads.length), ...result.threads.map(threadSummary)] : ["No locally loaded direct-tool threads."]),
      "Saved / Hub threads: /codex history or /codex status THREAD_ID"].join("\n");
  }
  if (label !== "doctor") return undefined;
  const check = (name: string, detail?: unknown) => {
    const section = objectRecord(result[name]);
    const error = objectRecord(section.error);
    return line(name, [section.status ?? "unknown", detail, section.reason ?? error.error, section.remedy].filter(v => v !== undefined && v !== null && v !== "").join(" · "));
  };
  const auth = objectRecord(objectRecord(result.auth).value);
  const config = objectRecord(objectRecord(objectRecord(result.permissions).value).config);
  const settings = objectRecord(config.value);
  const quota = objectRecord(objectRecord(result.rateLimits).value);
  const limits = objectRecord(quota.rateLimits);
  const lines = [
    line("Versions", `OMP ${screenLine(result.ompVersion)} · ${screenLine(objectRecord(result.executable).version)}`),
    check("connection"),
    line("Login", `${auth.authenticated === true ? "Signed in" : auth.authenticated === false ? "Not signed in" : "Unknown"}${auth.mode ? ` · ${screenLine(auth.mode)}` : ""}`),
    check("permissions", `${screenLine(settings.sandboxMode)} · approval=${screenLine(settings.approvalPolicy)} · source=${screenLine(result.permissionSource)}`),
    line("Configured", `${screenLine(settings.model)} · effort=${screenLine(settings.modelReasoningEffort)}`),
  ];
  if (objectRecord(result.auth).status !== "available") lines.push(check("auth"));
  for (const name of ["executable", "models", "steering", "rateLimits"]) {
    if (objectRecord(result[name]).status !== "available") lines.push(check(name));
  }
  for (const name of ["primary", "secondary"]) {
    const window = objectRecord(limits[name]);
    if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
    const usage = quotaWindow(name, window);
    lines.push(line(usage.label, usage.value));
  }
  if (limits.spendControlReached === true) lines.push("WARNING: spend control reached.");
  if (quota.ordinaryUsageAllowed === false) lines.push("WARNING: ordinary usage is not allowed.");
  if (config.status !== "available") lines.push(line("Config", config.status ?? "unknown"));
  lines.push("Read-only checks do not prove future quota or admission.", "Expand for all checks, models and remedies. /codex doctor --json for raw JSON.");
  return lines.join("\n");
}

// Aligned diagnostic rows become native Markdown tables; native data stays literal.
export function operatorMarkdown(summary: string): string {
  const escape = (value: string) => value.replace(/[\\`*_[\]<>|]/g, "\\$&");
  const blocks: string[] = [];
  let rows: string[] = [];
  const flush = () => {
    if (!rows.length) return;
    blocks.push(["| Item | Value |", "| --- | --- |", ...rows].join("\n"));
    rows = [];
  };
  for (const text of summary.split("\n")) {
    const row = /^(.+?) {2,}(.*)$/.exec(text);
    if (row) rows.push(`| ${escape(row[1])} | ${escape(row[2])} |`);
    else { flush(); blocks.push(escape(text)); }
  }
  flush();
  return blocks.join("\n\n");
}

function literalBlock(value: string, language = "text", truncated = false) {
  const clean = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
  const fence = "`".repeat(Math.max(3, ...Array.from(clean.matchAll(/`+/g), match => match[0].length + 1)));
  return `${fence}${language}\n${clean}\n${fence}${truncated ? "\n\n[Output truncated; inspect retained native details.]" : ""}`;
}

export function operatorContent(label: string, value: unknown): string | undefined {
  const summary = operatorCard(label, value);
  if (summary === undefined) return undefined;
  const data = objectRecord(value);
  const state = objectRecord(data.snapshot ?? data.state ?? data);
  const failure = objectRecord(state.commandFailure);
  const blocks = [operatorMarkdown(summary)];
  if (state.latestActivity) blocks.push("**Activity**", literalBlock(activityLabel(state.latestActivity)));
  if (state.latestPlan) {
    const plan = objectRecord(state.latestPlan);
    const text = typeof state.latestPlan === "string" ? state.latestPlan : Array.isArray(plan.plan)
      ? plan.plan.map(entry => { const step = objectRecord(entry); return `${screenLine(step.status)} · ${screenLine(step.step)}`; }).join("\n") : "";
    if (text) blocks.push("**Plan**", literalBlock(text));
  }
  if (Array.isArray(state.fileChanges) && state.fileChanges.length) blocks.push("**Native file changes**", literalBlock(state.fileChanges.flatMap(entry => {
    const change = objectRecord(entry);
    return Array.isArray(change.changes) ? change.changes.map(raw => { const file = objectRecord(raw); return `${screenLine(file.path)}${file.movePath ? ` → ${screenLine(file.movePath)}` : ""}`; }) : [`${screenLine(change.path)}${change.movePath ? ` → ${screenLine(change.movePath)}` : ""}`];
  }).join("\n"), "text", Boolean(state.fileChangesOmitted)), "Native events; not a complete audit.");
  if (state.fileChangesOmitted) blocks.push(`${screenLine(state.fileChangesOmitted)} file-change items omitted; inspect native details.`);
  if (typeof state.text === "string" && state.text) blocks.push("**Answer**", literalBlock(state.text, "text", state.textTruncated === true || state.truncated === true));
  if (typeof failure.outputTail === "string" && failure.outputTail) blocks.push("**Failure output**", literalBlock(failure.outputTail, "text", failure.outputTruncated === true));
  const items = objectRecord(data.items);
  if (Array.isArray(items.data)) for (const entry of items.data) {
    const item = objectRecord(objectRecord(entry).item);
    if (item.type !== "fileChange" || !Array.isArray(item.changes)) continue;
    for (const raw of item.changes) {
      const change = objectRecord(raw);
      if (typeof change.diff !== "string") continue;
      blocks.push(literalBlock(`${screenLine(change.path)}${change.movePath ? ` → ${screenLine(change.movePath)}` : ""}`),
        literalBlock(change.diff, "diff", change.diffTruncated === true));
    }
  }
  if (items.nextCursor) blocks.push("More items available. Expand for the turn ID and continuation cursor.");
  return blocks.join("\n\n");
}

// Automatic surfaces never render raw native item arguments, results, or successful command output.
function activityLabel(value: unknown): string {
  if (typeof value === "string") return screenLine(value);
  const activity = objectRecord(value);
  if (typeof activity.summary === "string") return screenLine(activity.summary);
  const item = objectRecord(objectRecord(activity.params).item ?? activity.item);
  const parts = [screenLine(activity.method ?? "native activity", 100)];
  if (item?.type === "commandExecution" && typeof item.command === "string") parts.push(screenLine(item.command, 256));
  if (typeof item?.status === "string") parts.push(screenLine(item.status, 40));
  if (typeof item?.exitCode === "number") parts.push(`exit ${item.exitCode}`);
  return parts.join(" · ");
}

function changeMetadata(value: unknown) {
  const change = objectRecord(value);
  if (change.type === "fileChange") return projectItem(change);
  return { path: change.path, movePath: change.movePath, kind: objectRecord(change.kind).type ?? (typeof change.kind === "string" ? change.kind : undefined) };
}

export type RunSnapshot = {
  threadId: string; turnId: string | null; status: string; name?: string | null;
  text?: string; textTruncated?: boolean; error?: string | null; outcomeUnknown?: boolean;
  model?: string | null; execution?: unknown; latestActivity?: unknown; latestPlan?: unknown;
  fileChanges?: unknown; commandFailure?: unknown; turnUsage?: unknown;
};

// The explicit status/details response retains native data. Automatic admissions/follow-ups stay small.
export function summarizeRun(state: RunSnapshot) {
  const text = utf8Preview(state.text, 16 * 1024);
  const error = state.error == null ? null : utf8Preview(String(state.error), 4 * 1024);
  const budget = { left: 2048 };
  const failure = state.commandFailure as { itemId?: string; command?: string; exitCode?: number; outputTail?: string; outputTruncated?: boolean } | null | undefined;
  const commandFailure = bounded(failure ? {
    itemId: failure.itemId, command: failure.command?.slice(0, 256), exitCode: failure.exitCode,
    outputTail: failure.outputTail?.slice(-1024),
    outputTruncated: Boolean(failure.outputTruncated) || (failure.outputTail?.length ?? 0) > 1024,
  } : null, budget);
  const execution = bounded(state.execution, budget);
  const activity = state.latestActivity as { method?: string; at?: number } | null | undefined;
  const latestActivity = activity ? { method: activity.method, at: activity.at, summary: activityLabel(activity) } : null;
  const latestPlan = bounded(state.latestPlan, budget);
  const usage = bounded(state.turnUsage ?? null, budget);
  const changes = Array.isArray(state.fileChanges) ? state.fileChanges : [];
  const fileChanges = changes.slice(0, 5).map(change => bounded(changeMetadata(change), budget))
    .filter(change => change && typeof change === "object");
  const result = {
    threadId: state.threadId, turnId: state.turnId, status: state.status,
    name: utf8Preview(state.name, 256).text || null,
    outcomeUnknown: Boolean(state.outcomeUnknown), model: utf8Preview(state.model, 256).text || null,
    execution, latestActivity, latestPlan, fileChanges, commandFailure, usage, cost: null,
    fileChangesOmitted: changes.length - fileChanges.length,
    error: error && (error.truncated ? `${error.text}…` : error.text), text: text.text,
    truncated: text.truncated || Boolean(state.textTruncated) || Boolean(error?.truncated),
    metadataTruncated: budget.left <= 0 || changes.length > fileChanges.length,
    full: `codex_bridge {"action":"status","threadId":${JSON.stringify(state.threadId)}}`,
  };
  // Include JSON escaping/indentation in the budget; reserve 4 KiB for host envelopes.
  const encoder = new TextEncoder();
  for (const field of ["text", "latestPlan", "fileChanges", "latestActivity", "commandFailure", "execution", "usage", "error"] as const) {
    const excess = encoder.encode(JSON.stringify(result, null, 2)).length - 20 * 1024;
    if (excess <= 0) break;
    if (field === "text" || field === "error") {
      const value = result[field];
      if (typeof value === "string") result[field] = utf8Preview(value, Math.max(0, encoder.encode(value).length - excess)).text;
      result.truncated = true;
    } else {
      if (field === "fileChanges") { result.fileChanges = []; result.fileChangesOmitted = changes.length; }
      else if (field === "latestActivity") result.latestActivity = null;
      else result[field] = null;
      result.metadataTruncated = true;
    }
  }
  return result;
}

export type ProgressStatus = {
  threadId: string; turnId: string | null; status: string; activity: string | null; plan: string | null;
  execution: { model: string | null; cwd: string | null; requestedReasoningEffort: string | null };
  logTruncated: boolean;
};

// Agent Hub owns per-worker activity. The native footer only summarizes active Codex work.
export function createProgressDisplay() {
  const active = new Map<string, string | null>();
  const quotas = new Map<string, Record<string, unknown>>();
  let root: ExtensionContext | undefined;
  let rendered: string | undefined;
  function render() {
    if (!root?.hasUI) return;
    const models = new Set([...active.values()].filter((model): model is string => Boolean(model)));
    const model = models.size === 1 ? ` · ${screenLine([...models][0], 48)}` : models.size > 1 ? ` · ${models.size} models` : "";
    const text = active.size ? `Codex ${active.size} active${model} · Alt+A` : undefined;
    if (text === rendered) return;
    root.ui.setStatus("codex-bridge", text);
    rendered = text;
  }
  function notify(message: string, type: "info" | "warning" | "error" = "info") {
    try { if (root?.hasUI) root.ui.notify(message, type); } catch { /* Native work does not depend on UI delivery. */ }
  }
  return {
    notify,
    rateLimits(value: unknown) {
      if (!root?.hasUI) return;
      const incoming = objectRecord(objectRecord(value).rateLimits);
      const id = typeof incoming.limitId === "string" ? incoming.limitId : "default";
      const previous = quotas.get(id) ?? {};
      const current: Record<string, unknown> = { ...previous };
      for (const key of ["primary", "secondary"] as const) {
        const window = objectRecord(incoming[key]);
        if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
        current[key] = { ...objectRecord(previous[key]), ...Object.fromEntries(Object.entries(window).filter(([, entry]) => entry != null)) };
      }
      if (typeof incoming.spendControlReached === "boolean") current.spendControlReached = incoming.spendControlReached;
      if (typeof incoming.limitName === "string") current.limitName = incoming.limitName;
      const windows = ["primary", "secondary"].map(key => objectRecord(current[key]));
      const reached = current.spendControlReached === true || windows.some(window => typeof window.usedPercent === "number" && window.usedPercent >= 100);
      current.reached = reached;
      quotas.set(id, current);
      if (reached === (previous.reached === true)) return;
      const detail = ["primary", "secondary"].flatMap(key => {
        const window = objectRecord(current[key]);
        if (typeof window.usedPercent !== "number") return [];
        const usage = quotaWindow(key, window);
        return [`${usage.label}: ${usage.value}`];
      }).join("; ");
      notify(`Codex ${screenLine(current.limitName ?? id, 80)}: ${reached ? "limit reached" : "usage window recovered"}${detail ? ` · ${detail}` : ""}`, reached ? "warning" : "info");
    },
    update(sessionId: string, status?: ProgressStatus) {
      if (status) active.set(sessionId, status.execution?.model ?? null);
      else active.delete(sessionId);
      render();
    },
    capture(ctx: ExtensionContext) {
      if (ctx.agent.kind !== "main") return;
      if (root && root.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) {
        if (root.hasUI) root.ui.setStatus("codex-bridge", undefined);
        active.clear();
        quotas.clear();
        rendered = undefined;
      }
      root = ctx;
      render();
    },
    release(ctx?: ExtensionContext) {
      if (!root || (ctx && root.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId())) return;
      if (root.hasUI) root.ui.setStatus("codex-bridge", undefined);
      root = undefined;
      rendered = undefined;
      active.clear();
      quotas.clear();
    },
  };
}
