import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { basename, dirname, relative } from "node:path";
import type { CodexAppServerClient } from "../codex/client.mjs";
import { TERMINAL as NATIVE_TERMINAL } from "../codex/protocol.mjs";
import { historySource } from "./history.mjs";
import { pickerLabel } from "./picker-label.ts";

export type HistoryParams = {
  threadId?: string; cursor?: string; limit?: number; searchTerm?: string; cwd?: string;
  includeItems?: boolean; turnId?: string; includeDiff?: boolean;
};

export async function historyDetails(params: HistoryParams, client: CodexAppServerClient) {
  if (!params.threadId) throw new Error("details requires threadId");
  return {
    readOnly: true, inspectionOnly: true,
    ...await client.getThreadDetails(params.threadId, {
      includeItems: params.includeItems ?? Boolean(params.includeDiff), turnId: params.turnId,
      cursor: params.cursor, limit: params.limit, includeDiff: params.includeDiff,
    }),
    fileChangesNote: "Bounded native file-change events only; not a complete workspace audit. Shell/tool edits may be absent. Diffs are included only with includeDiff:true and may contain secrets.",
  };
}

// OMP draws a dialog title on one row, so details live in option descriptions and the input placeholder.
const when = (seconds: unknown) => typeof seconds === "number"
  ? new Date(seconds > 1e12 ? seconds : seconds * 1000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "time unknown";

async function pickFinishedTurn(threadId: string, firstPage: { data: { id: string; status: string; startedAt?: number | null; completedAt?: number | null }[]; nextCursor?: string | null },
  client: CodexAppServerClient, ctx: ExtensionContext) {
  let page = firstPage;
  let cursor: string | undefined;
  const previous: (string | undefined)[] = [];
  for (;;) {
    const turns = page.data.filter(turn => NATIVE_TERMINAL.has(turn.status));
    const options = turns.map((turn, index) => ({
      label: `${index + 1}. ${when(turn.completedAt ?? turn.startedAt)} · ${pickerLabel(turn.status, 32)}`,
      description: `turn ${pickerLabel(turn.id, 512)}`,
    }));
    const labels = options.map(option => option.label);
    const choice = await ctx.ui.select("Continue through a finished native turn", [...options,
      ...(previous.length ? ["Previous page"] : []), ...(page.nextCursor ? ["Next page"] : []), "Cancel"]);
    if (choice === undefined || choice === "Cancel") return;
    if (choice === "Next page") {
      if (!page.nextCursor || page.nextCursor === cursor || previous.includes(page.nextCursor)) throw new Error("Native turns returned a repeated cursor");
      previous.push(cursor);
      cursor = page.nextCursor;
    } else if (choice === "Previous page") cursor = previous.pop();
    else return turns[labels.indexOf(choice)];
    page = (await client.getThreadDetails(threadId, { limit: 100, cursor })).turns;
  }
}

export async function pickHistory(params: HistoryParams, client: CodexAppServerClient, ctx: ExtensionContext,
  fork: (params: { threadId: string; lastTurnId?: string; name?: string }) => Promise<unknown>,
  continueHistory?: (source: { threadId: string; lastTurnId: string; cwd: string }, question: string) => Promise<unknown>) {
  let cursor = params.cursor;
  const previous: (string | undefined)[] = [];
  for (;;) {
    const page = await client.listThreads({ ...params, cursor });
    const labels = page.data.map((thread, index) => {
      const path = relative(ctx.cwd, thread.cwd || ctx.cwd) || ".";
      const shortPath = path.length > 20 ? `…/${basename(dirname(path))}/${basename(path)}` : path;
      return `${index + 1}. ${pickerLabel(thread.name || thread.preview || "(unnamed)", 36)} · ${pickerLabel(shortPath, 24)}`;
    });
    const choices = [...labels, ...(previous.length ? ["Previous page"] : []),
      ...(page.nextCursor ? ["Next page"] : []), "Cancel"];
    const choice = await ctx.ui.select("Codex saved history — inspection only until you confirm a fork", choices);
    if (choice === undefined || choice === "Cancel") return { readOnly: true, cancelled: true };
    if (choice === "Next page") {
      if (!page.nextCursor || page.nextCursor === cursor || previous.includes(page.nextCursor)) throw new Error("Native history returned a repeated cursor");
      previous.push(cursor);
      cursor = page.nextCursor;
      continue;
    }
    if (choice === "Previous page") { cursor = previous.pop(); continue; }
    const index = labels.indexOf(choice);
    if (index < 0) return { readOnly: true, cancelled: true };
    const threadId = page.data[index].id;
    const details = await historyDetails({ threadId, limit: 100 }, client);
    const boundary = details.turns.data.find(turn => NATIVE_TERMINAL.has(turn.status))?.id;
    const action = await ctx.ui.select(`Saved thread ${pickerLabel(details.thread.name || threadId, 80)}`, [
      { label: "View details", description: `source ${pickerLabel(threadId, 512)}` },
      ...(continueHistory ? [{ label: "Continue in Agent Hub", description: `directory ${pickerLabel(details.thread.cwd, 512)}` }] : []),
      { label: "Fork as new direct thread", description: "no inference starts" }, "Cancel"]);
    if (action === "View details") return details;
    if (action === "Continue in Agent Hub" && continueHistory) {
      const turn = await pickFinishedTurn(threadId, details.turns, client, ctx);
      if (!turn) return { readOnly: true, cancelled: true };
      const source = historySource({ threadId, lastTurnId: turn.id, cwd: details.thread.cwd });
      const question = await ctx.ui.input("Question for a new Codex Hub child",
        `Continues from ${when(turn.completedAt ?? turn.startedAt)} in ${pickerLabel(source.cwd, 512)}; submitting starts the task, the source stays unchanged.`);
      if (!question?.trim()) return { readOnly: true, cancelled: true };
      try { return { readOnly: false, continued: true, source, child: await continueHistory(source, question) }; }
      catch (error) { return { readOnly: false, error, draft: question }; }
    }
    if (action !== "Fork as new direct thread") return { readOnly: true, cancelled: true };
    if (!boundary) throw new Error("Source has no finished turn boundary to fork");
    const confirm = await ctx.ui.select(`Fork through finished turn ${pickerLabel(boundary, 512)}?`, [
      "Cancel", { label: "Confirm fork", description: "Creates a direct-tool thread outside Agent Hub. Source stays unchanged. No inference starts." }]);
    if (confirm !== "Confirm fork") return { readOnly: true, cancelled: true };
    return fork({ threadId, lastTurnId: boundary });
  }
}

