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
  return String(value ?? "unknown").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, characters);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Automatic surfaces never render raw native item arguments, results, or successful command output.
function activityLabel(value: unknown): string {
  if (typeof value === "string") return screenLine(value);
  const activity = objectRecord(value);
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

// A collapsed result exposes execution identity and failures, including structured admission errors.
export function executionCard(result: unknown, expanded = false): string {
  const data = objectRecord(result);
  const state = objectRecord(data.snapshot ?? data.state ?? data);
  if (!state.threadId && !data.error) {
    const json = JSON.stringify(result, null, 2) ?? String(result);
    return `Codex result\n${json.slice(0, 16 * 1024)}${json.length > 16 * 1024 ? "\n[Rendered preview truncated.]" : ""}`;
  }
  const execution = objectRecord(state.execution);
  const lines = [
    `Codex execution [${screenLine(state.status ?? (data.forked ? "forked" : data.error ? "error" : "read-only"))}]`,
    `model=${screenLine(execution.model ?? state.model)} cwd=${screenLine(execution.cwd ?? state.cwd)} requestedEffort=${screenLine(execution.requestedReasoningEffort)} effectiveEffort=unknown`,
  ];
  if (state.name) lines.push(`Name: ${screenLine(state.name, 256)}`);
  if (execution.requestedServiceTier != null || execution.serviceTier != null) {
    lines.push(`Requested tier: ${screenLine(execution.requestedServiceTier)} · Effective tier: ${screenLine(execution.serviceTier)}`);
  }
  if (state.threadId) lines.push(`Thread: ${screenLine(state.threadId)} Turn: ${screenLine(state.turnId)}`);
  const usage = objectRecord(state.usage ?? state.turnUsage);
  if (typeof usage.totalTokens === "number") lines.push(`Tokens: ${usage.totalTokens.toLocaleString("en-US")} · Cost: not reported`);
  else if (expanded) lines.push("Cost: not reported by Codex");
  if (data.forked) lines.push(`Source: ${screenLine(data.sourceThreadId)} through ${screenLine(data.lastTurnId)} · direct tool · no inference started`);
  if (data.nameWarning) lines.push(`Name warning: ${screenLine(data.nameWarning, 300)}`);
  if (state.latestActivity) lines.push(`Activity: ${activityLabel(state.latestActivity)}`);
  if (state.latestPlan) lines.push(`Plan: ${screenLine(typeof state.latestPlan === "string" ? state.latestPlan : JSON.stringify(state.latestPlan), 1200)}`);
  if (Array.isArray(state.fileChanges) && state.fileChanges.length) {
    lines.push(`File changes: ${screenLine(JSON.stringify(state.fileChanges.map(changeMetadata)), 2000)} (native events; not a complete audit)`);
  }
  if (state.fileChangesOmitted) lines.push(`${state.fileChangesOmitted} file-change items omitted; inspect status/details.`);
  if (state.commandFailure) {
    const failure = objectRecord(state.commandFailure);
    lines.push(`Command failed: exit ${screenLine(failure.exitCode)}`);
    lines.push(`Output tail: ${screenLine(String(failure.outputTail ?? "").slice(-2000), 2000)}${failure.outputTruncated ? " [truncated]" : ""}`);
  }
  if (state.outcomeUnknown || data.outcomeUnknown) lines.push("Outcome unknown. Inspect status/details; never automatically retry, resume or replay.");
  if (data.error || state.error) lines.push(`Error${data.code === undefined ? "" : ` (${screenLine(data.code)})`}: ${screenLine(data.error ?? state.error, 1000)}`);
  if (typeof state.text === "string" && state.text) lines.push(`Answer: ${screenLine(state.text, 2000)}${state.text.length > 2000 ? " [expand for retained preview]" : ""}`);
  if (data.remedy) lines.push(screenLine(data.remedy, 1000));
  if (expanded) {
    const json = JSON.stringify(result, null, 2) ?? String(result);
    lines.push(json.slice(0, 16 * 1024) + (json.length > 16 * 1024 ? "\n[Rendered preview truncated; inspect explicit native details.]" : ""));
  }
  return lines.join("\n");
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
        const date = typeof window.resetsAt === "number" ? new Date(window.resetsAt * 1000) : undefined;
        const reset = date && Number.isFinite(date.getTime()) ? `, reset ${date.toISOString()}` : "";
        return [`${key} ${window.usedPercent}%${reset}`];
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
