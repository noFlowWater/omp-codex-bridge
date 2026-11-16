import type { Job, JobsAccess } from "./jobs.ts";

export function jobActions(direct: JobsAccess, hub?: JobsAccess): JobsAccess {
  function owner(job: Job) {
    if (job.kind === "direct") return direct;
    if (job.kind === "hub" && hub) return hub;
    throw new Error("Hub controls are unavailable in this OMP host; nothing sent");
  }
  return {
    scope: hub ? "Current session direct and Codex Hub jobs" : "Current session direct jobs only; this OMP host does not expose Hub controls",
    list: async () => [...await direct.list(), ...(hub ? await hub.list() : [])],
    details: job => owner(job).details(job),
    send: (job, text) => owner(job).send(job, text),
    cancel: job => owner(job).cancel(job),
    open: job => {
      const access = owner(job);
      if (!access.open) throw new Error("This job has no Hub view");
      return access.open(job);
    },
  };
}
