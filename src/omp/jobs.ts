import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { pickerLabel as label } from "./picker-label.ts";

export type Job = {
  id: string; kind: "direct" | "hub"; name: string; status: string; cwd: string;
  threadId?: string; turnId?: string; activity?: string;
  canSend: boolean; canCancel: boolean; canOpen?: boolean;
};

export type JobsAccess = {
  scope?: string;
  list(): Promise<Job[]>;
  details(job: Job): Promise<unknown>;
  send(job: Job, text: string): Promise<unknown>;
  cancel(job: Job): Promise<unknown>;
  open?(job: Job): Promise<unknown>;
};

export type JobsResult = {
  action: "list" | "details" | "send" | "cancel" | "open";
  readOnly: boolean; cancelled?: true; job?: Job; value?: unknown; error?: unknown; draft?: string;
};

export async function pickJobs(access: JobsAccess, ctx: ExtensionContext): Promise<JobsResult> {
  let action: JobsResult["action"] = "list";
  let job: Job | undefined;
  let draft: string | undefined;
  try {
    for (;;) {
      action = "list";
      job = undefined;
      // Keep the selected turn identity even if a live backend updates its objects while the UI waits.
      const jobs = (await access.list()).map(entry => Object.freeze({ ...entry }));
      if (!ctx.hasUI) return { action, readOnly: true, value: jobs };
      const labels = jobs.map((entry, index) => `${index + 1}. [${entry.kind === "hub" ? "Hub" : "direct"}] ${label(entry.name || "(unnamed)", 96)} · ${label(entry.status, 40)} · ${label(entry.cwd, 120)}`);
      const selected = await ctx.ui.select(`${jobs.length ? "Codex jobs" : "Codex jobs — no current jobs"}${access.scope ? `\n${access.scope}` : ""}`, [...labels, "Refresh", "Cancel"]);
      if (selected === "Refresh") continue;
      const index = selected === undefined ? -1 : labels.indexOf(selected);
      if (index < 0) return { action, readOnly: true, cancelled: true };
      job = jobs[index];
      const actions = ["View details", ...(job.canSend ? ["Send message"] : []),
        ...(job.canCancel ? ["Interrupt"] : []),
        ...(job.kind === "hub" && job.canOpen && access.open ? ["Open in Agent Hub"] : []),
        "Refresh", "Back", "Cancel"];
      const title = `${label(job.name || "(unnamed)")} · ${label(job.status)}\nDirectory ${label(job.cwd)}${job.activity ? `\nActivity ${label(job.activity)}` : ""}\nThread ${label(job.threadId ?? "none")} · Turn ${label(job.turnId ?? "none")}`;
      const choice = await ctx.ui.select(title, actions);
      if (choice === "Refresh" || choice === "Back") continue;
      if (choice === undefined || !actions.includes(choice) || choice === "Cancel") return { action, readOnly: true, cancelled: true, job };
      if (choice === "View details") {
        action = "details";
        return { action, readOnly: true, job, value: await access.details(job) };
      }
      if (choice === "Send message") {
        action = "send";
        draft = await ctx.ui.input(`Message to ${label(job.name || "(unnamed)")}\nThread ${label(job.threadId ?? "none")} · Turn ${label(job.turnId ?? "none")}`);
        if (draft === undefined || !draft.trim()) return { action, readOnly: true, cancelled: true, job };
        return { action, readOnly: false, job, value: await access.send(job, draft) };
      }
      if (choice === "Interrupt") {
        action = "cancel";
        return { action, readOnly: false, job, value: await access.cancel(job) };
      }
      action = "open";
      return { action, readOnly: false, job, value: await access.open!(job) };
    }
  } catch (error) {
    return { action, readOnly: action === "list" || action === "details", job, error, ...(draft === undefined ? {} : { draft }) };
  }
}
