import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { join } from "node:path";
import { CODEX_BRIDGE_API, CODEX_BRIDGE_MODELS, CODEX_BRIDGE_PROVIDER, createCodexBridgeProvider, fetchCodexModels } from "../src/omp/provider.mjs";
import { captureRoot, releaseRoot, createRequestParsers, onRequest } from "../src/omp/dialogs.ts";
import { registerDirectTool } from "../src/omp/direct-tool.ts";
import { createProgressDisplay } from "../src/omp/presentation.ts";
import { registerOperator } from "../src/omp/operator.ts";
import { jobActions } from "../src/omp/job-actions.ts";
import { hubControls, hubJobs, continueInHub } from "../src/omp/hub.ts";

const progressDisplay = createProgressDisplay();

// Module scope: every session's factory registers this one function, so the process-global
// custom-API entry (last registration wins) always reaches the full per-session table.
// Session records live in the active OMP agent directory, never beside this extension's checkout.
const streamSimple = createCodexBridgeProvider({
  EventStream: AssistantMessageEventStream,
  stateDir: process.env.OMP_CODEX_BRIDGE_STATE_DIR || join(getAgentDir(), "codex-bridge-state"),
  onRequest,
  onProgress: progressDisplay.update,
  onRateLimits: progressDisplay.rateLimits,
  onNotice: progressDisplay.notify,
});

export default function (pi: ExtensionAPI) {
  // The Codex-backed task agent (agents/codex-bridge.md) runs on this provider; Codex keeps the
  // tool loop and configured permissions; OMP sees assistant events only. The
  // static `default` id runs Codex's default model; discovery (native model/list, cached by OMP)
  // adds one profile per native model slug.
  pi.registerProvider(CODEX_BRIDGE_PROVIDER, {
    baseUrl: "https://codex-bridge.invalid/",
    apiKey: "codex-bridge-uses-codex-login",
    api: CODEX_BRIDGE_API,
    streamSimple,
    models: CODEX_BRIDGE_MODELS,
    fetchDynamicModels: () => fetchCodexModels(),
  });

  const parsers = createRequestParsers(pi.zod);
  const direct = registerDirectTool(pi, { onRateLimits: progressDisplay.rateLimits });
  const { shutdown } = direct;
  registerOperator(pi, {
    ...direct.access,
    jobs: ctx => jobActions(direct.access.directJobs, hubJobs(ctx, streamSimple.inspectSession)),
    continueHistory: ctx => hubControls(ctx) ? (source, question) => continueInHub(source, question, ctx) : undefined,
  });
  let preparedBranch;

  pi.on("session_start", (_event, ctx) => {
    captureRoot(ctx, parsers);
    progressDisplay.capture(ctx);
  });
  pi.on("session_switch", async (event, ctx) => {
    const stopped = shutdown();
    if (event.reason === "fork") streamSimple.adoptBranch(preparedBranch, ctx);
    preparedBranch = undefined;
    captureRoot(ctx, parsers);
    progressDisplay.capture(ctx);
    await stopped;
  });
  pi.on("session_before_switch", async (event, ctx) => {
    preparedBranch = event.reason === "fork" ? await streamSimple.prepareBranch(event, ctx) : undefined;
    if (preparedBranch?.cancel) return { cancel: true };
    if (ctx.agent.kind === "main") {
      releaseRoot();
      progressDisplay.release(ctx);
    }
    await streamSimple.close(ctx.sessionManager.getSessionId());
  });
  pi.on("session_before_branch", async (event, ctx) => {
    preparedBranch = await streamSimple.prepareBranch(event, ctx);
    if (preparedBranch?.cancel) return { cancel: true };
  });
  pi.on("session_branch", async (_event, ctx) => {
    await shutdown();
    if (preparedBranch?.sourceId) await streamSimple.close(preparedBranch.sourceId);
    streamSimple.adoptBranch(preparedBranch, ctx);
    preparedBranch = undefined;
    captureRoot(ctx, parsers);
    progressDisplay.capture(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    captureRoot(ctx, parsers);
    progressDisplay.capture(ctx);
  });
  pi.on("session_before_compact", (event, ctx) => streamSimple.beforeCompact(event, ctx));
  pi.on("session_compact", (event, ctx) => streamSimple.afterCompact(event, ctx));
  pi.on("session_before_tree", (event, ctx) => streamSimple.beforeTree(event, ctx));
  pi.on("session_tree", (event, ctx) => streamSimple.afterTree(event, ctx));
  pi.on("context", (event, ctx) => streamSimple.context(event, ctx));
  pi.on("before_provider_request", (event, ctx) => streamSimple.beforeProviderRequest(event, ctx, {
    serviceTier: pi.getServiceTiers().openai,
  }));
  pi.on("session_clear", async (_event, ctx) => {
    if (ctx.agent.kind === "main") {
      releaseRoot();
      progressDisplay.release(ctx);
    }
    await streamSimple.clear(ctx.sessionManager.getSessionId());
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx?.agent.kind === "main") {
      releaseRoot(ctx);
      progressDisplay.release(ctx);
    }
    if (ctx) await streamSimple.close(ctx.sessionManager.getSessionId());
    await shutdown();
  });
}
