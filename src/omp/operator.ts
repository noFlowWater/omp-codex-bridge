import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { CodexAppServerClient } from "../codex/client.mjs";
import { TERMINAL as NATIVE_TERMINAL } from "../codex/protocol.mjs";
import { utf8Preview } from "./presentation.ts";

const ERROR_BYTES = 4 * 1024;
export function errorDetails(error: unknown, threadId?: string) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const text = error instanceof Error ? error.message : String(error);
  const message = utf8Preview(text, ERROR_BYTES);
  const code = typeof record.code === "string" || typeof record.code === "number" ? record.code : undefined;
  const outcomeUnknown = record.outcomeUnknown === true;
  let remedy = "Inspect /codex doctor and the native error before submitting a new request.";
  if (outcomeUnknown) remedy = "Outcome is unknown. Inspect /codex status THREAD_ID and /codex show THREAD_ID. Do not automatically retry, resume, or replay.";
  else if (code === "ENOENT") remedy = "Install Codex and make the codex executable available on OMP's PATH; then run /codex doctor.";
  else if (/auth|login|unauthorized|401/i.test(text)) remedy = "Check native Codex login outside this bridge, then run /codex doctor. No credentials are changed here.";
  else if (code === -32601) remedy = "This native API is unsupported by the installed Codex version. Check /codex doctor and update Codex if needed.";
  else if (code === "THREAD_NOT_OWNED") remedy = "Inspect with /codex show THREAD_ID. To work again, start a new thread without threadId; inspection never grants ownership.";
  else if (/permission|sandbox|approval/i.test(text)) remedy = "Inspect /codex doctor permissions and native policy. The bridge does not relax permissions or retry admission.";
  else if (/model/i.test(text)) remedy = "Inspect /codex doctor models and select a model available to the signed-in native account.";
  return {
    threadId: typeof record.threadId === "string" ? record.threadId : threadId,
    code, error: message.text + (message.truncated ? "…" : ""), errorTruncated: message.truncated,
    outcomeUnknown, state: record.codexState, remedy,
  };
}

export type OperatorParams = {
  threadId?: string; cursor?: string; limit?: number; searchTerm?: string; cwd?: string;
  includeItems?: boolean; turnId?: string; includeDiff?: boolean;
};

async function readHostSettings(pi: ExtensionAPI, ctx: ExtensionContext) {
  try {
    // Optional host SDK subpath is absent in older hosts; static import would prevent extension loading.
    const [{ lookup }, { findScopedSettings }] = await Promise.all([
      import("@oh-my-pi/pi-coding-agent/config/registry"),
      import("@oh-my-pi/pi-coding-agent/config/settings"),
    ]);
    const settings = findScopedSettings(ctx.cwd);
    if (!settings) return { status: "unavailable", reason: "No active read-only OMP settings scope is available for this session." };
    const steeringMode = lookup("steeringMode")?.get(settings);
    const liveSteering = lookup("providers.openaiLiveSteering")?.get(settings);
    const perCallModel = lookup("task.perCallModel")?.get(settings);
    const allow = lookup("task.perCallModelAllow")?.get(settings);
    const overrides = lookup("task.agentModelOverrides")?.get(settings);
    const override = overrides && typeof overrides === "object"
      ? (overrides as Record<string, unknown>)["codex-bridge"] : undefined;
    return {
      status: "available", scope: "host active settings via public SDK registry",
      steeringMode: steeringMode === "all" || steeringMode === "one-at-a-time" ? steeringMode : "unknown",
      openaiLiveSteering: typeof liveSteering === "boolean" ? liveSteering : "unknown",
      modelSelection: {
        perCallModel: typeof perCallModel === "boolean" || typeof perCallModel === "string" ? perCallModel : "unknown",
        perCallModelAllow: Array.isArray(allow)
          ? { status: "available", configured: allow.length > 0, codexBridgeSelectors: allow.filter((value): value is string =>
            typeof value === "string" && (value.startsWith("codex-bridge/") || value === "*")).slice(0, 100) }
          : { status: "unavailable", reason: "Host SDK setting is unavailable or has an unsupported shape." },
        codexBridgeOverride: overrides === undefined ? "unknown" : override === undefined ? null : Array.isArray(override)
          ? override.filter((value): value is string => typeof value === "string").slice(0, 100).map(value => value.slice(0, 256))
          : typeof override === "string" ? override.slice(0, 256) : "unknown",
        approvedAgentSelectors: { status: "unavailable", reason: "The public extension context exposes no read-only installed-agent model-grant reader. Native model discovery does not grant per-call permission." },
        remedy: "Per-task models need task.perCallModel enabled, an exact installed-agent selector grant, and any task.perCallModelAllow grant. A codex-bridge task.agentModelOverrides entry conflicts with per-call model selection; inspect settings without automatic changes.",
      },
      note: "Native direct run steers only its locally owned active turn. OMP running-task steering also depends on the host's effective providers.openaiLiveSteering setting.",
    };
  } catch (error) {
    return { status: "unavailable", error: errorDetails(error), remedy: "Use OMP's settings UI to inspect effective steering settings; this command writes no settings." };
  }
}

export async function diagnose(pi: ExtensionAPI, ctx: ExtensionContext, client: CodexAppServerClient) {
  const [native, executable, steering] = await Promise.all([
    client.inspectConnection(),
    (async () => {
      try {
        const result = await pi.exec("codex", ["--version"], { timeout: 10_000 });
        return result.code === 0
          ? { status: "available", version: result.stdout.trim().slice(0, 256) }
          : { status: "unavailable", exitCode: result.code, remedy: "Run codex --version outside OMP and check PATH; no server request was retried." };
      } catch (error) { return { status: "unavailable", error: errorDetails(error) }; }
    })(),
    readHostSettings(pi, ctx),
  ]);
  return {
    readOnly: true, ompVersion: pi.pi?.VERSION ?? "unknown", executable, ...native, steering,
    permissionSource: "native-config",
    permissionsNote: "Native Codex configuration and optional operator overrides determine sandbox, network and approval policy. Read-only diagnostics do not prove future admission. Approval requests require explicit user confirmation; unavailable UI declines them.",
    remedies: {
      auth: "If unauthenticated, use native Codex login outside this bridge, then run /codex doctor.",
      models: "Select a model from the native catalog. Availability does not guarantee future quota or admission.",
      permissions: "Inspect effective native config, operator overrides and requirements. This bridge does not automatically relax policy or retry admission.",
      steering: "Inspect effective OMP steering settings in the host settings UI. No steering request is sent by doctor.",
    },
  };
}

export async function readOnlyAction(action: string, params: OperatorParams, client: CodexAppServerClient, pi: ExtensionAPI, ctx: ExtensionContext) {
  switch (action) {
    case "diagnose": return diagnose(pi, ctx, client);
    case "history": return { readOnly: true, ...await client.listThreads({ cursor: params.cursor, limit: params.limit, searchTerm: params.searchTerm, cwd: params.cwd }) };
    case "details": {
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
    default: throw new Error(`Unknown read-only action: ${action}`);
  }
}

const HELP = "Usage: /codex doctor | status [THREAD_ID] | history [--json] [JSON options] | show THREAD_ID [JSON options] | fork THREAD_ID [JSON options] | tier [inherit|default|flex|scale|priority|ultrafast|auto]. tier reads/sets the OpenAI-family setting for this OMP session. Interactive history offers details or an explicitly confirmed fork; --json and headless history return JSON. Fork options: lastTurnId, name; creates a direct-tool thread, not an Agent Hub worker, without starting inference. Status without ID lists locally loaded direct-tool threads only. History options: cursor, limit, searchTerm, cwd. Show options: includeItems, turnId, cursor, limit, includeDiff. Inspection never resumes, adopts or replays a thread. Diff output may contain secrets.";

// Escape controls and directional overrides before native history enters terminal labels.
const historyLabel = (value: unknown) => JSON.stringify(utf8Preview(String(value ?? ""), 512).text)
  .replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

async function pickHistory(params: OperatorParams, client: CodexAppServerClient, pi: ExtensionAPI, ctx: ExtensionContext,
  fork: (params: { threadId: string; lastTurnId?: string; name?: string }) => Promise<unknown>) {
  let cursor = params.cursor;
  const previous: (string | undefined)[] = [];
  for (;;) {
    const page = await client.listThreads({ ...params, cursor });
    const labels = page.data.map((thread, index) =>
      `${index + 1}. ${historyLabel(thread.name || thread.preview || thread.id)} | cwd ${historyLabel(thread.cwd)} | ${historyLabel(thread.id)}`);
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
    const details = await readOnlyAction("details", { threadId, limit: 100 }, client, pi, ctx);
    const boundary = details.turns.data.find(turn => NATIVE_TERMINAL.has(turn.status))?.id;
    const action = await ctx.ui.select(
      `Source ${historyLabel(threadId)} | name ${historyLabel(details.thread.name)} | cwd ${historyLabel(details.thread.cwd)}`,
      ["View details", "Fork as new direct thread", "Cancel"]);
    if (action === "View details") return details;
    if (action !== "Fork as new direct thread") return { readOnly: true, cancelled: true };
    if (!boundary) throw new Error("Source has no finished turn boundary to fork");
    const confirm = await ctx.ui.select(
      `Fork ${historyLabel(threadId)} through finished turn ${historyLabel(boundary)}?\nCreates a direct-tool thread outside Agent Hub. Source stays unchanged. No inference starts.`,
      ["Cancel", "Confirm fork"]);
    if (confirm !== "Confirm fork") return { readOnly: true, cancelled: true };
    return fork({ threadId, lastTurnId: boundary });
  }
}

export function registerOperator(pi: ExtensionAPI, access: {
  getClient(): Promise<CodexAppServerClient>;
  status(threadId?: string): Promise<unknown>;
  fork(params: { threadId: string; lastTurnId?: string; name?: string }): Promise<unknown>;
}) {
  const z = pi.zod;
  const page = { cursor: z.string().min(1).optional(), limit: z.number().int().min(1).max(100).optional() };
  const history = z.object({ ...page, searchTerm: z.string().min(1).optional(), cwd: z.string().min(1).optional() }).strict();
  const details = z.object({ ...page, includeItems: z.boolean().optional(), includeDiff: z.boolean().optional(), turnId: z.string().min(1).optional() }).strict();
  const forkOptions = z.object({ lastTurnId: z.string().min(1).optional(), name: z.string().min(1).optional() }).strict();
  const tierChoices = ["inherit", "default", "flex", "scale", "priority", "ultrafast", "auto"] as const;
  const tiers = z.enum(tierChoices);
  pi.registerCommand("codex", {
    description: "Codex doctor, status, saved history picker, details and explicit direct-thread fork; /codex for help",
    handler: async (args, ctx) => {
      let selectedThreadId: string | undefined;
      try {
        const [command = "help", rest = ""] = (args.trim() || "help").split(/\s+(.*)/s);
        let result: unknown;
        let label = command;
        if (command === "doctor") {
          if (rest) throw new Error("doctor takes no arguments");
          result = await readOnlyAction("diagnose", {}, await access.getClient(), pi, ctx);
        } else if (command === "history") {
          const raw = rest === "--json" || rest.startsWith("--json ");
          const input = raw ? rest.slice(6).trim() : rest;
          const params = history.parse(input ? JSON.parse(input) : {});
          const client = await access.getClient();
          result = ctx.hasUI && !raw ? await pickHistory(params, client, pi, ctx, access.fork) : await readOnlyAction("history", params, client, pi, ctx);
        } else if (command === "fork") {
          const [threadId, options = ""] = rest.trim().split(/\s+(.*)/s);
          if (!threadId) throw new Error("fork requires THREAD_ID");
          selectedThreadId = threadId;
          result = await access.fork({ threadId, ...forkOptions.parse(options ? JSON.parse(options) : {}) });
        } else if (command === "tier") {
          const current = pi.getServiceTiers().openai;
          const selected = rest || (ctx.hasUI ? await ctx.ui.select(
            `OpenAI-family service tier for this OMP session (current: ${current ?? "inherit"}). Native account/model availability applies.`,
            [...tierChoices]) : undefined);
          if (selected === undefined) {
            result = { readOnly: true, serviceTier: current ?? "inherit", scope: "OpenAI-family setting for this OMP session", ...(ctx.hasUI ? { cancelled: true } : {}) };
          } else {
            const tier = tiers.parse(selected);
            await pi.setServiceTier("openai", tier === "inherit" ? undefined : tier);
            result = { readOnly: false, serviceTier: tier, scope: "OpenAI-family setting for this OMP session", note: "Native tier availability, quota use and charges depend on the account/model. auto/inherit preserve native defaults; direct-tool serviceTier is per-call." };
          }
        } else if (command === "show") {
          const [threadId, options = ""] = rest.trim().split(/\s+(.*)/s);
          if (!threadId) throw new Error("show requires THREAD_ID");
          selectedThreadId = threadId;
          const params = details.parse(options ? JSON.parse(options) : {});
          result = await readOnlyAction("details", { ...params, threadId }, await access.getClient(), pi, ctx);
          label = "details";
        } else if (command === "status") {
          if (/\s/.test(rest.trim())) throw new Error("status accepts one THREAD_ID");
          selectedThreadId = rest || undefined;
          result = rest ? await access.status(rest) : {
            scope: "Locally loaded direct-tool threads only; use history or status THREAD_ID for Hub/saved threads.",
            threads: await access.status(),
          };
        } else {
          if (command !== "help") throw new Error(HELP);
          pi.sendMessage({ customType: "codex-bridge-operator", content: HELP, display: true }, { triggerTurn: false });
          return;
        }
        const readOnly = !(result && typeof result === "object" && ("forked" in result || ("readOnly" in result && result.readOnly === false)));
        pi.sendMessage({ customType: "codex-bridge-operator", content: `Codex ${label}${readOnly ? " (read-only)" : ""}:\n${JSON.stringify(result, null, 2)}`, display: true }, { triggerTurn: false });
      } catch (error) {
        pi.sendMessage({ customType: "codex-bridge-operator", content: `Codex operator error:\n${JSON.stringify(errorDetails(error, selectedThreadId), null, 2)}`, display: true }, { triggerTurn: false });
      }
    },
  });
}

