import { realpath } from "node:fs/promises";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Job, JobsAccess } from "./jobs.ts";

type HubHandle = {
  agentId: string; jobId: string; jobStartedAt: number; sessionFile: string | null;
  sessionId?: string; generation?: number; runStartedAt?: number;
};
type HubJob = HubHandle & {
  name: string; status: "running" | "completed" | "failed" | "cancelled";
  agentStatus?: string; cwd: string; model?: string; lastActivity: number; error?: string;
};
type Source = { threadId: string; lastTurnId: string; cwd: string };
type NativeReceipt = { threadId?: string; turnId?: string | null; status?: string; activity?: string; latestActivity?: unknown; outcomeUnknown?: boolean };
type InspectSession = (sessionId: string) => NativeReceipt | undefined | Promise<NativeReceipt | undefined>;
type HubAPI = {
  list(): HubJob[];
  spawn(options: { agent: string; task: string; name: string; cwd: string; initialization: { customType: string; data: Source }[] }): Promise<HubJob>;
  focus(handle: HubHandle): Promise<void>;
  send(handle: HubHandle, message: string, options: { streamingBehavior: "steer" | "followUp" }): Promise<HubJob>;
  interrupt(handle: HubHandle): Promise<void>;
  cancel(handle: HubHandle): Promise<void>;
};
type SelectedJob = Job & { hubHandle: Readonly<HubHandle>; native?: NativeReceipt; inspectionWarning?: string };

export function hubControls(ctx: ExtensionContext): HubAPI | undefined {
  const api = (ctx as ExtensionContext & { agents?: HubAPI }).agents;
  if (!api || typeof api !== "object") return;
  const prototype = Object.getPrototypeOf(api);
  if (prototype !== Object.prototype && prototype !== null) return;
  if (["list", "spawn", "focus", "send", "interrupt", "cancel"].some(method => typeof api[method as keyof HubAPI] !== "function")) return;
  return api;
}

export function hubJobs(ctx: ExtensionContext, inspectSession?: InspectSession): JobsAccess | undefined {
  const api = hubControls(ctx);
  if (!api) return;
  return {
    async list() {
      const latest = new Map<string, HubJob>();
      for (const job of api.list()) {
        if (!latest.has(job.agentId) || latest.get(job.agentId)!.jobStartedAt <= job.jobStartedAt) latest.set(job.agentId, { ...job });
      }
      const jobs: SelectedJob[] = [];
      for (const row of latest.values()) {
        const hubHandle = Object.freeze({ ...row });
        let receipt: NativeReceipt | undefined;
        let inspectionWarning: string | undefined;
        try { receipt = hubHandle.sessionId ? await inspectSession?.(hubHandle.sessionId) : undefined; }
        catch (error) { inspectionWarning = error instanceof Error ? error.message : String(error); }
        if (row.model !== "codex-bridge" && !row.model?.startsWith("codex-bridge/") && !receipt) continue;
        const native = receipt ? Object.freeze({ ...receipt }) : undefined;
        const activity = row.error ?? inspectionWarning ?? native?.activity ?? (typeof native?.latestActivity === "string" ? native.latestActivity : undefined);
        jobs.push({ id: row.jobId, kind: "hub", name: row.name, status: !row.sessionFile && row.status === "running" ? "queued" : row.status, cwd: row.cwd,
          threadId: native?.threadId, turnId: native?.turnId ?? undefined, activity,
          canSend: Boolean(row.sessionFile) && !inspectionWarning && !native?.outcomeUnknown, canCancel: row.status === "running",
          canOpen: Boolean(row.sessionFile), hubHandle, native, inspectionWarning });
      }
      return jobs;
    },
    async details(job) { return { readOnly: true, job, native: (job as SelectedJob).native }; },
    async send(job, text) {
      return api.send((job as SelectedJob).hubHandle, text, { streamingBehavior: job.status === "running" ? "steer" : "followUp" });
    },
    async cancel(job) {
      const handle = (job as SelectedJob).hubHandle;
      return handle.sessionFile ? api.interrupt(handle) : api.cancel(handle);
    },
    async open(job) { return api.focus((job as SelectedJob).hubHandle); },
  };
}

export async function continueInHub(source: Source, question: string, ctx: ExtensionContext) {
  if (typeof question !== "string" || !question.trim()) throw new Error("Enter a non-empty question before continuing in Agent Hub.");
  if (!source || [source.threadId, source.lastTurnId, source.cwd].some(value => typeof value !== "string" || !value.trim())) {
    throw new Error("History continuation requires a source thread, finished turn and workspace.");
  }
  const api = hubControls(ctx);
  if (!api) throw new Error("This OMP host does not expose Agent Hub controls.");
  if (await realpath(source.cwd) !== await realpath(ctx.cwd)) throw new Error("Source workspace differs from the current workspace; open that workspace before continuing.");
  const boundary = { threadId: source.threadId, lastTurnId: source.lastTurnId, cwd: source.cwd };
  return api.spawn({ agent: "codex-bridge", cwd: ctx.cwd, task: question, name: question.split(/\r?\n/, 1)[0].slice(0, 120),
    initialization: [{ customType: "codex-bridge-history-fork", data: boundary }] });
}
