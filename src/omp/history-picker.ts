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

async function pickFinishedTurn(threadId: string, firstPage: { data: { id: string; status: string }[]; nextCursor?: string | null },
  client: CodexAppServerClient, ctx: ExtensionContext) {
  let page = firstPage;
  let cursor: string | undefined;
  const previous: (string | undefined)[] = [];
  for (;;) {
    const turns = page.data.filter(turn => NATIVE_TERMINAL.has(turn.status));
    const labels = turns.map((turn, index) => `${index + 1}. ${pickerLabel(turn.id, 512)} · ${pickerLabel(turn.status, 512)}`);
    const choice = await ctx.ui.select("Continue through a finished native turn", [...labels,
      ...(previous.length ? ["Previous page"] : []), ...(page.nextCursor ? ["Next page"] : []), "Cancel"]);
    if (choice === undefined || choice === "Cancel") return;
    if (choice === "Next page") {
      if (!page.nextCursor || page.nextCursor === cursor || previous.includes(page.nextCursor)) throw new Error("Native turns returned a repeated cursor");
      previous.push(cursor);
      cursor = page.nextCursor;
    } else if (choice === "Previous page") cursor = previous.pop();
    else return turns[labels.indexOf(choice)]?.id;
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
    const action = await ctx.ui.select(
      `Source ${pickerLabel(threadId, 512)} | name ${pickerLabel(details.thread.name, 512)} | cwd ${pickerLabel(details.thread.cwd, 512)}`,
      ["View details", ...(continueHistory ? ["Continue in Agent Hub"] : []), "Fork as new direct thread", "Cancel"]);
    if (action === "View details") return details;
    if (action === "Continue in Agent Hub" && continueHistory) {
      const lastTurnId = await pickFinishedTurn(threadId, details.turns, client, ctx);
      if (!lastTurnId) return { readOnly: true, cancelled: true };
      const source = historySource({ threadId, lastTurnId, cwd: details.thread.cwd });
      const question = await ctx.ui.input(`Continue in a new Codex Hub child\nSource ${pickerLabel(threadId, 512)} · turn ${pickerLabel(source.lastTurnId, 512)}\nDirectory ${pickerLabel(source.cwd, 512)}\nSubmitting your question starts the new task; the source stays unchanged.`);
      if (!question?.trim()) return { readOnly: true, cancelled: true };
      try { return { readOnly: false, continued: true, source, child: await continueHistory(source, question) }; }
      catch (error) { return { readOnly: false, error, draft: question }; }
    }
    if (action !== "Fork as new direct thread") return { readOnly: true, cancelled: true };
    if (!boundary) throw new Error("Source has no finished turn boundary to fork");
    const confirm = await ctx.ui.select(
      `Fork ${pickerLabel(threadId, 512)} through finished turn ${pickerLabel(boundary, 512)}?\nCreates a direct-tool thread outside Agent Hub. Source stays unchanged. No inference starts.`,
      ["Cancel", "Confirm fork"]);
    if (confirm !== "Confirm fork") return { readOnly: true, cancelled: true };
    return fork({ threadId, lastTurnId: boundary });
  }
}

