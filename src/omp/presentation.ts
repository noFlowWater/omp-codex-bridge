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
  threadId: string; turnId: string | null; status: string;
  text?: string; textTruncated?: boolean; error?: string | null; outcomeUnknown?: boolean;
  model?: string | null; execution?: unknown; latestActivity?: unknown; latestPlan?: unknown;
  fileChanges?: unknown; commandFailure?: unknown;
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
  const changes = Array.isArray(state.fileChanges) ? state.fileChanges : [];
  const fileChanges = changes.slice(0, 5).map(change => bounded(changeMetadata(change), budget))
    .filter(change => change && typeof change === "object");
  const result = {
    threadId: state.threadId, turnId: state.turnId, status: state.status,
    outcomeUnknown: Boolean(state.outcomeUnknown), model: utf8Preview(state.model, 256).text || null,
    execution, latestActivity, latestPlan, fileChanges, commandFailure,
    fileChangesOmitted: changes.length - fileChanges.length,
    error: error && (error.truncated ? `${error.text}…` : error.text), text: text.text,
    truncated: text.truncated || Boolean(state.textTruncated) || Boolean(error?.truncated),
    metadataTruncated: budget.left <= 0 || changes.length > fileChanges.length,
    full: `codex_bridge {"action":"status","threadId":${JSON.stringify(state.threadId)}}`,
  };
  // Include JSON escaping/indentation in the budget; reserve 4 KiB for host envelopes.
  const encoder = new TextEncoder();
  for (const field of ["text", "latestPlan", "fileChanges", "latestActivity", "commandFailure", "execution", "error"] as const) {
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
    `Codex execution [${screenLine(state.status ?? (data.error ? "error" : "read-only"))}]`,
    `model=${screenLine(execution.model ?? state.model)} cwd=${screenLine(execution.cwd ?? state.cwd)} requestedEffort=${screenLine(execution.requestedReasoningEffort)} effectiveEffort=unknown`,
  ];
  if (state.threadId) lines.push(`Thread: ${screenLine(state.threadId)} Turn: ${screenLine(state.turnId)}`);
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

// OMP 18.20.3 displays only the first ten widget strings. Two four-line entries leave one summary line.
export function createProgressDisplay() {
  const active = new Map<string, ProgressStatus>();
  let root: ExtensionContext | undefined;
  function render() {
    if (!root?.hasUI) return;
    const entries = [...active.values()].reverse();
    const lines = entries.slice(0, 2).flatMap(status => [
      `Codex activity [${screenLine(status.status, 40)}] ${screenLine(status.threadId, 80)}`,
      `model=${screenLine(status.execution?.model, 120)} cwd=${screenLine(status.execution?.cwd, 240)} requestedEffort=${screenLine(status.execution?.requestedReasoningEffort, 40)} effectiveEffort=unknown`,
      `Activity: ${screenLine(status.activity, 500)}`,
      `Plan: ${screenLine(status.plan, 400)}${status.logTruncated ? " | Progress log truncated; latest activity remains here. /codex show THREAD_ID for native details." : ""}`,
    ]);
    if (entries.length > 2) lines.push(`${entries.length - 2} more active Codex sessions omitted; newest activity shown first.`);
    root.ui.setWidget("codex-bridge-progress", lines.length ? lines : undefined);
  }
  return {
    update(sessionId: string, status?: ProgressStatus) {
      if (status) {
        active.delete(sessionId);
        active.set(sessionId, status);
        if (active.size > 32) active.delete(active.keys().next().value!);
      } else active.delete(sessionId);
      render();
    },
    capture(ctx: ExtensionContext) {
      if (ctx.agent.kind !== "main") return;
      if (root && root.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) {
        if (root.hasUI) root.ui.setWidget("codex-bridge-progress", undefined);
        active.clear();
      }
      root = ctx;
      render();
    },
    release(ctx?: ExtensionContext) {
      if (!root || (ctx && root.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId())) return;
      if (root.hasUI) root.ui.setWidget("codex-bridge-progress", undefined);
      root = undefined;
      active.clear();
    },
  };
}
