// TEST-ONLY real-OMP smoke for the codex-bridge task agent: no model inference, no real Codex.
// `bun hub-smoke.mjs <mode>`: TUI steering/revival, RPC questions/cancellation, rich output and lifecycle.
// test-only orchestrator provider makes the parent emit one real `task` call spawning `codex-bridge`;
// the child runs the production provider against the fake app-server. Assertions read the fake
// server's protocol trace (what Codex would have received) plus OMP's own TUI paint (OMP_TUI_DEBUG
// socket) or RPC responses. Painted frames are printed for review; their wording is not asserted
// beyond the agent id. Exit 0 = all assertions held. OMP runs with HOME/XDG directories inside the
// fixture directory (see hub-fixture.sh), which is removed on success and kept (path printed) on failure.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "tui-steer";
const QUESTION_MODES = ["rpc-question", "rpc-question-ask", "rpc-question-cancel", "rpc-question-headless", "rpc-elicitation", "rpc-async-question"];
if (!["tui-steer", "tui-followup", "tui-kill", "tui-revive", "tui-question", "tui-clear", "rpc", "rpc-queued", "rpc-model", "rpc-removed-sandbox", "rpc-rich", "rpc-direct-rich", "rpc-lifecycle", ...QUESTION_MODES].includes(mode)) throw new Error(`unknown mode ${mode}`);
const AGENT = "codex-bridge";
// rpc-model: the task item picks one concrete native model with OMP's per-call `model` selector. The fake
// native model/list serves the real slug list in pages of 3; the grant comes from the production agent
// frontmatter, the fixture config only opens the gate and allowlists this one selector.
const NATIVE_MODEL = mode === "rpc-model" ? "gpt-6-astra" : undefined;
const SELECTOR = NATIVE_MODEL && `codex-bridge/${NATIVE_MODEL}`;
const NATIVE_MODELS = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const FIX = mkdtempSync(join(tmpdir(), "codex-hub-smoke-"));
const SCRIPT = join(import.meta.dir, "hub-fixture.sh");
const CHILD = "CodexChild";
const STEER = "fixture steer: also list hidden files";
// Short unique marker: the follow-up is typed into the idle focused child after its first native turn ended.
const FOLLOWUP = "fixture-followup-42";
// Task context as delegating agents write it, sent through the real task tool so OMP's own subagent
// template renders it; it must reach Codex whole in the first thread's developerInstructions.
const CONTEXT = [
  "Codex Hub fixture context 6d1f (test-only).",
  "# Contract",
  "- keep `parse(input: string)` stable",
  "```ts",
  "export const LIMIT = 4096;",
  "```",
  "⁂ Role",
  "Nested delegation notes from the parent (quoted).",
  "§ Context",
  "한글 ✓ 🙂 final line 6d1f",
].join("\n");
const OUTPUT_SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const IMAGE_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYQ0AAAAASUVORK5CYII=";
const IMAGE_URL = `data:image/png;base64,${IMAGE_DATA}`;
const DIRECT_RICH = { action: "run", input: [{ type: "text", text: "fixture direct rich input" }, { type: "image", url: IMAGE_URL }], effort: "high", outputSchema: OUTPUT_SCHEMA };

const trace = () => {
  const path = join(FIX, "trace.jsonl");
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
};
const sent = (method) => trace().filter(({ message }) => message?.method === method).map(({ message }) => message.params);
const counts = () => Object.fromEntries(
  ["thread/start", "thread/resume", "turn/start", "turn/steer", "turn/interrupt"].map(method => [method, sent(method).length]),
);

async function until(what, probe, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; native calls ${JSON.stringify(counts())}`);
    await Bun.sleep(100);
  }
}

// Native protocol invariants shared by every mode: one thread, the expected turn count, approvals never,
// and workspace-write confined to the child cwd (the parent's cwd) with network and temp dirs off.
function assertSingleWorkspaceTurn(turns = 1, resumes = 0) {
  const work = realpathSync(join(FIX, "work"));
  const [start] = sent("thread/start");
  assert.equal(start.sandbox, "workspace-write");
  assert.equal(start.approvalPolicy, "never");
  // The child shares the parent's cwd (no isolation) in every mode.
  assert.equal(start.cwd, work);
  for (const resume of sent("thread/resume")) assert.deepEqual([resume.sandbox, resume.approvalPolicy, resume.cwd], ["workspace-write", "never", work]);
  // Without a per-call model Codex's configured default runs: no `model` is sent at all.
  for (const params of [...sent("thread/start"), ...sent("thread/resume"), ...sent("turn/start")]) {
    if (NATIVE_MODEL) assert.equal(params.model, NATIVE_MODEL, "selected native model on every native request");
    else assert.ok(!("model" in params), `default model overridden: ${JSON.stringify(params.model)}`);
  }
  const firstInput = sent("turn/start")[0].input.map((part) => part.text ?? "").join("\n");
  assert.ok(typeof start.developerInstructions === "string" && start.developerInstructions.includes(CONTEXT), `task context not delivered whole in initial native instructions:\n${start.developerInstructions}`);
  assert.equal(start.developerInstructions.split(CONTEXT).length - 1, 1, "shared context is admitted exactly once");
  assert.ok(firstInput.includes("Inspect the current directory without edits and report what you find."), "the initial native turn contains the actual task");
  for (const params of [...sent("turn/start"), ...sent("turn/steer")]) {
    assert.ok(!JSON.stringify(params).includes("6d1f"), "shared context must not be replayed as native turn input or steering");
  }
  for (const turn of sent("turn/start")) {
    assert.deepEqual(turn.sandboxPolicy, { type: "workspaceWrite", writableRoots: [work], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
  }
  assert.equal(sent("thread/start").length, 1, "one native thread per child session");
  assert.equal(sent("thread/resume").length, resumes, "the live child keeps its loaded thread; only a revived one resumes it");
  assert.equal(sent("turn/start").length, turns, "no duplicate native turn (yield reminder, retry or queued steer)");
}

async function tui() {
  const socket = join(FIX, "tui.sock");
  const output = [];
  const proc = Bun.spawn([SCRIPT], {
    env: { ...process.env, CODEX_HUB_FIXTURE_DIR: FIX, OMP_TUI_DEBUG: socket, CODEX_HUB_FIXTURE_CONTEXT: CONTEXT,
      ...(mode === "tui-question" ? { CODEX_HUB_FIXTURE_OPTIONS: '{"turns":["question"]}' } : {}),
      ...(mode === "tui-clear" ? { CODEX_HUB_FIXTURE_ROOT_MODEL: "codex-bridge/default", CODEX_HUB_FIXTURE_OPTIONS: '{"turns":["rich-output","finish-later","finish-later"]}', CODEX_HUB_FIXTURE_KEEP_RECENT_TOKENS: "1" } : {}),
    },
    terminal: { cols: 160, rows: 48, data: (_terminal, data) => { output.push(new TextDecoder().decode(data)); } },
  });
  try {
    await until("TUI debug socket", () => existsSync(socket));
    const connection = createConnection(socket);
    const replies = createInterface({ input: connection })[Symbol.asyncIterator]();
    // Bounded like the RPC calls: a stuck TUI fails the smoke instead of hanging it.
    const reply = async (request) => {
      connection.write(`${JSON.stringify(request)}\n`);
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`tui ${request.op}: no reply in 15000 ms`)), 15000); });
      try {
        const { value } = await Promise.race([replies.next(), timeout]);
        return { value, parsed: JSON.parse(value) };
      } finally {
        clearTimeout(timer);
      }
    };
    const ask = async (request) => {
      const { value, parsed } = await reply(request);
      assert.equal(parsed.ok, true, `${JSON.stringify(request)} -> ${value}`);
      return parsed;
    };
    const screen = async () => (await ask({ op: "frame" })).lines.join("\n");
    const show = async (label) => console.log(`--- ${label} ---\n${await screen()}`);
    // op:"frame" is the base document render (tui.ts getDebugDocument); overlays such as the Agent Hub
    // appear only in the last painted lines, op:"text" (getDebugPaint).
    const painted = async () => (await ask({ op: "text" })).lines.join("\n");
    const showPainted = async (label) => console.log(`--- ${label} (painted) ---\n${await painted()}`);
    await until("first paint", async () => (await reply({ op: "text" })).parsed.ok);

    const clearBefore = "fixture-native-before-clear-29e5";
    const clearAfter = "fixture-native-after-clear-71a3";
    await ask({ op: "paste", text: mode === "tui-clear" ? clearBefore : "Run the Codex hub fixture." });
    await ask({ op: "keys", keys: "enter" });
    // The child provider reached the fake app-server; the `work` turn stays active.
    await until("native turn/start", () => sent("turn/start").length === 1);
    if (mode === "tui-clear") {
      await until("first native root answer painted", async () => (await screen()).includes("final answer"));
      const sessionRoot = join(FIX, "home", ".omp", "agent", "sessions");
      const journal = await until("native root journal", () => existsSync(sessionRoot) && readdirSync(sessionRoot, { recursive: true })
        .filter(name => name.endsWith(".jsonl")).map(name => join(sessionRoot, name))
        .find(path => readFileSync(path, "utf8").includes(clearBefore)));
      const entries = () => {
        const text = readFileSync(journal, "utf8");
        return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
      };
      const sessionId = entries().find(entry => entry.type === "session").id;
      // A real earlier completed turn and an explicit small retained tail satisfy OMP's
      // prepareCompaction precondition before the native extension hook is reached.
      const clearReady = "fixture-native-clear-retained-tail-41bd";
      await ask({ op: "paste", text: clearReady });
      await ask({ op: "keys", keys: "enter" });
      await until("second real root turn before compaction", () => sent("turn/start").length === 2);
      await until("second root answer painted", async () => (await screen()).split(clearReady).length - 1 >= 2);
      await ask({ op: "paste", text: "/compact" });
      await ask({ op: "keys", keys: "enter" });
      const compacted = await until("native opaque compaction persisted", () => entries().find(entry => entry.type === "compaction" && entry.preserveData?.codexNative));
      const oldThreadId = sent("turn/start")[0].threadId;
      assert.equal(compacted.preserveData.codexNative.threadId, oldThreadId);
      assert.equal(sent("thread/compact/start").length, 1);
      assert.equal(sent("turn/start").length, 2, "compaction must not generate a loading prompt");
      const oldThread = JSON.parse(readFileSync(join(FIX, "store.json"), "utf8")).threads[oldThreadId];
      await ask({ op: "paste", text: "/clear" });
      await ask({ op: "keys", keys: "enter" });
      await until("real /clear reset boundary persisted", () => entries().find(entry => entry.type === "reset_boundary"));
      await until("real /clear painted", async () => (await screen()).includes("Context reset"));
      const afterClear = entries();
      assert.equal(afterClear.find(entry => entry.type === "session").id, sessionId, "/clear keeps the same journal session");
      assert.ok(afterClear.findIndex(entry => entry.type === "reset_boundary") > afterClear.findIndex(entry => entry.id === compacted.id), "reset follows the old opaque compaction");
      assert.ok(afterClear.some(entry => entry.type === "message" && JSON.stringify(entry.message).includes(clearBefore)), "/clear retains old persisted messages");
      assert.ok(afterClear.some(entry => entry.id === compacted.id), "/clear retains old persisted opaque metadata");
      await ask({ op: "paste", text: clearAfter });
      await ask({ op: "keys", keys: "enter" });
      const turns = await until("fresh native turn after /clear", () => sent("turn/start").length >= 3 ? sent("turn/start") : undefined);
      await until("fresh native answer painted", async () => (await screen()).split(clearAfter).length - 1 >= 2);
      assert.equal(sent("thread/start").length, 2, "/clear creates exactly one new native thread");
      assert.equal(turns.length, 3, "two preparation turns and one fresh turn; no hidden clear/replay input");
      assert.notEqual(turns[2].threadId, oldThreadId);
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(FIX, "store.json"), "utf8")).threads).sort(), [oldThreadId, turns[2].threadId].sort(), "only the old thread and one fresh thread exist");
      assert.equal(sent("thread/resume").length, 0, "/clear must not resume an old opaque anchor");
      assert.equal(sent("thread/fork").length, 0, "/clear must not fork an old opaque anchor");
      assert.equal(sent("turn/steer").length, 0);
      assert.equal(turns.filter(turn => turn.threadId === oldThreadId).length, 2, "old native thread receives no new input");
      assert.ok(JSON.stringify(turns[2].input).includes(clearAfter));
      const freshAdmission = JSON.stringify([...sent("thread/start").slice(1), turns[2]]);
      assert.ok(!freshAdmission.includes(clearBefore) && !freshAdmission.includes(clearReady), "old prompts are not replayed after the reset boundary");
      assert.deepEqual(JSON.parse(readFileSync(join(FIX, "store.json"), "utf8")).threads[oldThreadId], oldThread, "old native records survive unchanged");
      assert.equal(entries().find(entry => entry.type === "session").id, sessionId);
      await show("native root after the real /clear command");
      return;
    }
    await until("child row", async () => (await screen()).includes(CHILD));
    await show("main session with running child");
    if (mode === "tui-question") {
      await until("root TUI question painted", async () => (await painted()).includes("Which environment?"));
      await showPainted("native question in main TUI");
      await ask({ op: "keys", keys: "enter" });
      const response = await until("TUI answer reaches native request", () => trace().find(({ message }) => message?.id === 901 && !message.method)?.message);
      assert.deepEqual(response.result, { answers: { environment: { answers: ["Staging"] } } });
      assertSingleWorkspaceTurn();
      return;
    }

    // Double-left on the empty main editor opens Agent Hub; Enter focuses the selected (only) child.
    // Acceptance is the painted Hub (op:"text", the last painted lines including overlays): its titled
    // border (agent-hub.ts topBorder "Agent Hub") and the child row. OMP 18.20 opens it only for exactly
    // two taps 40–500 ms apart (input-controller.ts:275-276, #detectLeftDoubleTap), only while the main
    // editor is focused and empty (onLeftAtStart, input-controller.ts:804-812).
    const before = await ask({ op: "info" });
    const paintedBefore = await painted();
    const tapStart = Date.now();
    await ask({ op: "bytes", data: "\x1b[D" });
    const firstTapMs = Date.now() - tapStart;
    await Bun.sleep(150);
    const secondTapAt = Date.now() - tapStart;
    await ask({ op: "bytes", data: "\x1b[D" });
    const secondTapDoneMs = Date.now() - tapStart;
    try {
      await until("Agent Hub painted", async () => { const text = await painted(); return text.includes("Agent Hub") && text.includes(CHILD); }, 15000);
    } catch (error) {
      console.error(`--- gesture diagnostics ---\ntaps: first acked ${firstTapMs} ms, second sent ${secondTapAt} ms, acked ${secondTapDoneMs} ms`);
      console.error(`info before: ${JSON.stringify(before)}\ninfo after: ${JSON.stringify(await ask({ op: "info" }))}`);
      console.error(`--- painted before gesture ---\n${paintedBefore}\n--- painted after gesture ---\n${await painted()}`);
      throw error;
    }
    await showPainted("Agent Hub");

    if (mode === "tui-kill" || mode === "tui-revive") {
      // Hub `x` aborts the running child turn and releases it: the native turn must be interrupted once.
      await ask({ op: "keys", keys: "x" });
      await until("native turn/interrupt", () => sent("turn/interrupt").length === 1);
      await Bun.sleep(1500);
      await showPainted("after Hub kill");
      assert.equal(sent("turn/steer").length, 0);
      assert.equal(sent("turn/interrupt").length, 1);
      if (mode === "tui-kill") {
        assertSingleWorkspaceTurn();
        return;
      }
      // Cold revival of the killed child from its transcript (Enter on a killed agent revives and focuses
      // it), then a new question: the child must continue its recorded native thread, resumed once, with
      // only the new text and without restarting the original task.
      await ask({ op: "keys", keys: "enter" });
      await Bun.sleep(1500);
      await show("revived child");
      const question = `${FOLLOWUP}-revived: what did you find so far?`;
      await ask({ op: "paste", text: question });
      await ask({ op: "keys", keys: "enter" });
      const turns = await until("revived turn/start", () => { const all = sent("turn/start"); return all.length >= 2 ? all : undefined; });
      assert.equal(sent("thread/resume").length, 1, "the revived child resumes its native thread once");
      assert.equal(sent("thread/resume")[0].threadId, turns[0].threadId);
      assert.equal(turns[1].threadId, turns[0].threadId);
      const input = JSON.stringify(turns[1].input);
      assert.ok(input.includes(`${FOLLOWUP}-revived`), input);
      assert.ok(!input.includes("Inspect the current directory"), `original task resent after revival: ${input}`);
      await until("revived answer painted", async () => (await screen()).split(`${FOLLOWUP}-revived`).length - 1 >= 2);
      await show("revived child after answer");
      await Bun.sleep(2000);
      assert.equal(sent("turn/steer").length, 0);
      assertSingleWorkspaceTurn(2, 1);
      return;
    }

    await ask({ op: "keys", keys: "enter" });
    await Bun.sleep(500);
    await show("focused child");
    // Typing into the focused running child is a steer. Typed into the main session it would only reach
    // the fixture orchestrator, so a native turn/steer proves focus and the steering path.
    await ask({ op: "paste", text: STEER });
    await ask({ op: "keys", keys: "enter" });
    const [steer] = await until("native turn/steer", () => { const steers = sent("turn/steer"); return steers.length ? steers : undefined; });
    assert.ok(JSON.stringify(steer.input).includes(STEER), JSON.stringify(steer.input));
    assert.equal(steer.expectedTurnId, "turn-1", "steer targets the active native turn");
    // The fake completes the steered turn with "steered: <text>"; the focused transcript shows it.
    await until("steered answer painted", async () => (await screen()).includes("steered:"));
    await show("child after steer");
    if (mode === "tui-followup") {
      // Let the child finish its run (task result, any yield step) before asking again.
      await Bun.sleep(3000);
      assert.equal(sent("turn/start").length, 1, "nothing after the steered turn before the follow-up");
      // A new question to the same idle child is a normal follow-up: a second turn/start on the same thread
      // carrying only the new text, never the original task or the steer again.
      await ask({ op: "paste", text: `${FOLLOWUP}: how many files are there?` });
      await ask({ op: "keys", keys: "enter" });
      const turns = await until("follow-up turn/start", () => { const all = sent("turn/start"); return all.length >= 2 ? all : undefined; });
      assert.equal(turns[1].threadId, turns[0].threadId, "follow-up continues the child's native thread");
      const input = JSON.stringify(turns[1].input);
      assert.ok(input.includes(FOLLOWUP), input);
      assert.ok(!input.includes(STEER) && !input.includes("Inspect the current directory"), `follow-up resent earlier text: ${input}`);
      // The fake answers "done: <prompt>", so the marker appears again once the answer is painted
      // (the typed message is the first occurrence).
      await until("follow-up answer painted", async () => (await screen()).split(FOLLOWUP).length - 1 >= 2);
      await show("child after follow-up");
    }
    // Back to the main session; give a would-be duplicate (queued steer, yield reminder) time to appear.
    await ask({ op: "keys", keys: "escape" });
    await Bun.sleep(3000);
    await show("main session after child result");
    assert.equal(sent("turn/steer").length, 1);
    assert.equal(sent("turn/interrupt").length, 0);
    assertSingleWorkspaceTurn(mode === "tui-followup" ? 2 : 1);
  } catch (error) {
    // The last terminal output shows boot or extension-load errors behind an early failure.
    console.error(`--- last PTY output ---\n${output.join("").slice(-4096)}`);
    throw error;
  } finally {
    proc.kill();
    await proc.exited;
  }
}

async function rpc() {
  const needsUI = mode === "rpc-lifecycle" || QUESTION_MODES.includes(mode) && mode !== "rpc-question-headless";
  const proc = Bun.spawn([SCRIPT, "--mode", "rpc", ...(needsUI ? [] : ["--no-ui"])], {
    env: {
      ...process.env, CODEX_HUB_FIXTURE_DIR: FIX, CODEX_HUB_FIXTURE_CONTEXT: CONTEXT,
      // rpc-queued: OMP's shipped default (no live steering) and a first native turn that ends on its own.
      ...(mode === "rpc-queued" ? { CODEX_HUB_FIXTURE_LIVE_STEERING: "false", CODEX_HUB_FIXTURE_OPTIONS: '{"turns":["work-then-finish","finish-later"]}' } : {}),
      ...(SELECTOR ? { CODEX_HUB_FIXTURE_MODEL: SELECTOR, CODEX_HUB_FIXTURE_OPTIONS: JSON.stringify({ turns: ["work"], models: NATIVE_MODELS, modelPageSize: 3 }) } : {}),
      // rpc-removed-sandbox: the parent calls the direct codex_bridge tool with the removed `sandbox` argument.
      ...(mode === "rpc-removed-sandbox" ? { CODEX_HUB_FIXTURE_DIRECT_SANDBOX: "read-only" } : {}),
      ...(QUESTION_MODES.includes(mode) ? { CODEX_HUB_FIXTURE_OPTIONS: JSON.stringify({ turns: [mode === "rpc-elicitation" ? "elicitation" : mode === "rpc-async-question" ? "async-question" : "question"], questionIsOther: mode === "rpc-question-ask" }) } : {}),
      ...(mode === "rpc-rich" ? { CODEX_HUB_FIXTURE_OPTIONS: '{"turns":["rich-output"]}', CODEX_HUB_FIXTURE_STRUCTURED: "true", CODEX_HUB_FIXTURE_SCHEMA: JSON.stringify(OUTPUT_SCHEMA), CODEX_HUB_FIXTURE_ENABLE_EFFORT: "true", CODEX_HUB_FIXTURE_EFFORT: "hi" } : {}),
      ...(mode === "rpc-direct-rich" ? { CODEX_HUB_FIXTURE_OPTIONS: '{"turns":["rich-output"]}', CODEX_HUB_FIXTURE_DIRECT_JSON: JSON.stringify(DIRECT_RICH) } : {}),
      ...(mode === "rpc-lifecycle" ? { CODEX_HUB_FIXTURE_OPTIONS: '{"turns":["finish-later","rich-output","finish-later","finish-later","finish-later"]}', CODEX_HUB_FIXTURE_KEEP_RECENT_TOKENS: "1" } : {}),
    },
    stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  const frames = [];
  const waiting = new Map();
  (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of proc.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines) {
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        frames.push(frame);
        if (frame.type === "response" && waiting.has(frame.id)) waiting.get(frame.id)(frame);
      }
    }
  })();
  let next = 0;
  // Bounded: a missing response or an exited OMP fails the smoke instead of hanging it.
  const call = (command, ms = 15000) => {
    const id = `smoke-${++next}`;
    const { promise, resolve, reject } = Promise.withResolvers();
    const timer = setTimeout(() => reject(new Error(`rpc ${command.type}: no response in ${ms} ms`)), ms);
    waiting.set(id, (frame) => { clearTimeout(timer); resolve(frame); });
    proc.exited.then((code) => { clearTimeout(timer); reject(new Error(`omp exited (${code}) before answering ${command.type}`)); });
    proc.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    proc.stdin.flush();
    return promise;
  };
  // The task must really end (default: final message; structured: yield), not idle in a yield-reminder
  // loop: OMP reports a terminal lifecycle frame, drops the child from get_subagents, and cancel finds no
  // running child (cancelled: false) and sends Codex no interrupt.
  const assertChildFinished = async (child) => {
    const ended = await until("child task finished", () => frames.find((frame) =>
      frame.type === "subagent_lifecycle" && frame.payload?.id === child.id && frame.payload.status !== "started"), 30000);
    assert.equal(ended.payload.status, "completed", JSON.stringify(ended.payload));
    const listed = (await call({ type: "get_subagents" })).data.subagents.find((agent) => agent.id === child.id);
    assert.ok(!listed || !["running", "pending"].includes(listed.status), `child still ${listed?.status}`);
    const cancelled = await call({ type: "cancel_subagent", subagentId: child.id });
    assert.equal(cancelled.success, true, JSON.stringify(cancelled));
    assert.equal(cancelled.data.cancelled, false, "a finished child has nothing to cancel");
    await Bun.sleep(1000);
    assert.equal(sent("turn/interrupt").length, 0);
  };
  try {
    await until("rpc ready", () => frames.some(frame => frame.type === "ready"));
    assert.equal((await call({ type: "set_subagent_subscription", level: "events" })).success, true);
    const respondUI = (request, answer) => {
      proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: request.id, ...answer })}\n`);
      proc.stdin.flush();
    };
    const idle = async () => (await call({ type: "get_state" })).data?.isStreaming === false;
    if (mode === "rpc-lifecycle") {
      await until("discovered native image and reasoning capabilities", async () => {
        const models = (await call({ type: "get_available_models" }, 30000)).data?.models ?? [];
        return models.find(model => model.provider === "codex-bridge" && model.id === "default" && model.input?.includes("image") && model.reasoning);
      });
      const selected = await call({ type: "set_model", provider: "codex-bridge", modelId: "default" });
      assert.equal(selected.success, true);
      assert.ok(selected.data.input?.includes("image") && selected.data.reasoning, "select the discovered model instead of the text-only bootstrap entry");
      assert.equal((await call({ type: "set_thinking_level", level: "medium" })).success, true);
      const promptNative = async (message, turns, images) => {
        assert.equal((await call({ type: "prompt", message, ...(images ? { images } : {}) })).success, true);
        await until(`native turn ${turns}`, () => sent("turn/start").length === turns);
        await until(`native turn ${turns} settled`, idle);
        const result = await call({ type: "get_entries" });
        return result.data.entries.filter(entry => entry.type === "message" && entry.message?.role === "assistant" && entry.message.responseId?.startsWith("codex-bridge:"));
      };
      // Keep a short genuine baseline before A, so OMP has older local history to summarize
      // after /tree returns to A even though native hidden context is not in its token estimate.
      await promptNative("fixture lifecycle baseline", 1);
      const first = (await promptNative("fixture lifecycle first", 2, [{ type: "image", data: IMAGE_DATA, mimeType: "image/png" }])).at(-1);
      assert.ok(first?.message.responseId, "completed native answer carries visible-history anchor");
      // OMP officially resizes/re-encodes ingress images. Compare the native payload with the
      // normalized persisted block, not the pre-ingress PNG bytes.
      const messages = (await call({ type: "get_messages" })).data.messages;
      const image = messages.flatMap(message => message.role === "user" && Array.isArray(message.content) ? message.content : []).find(block => block.type === "image");
      assert.ok(image?.data && image.mimeType, "OMP retains an actual image block");
      const expectedImage = image.data.startsWith("data:") ? image.data : `data:${image.mimeType};base64,${image.data}`;
      assert.deepEqual(sent("turn/start")[1].input.filter(part => part.type === "image"), [{ type: "image", url: expectedImage }], "the normalized OMP image reaches native input byte-for-byte");
      assert.equal(sent("turn/start")[1].effort, "medium");
      const usage = first.message.usage;
      assert.deepEqual([usage.input, usage.cacheRead, usage.output, usage.totalTokens, usage.contextTokens], [100, 20, 30, 150, 90]);
      await promptNative("fixture lifecycle discarded future", 3);
      const navigated = await call({ type: "navigate_tree", entryId: first.id, summarize: false });
      assert.equal(navigated.success, true, JSON.stringify(navigated));
      assert.notEqual(navigated.data?.cancelled, true);
      const originalThreadId = sent("turn/start")[0].threadId;
      const originalThread = JSON.parse(readFileSync(join(FIX, "store.json"), "utf8")).threads[originalThreadId];
      const firstCompactFrames = frames.length;
      const compactedAtA = await call({ type: "compact" }, 30000);
      assert.equal(compactedAtA.success, true, JSON.stringify({
        response: compactedAtA,
        notifications: frames.slice(firstCompactFrames).filter(frame => frame.type === "extension_ui_request" && frame.method === "notify"),
      }));
      assert.equal(sent("turn/start").length, 3, "tree compaction must not generate a loading prompt");
      assert.equal(sent("turn/steer").length, 0, "tree compaction must not steer a loading prompt");
      const forkThreadId = compactedAtA.data?.preserveData?.codexNative?.threadId;
      assert.ok(typeof forkThreadId === "string" && forkThreadId !== originalThreadId, "compaction forks the selected visible boundary");
      assert.equal(sent("thread/compact/start").length, 1);
      assert.equal(sent("thread/compact/start")[0].threadId, forkThreadId);
      assert.equal(compactedAtA.data?.details?.summaryAvailable, false);
      const afterTreeCompact = JSON.parse(readFileSync(join(FIX, "store.json"), "utf8"));
      assert.deepEqual(afterTreeCompact.threads[originalThreadId], originalThread, "the original thread and completed future B remain untouched");
      assert.ok(!afterTreeCompact.threads[forkThreadId].turns.some(turn => turn.id === originalThread.turns[2].id), "forked compaction does not inherit future B");
      await promptNative("fixture lifecycle branch input", 4);
      assert.equal(sent("thread/fork").length, 1, "tree branch forks once at completed visible answer");
      assert.equal(sent("thread/fork")[0].threadId, sent("turn/start")[0].threadId);
      assert.equal(sent("thread/fork")[0].lastTurnId, first.message.responseId.split(":").at(-1));
      assert.notEqual(sent("turn/start")[3].threadId, sent("turn/start")[2].threadId, "future native turns are not inherited");
      const beforeReload = sent("turn/start")[3].threadId;
      assert.equal(beforeReload, forkThreadId, "new input after tree compaction continues the forked boundary");
      const resumesBeforeReload = sent("thread/resume").length;
      const reloaded = await call({ type: "prompt", message: "/codex-fixture-reload" }, 30000);
      assert.equal(reloaded.success, true, JSON.stringify(reloaded));
      // Prompt admission is an ACK, not proof that its asynchronous command handler finished.
      await until("official ctx.reload completion marker", async () =>
        (await call({ type: "get_entries" })).data?.entries?.find(entry => entry.type === "custom" && entry.customType === "codex-hub-fixture-reloaded"));
      const reloadCompactFrames = frames.length;
      const compacted = await call({ type: "compact" }, 30000);
      assert.equal(compacted.success, true, JSON.stringify({
        response: compacted,
        notifications: frames.slice(reloadCompactFrames).filter(frame => frame.type === "extension_ui_request" && frame.method === "notify"),
      }));
      assert.equal(sent("turn/start").length, 4, "reload compaction attaches without a new user turn");
      assert.equal(sent("turn/steer").length, 0, "reload compaction does not steer a loading prompt");
      assert.equal(sent("thread/resume").length, resumesBeforeReload + 1, "reload compaction resumes the recorded thread exactly once");
      assert.equal(sent("thread/resume").at(-1).threadId, beforeReload);
      assert.equal(sent("thread/compact/start").length, 2, "both explicit compactions stay native");
      assert.equal(sent("thread/compact/start")[1].threadId, beforeReload);
      assert.equal(compacted.data?.details?.summaryAvailable, false);
      assert.equal(compacted.data?.preserveData?.codexNative?.threadId, beforeReload);
      assert.equal(sent("thread/fork").length, 1, "reload does not fork the already restored compacted lineage again");
      await promptNative("fixture lifecycle after reload", 5);
      assert.equal(sent("turn/start")[4].threadId, beforeReload, "new input after reload and compaction continues the recorded native lineage");
      assert.equal(sent("thread/resume").length, resumesBeforeReload + 1, "new input does not attach a second time");
      assert.equal((await call({ type: "set_model", provider: "codex-hub-fixture", modelId: "orchestrator" })).success, true);
      const dispatchPath = join(FIX, "provider-dispatch.jsonl");
      const dispatches = () => existsSync(dispatchPath) ? readFileSync(dispatchPath, "utf8").trim().split("\n").filter(Boolean).length : 0;
      assert.equal(dispatches(), 0, "fixture orchestrator has never dispatched");
      const guardFrameStart = frames.length;
      await call({ type: "prompt", message: "fixture incompatible opaque history must never dispatch" });
      await until("incompatible turn ends without dispatch", () => frames.slice(guardFrameStart).some(frame => frame.type === "agent_end" || frame.type === "error"));
      await until("incompatible turn settled", idle);
      assert.equal(dispatches(), 0, "incompatible provider must not receive opaque native history");
      assert.equal(sent("turn/start").length, 5, "only baseline, A, B and the two intended later inputs generated native turns");
      return;
    }
    if (QUESTION_MODES.includes(mode)) {
      if (mode === "rpc-question-ask") assert.equal((await call({ type: "set_ask_dialog", enabled: true })).success, true);
      assert.equal((await call({ type: "prompt", message: "Run the native question fixture." })).success, true);
      const child = await until("question child", async () => (await call({ type: "get_subagents" })).data?.subagents?.find(agent => agent.agent === AGENT)
        ?? frames.find(frame => frame.type === "subagent_lifecycle" && frame.payload?.id === CHILD)?.payload);
      const nativeResponse = id => trace().find(({ message }) => message?.id === id && !message.method)?.message;
      if (mode === "rpc-question-headless") {
        await until("headless native question rejected", () => nativeResponse(901));
        assert.deepEqual(nativeResponse(901).result, { answers: {} });
        assert.ok(!frames.some(frame => frame.type === "extension_ui_request" && ["ask", "select", "input"].includes(frame.method)));
        await assertChildFinished(child);
        return;
      }
      const question = await until("root UI question", () => frames.find(frame => frame.type === "extension_ui_request" && ["ask", "select", "input"].includes(frame.method)));
      assert.equal(question.method, mode === "rpc-question-ask" ? "ask" : "select", "closed native choices must not expose unsupported custom input");
      await until("main settled with child question pending", idle);
      assert.ok(!frames.some(frame => frame.method === "cancel" && frame.targetId === question.id), "main turn end must not cancel child question");
      if (mode === "rpc-question-cancel") {
        assert.equal((await call({ type: "cancel_subagent", subagentId: child.id })).success, true);
        await until("official RPC dialog cancellation", () => frames.find(frame => frame.type === "extension_ui_request" && frame.method === "cancel" && frame.targetId === question.id));
        await until("native question turn interrupted", () => sent("turn/interrupt").length === 1);
        respondUI(question, { value: "Production" });
        await Bun.sleep(300);
        assert.ok(!nativeResponse(901)?.result?.answers?.environment, "late answer must not reach cancelled native request");
        return;
      }
      if (question.method === "ask") respondUI(question, { answers: [{ id: "environment", selectedOptions: ["Staging"] }] });
      else respondUI(question, { value: "Staging" });
      if (mode === "rpc-elicitation") {
        const submit = await until("explicit MCP form submission", () => frames.find(frame => frame.type === "extension_ui_request" && frame.method === "select" && frame.id !== question.id));
        respondUI(submit, { value: "Submit answers" });
        await until("native elicitation response", () => nativeResponse(902));
        assert.deepEqual(nativeResponse(902).result, { action: "accept", content: { environment: "Staging" } });
      } else if (mode === "rpc-async-question") {
        const [steer] = await until("official async question reply steer", () => sent("turn/steer").length ? sent("turn/steer") : undefined);
        assert.equal(steer.expectedTurnId, "turn-1");
        assert.match(steer.input[0].text, /<send_user_message_question_reply>/);
        assert.match(steer.input[0].text, /Staging/);
      } else {
        await until("native question response", () => nativeResponse(901));
        assert.deepEqual(nativeResponse(901).result, { answers: { environment: { answers: ["Staging"] } } });
      }
      await assertChildFinished(child);
      assertSingleWorkspaceTurn();
      return;
    }
    if (mode === "rpc-direct-rich") {
      assert.equal((await call({ type: "prompt", message: "Run the direct rich native fixture." })).success, true);
      const [turn] = await until("direct rich native input", () => sent("turn/start").length ? sent("turn/start") : undefined);
      assert.deepEqual(turn.input, DIRECT_RICH.input);
      assert.equal(turn.effort, "high");
      assert.deepEqual(turn.outputSchema, OUTPUT_SCHEMA);
      await until("direct rich native final", () => {
        const path = join(FIX, "store.json");
        return existsSync(path) && JSON.parse(readFileSync(path, "utf8")).threads[turn.threadId]?.turns[0]?.status === "completed";
      });
      assert.equal(sent("thread/start").length, 1);
      assert.equal(turn.approvalPolicy, "never");
      return;
    }
    if (mode === "rpc-rich") {
      assert.equal((await call({ type: "prompt", message: "Run the strict structured native fixture." })).success, true);
      const child = await until("rich child", async () => (await call({ type: "get_subagents" })).data?.subagents?.find(agent => agent.agent === AGENT)
        ?? frames.find(frame => frame.type === "subagent_lifecycle" && frame.payload?.id === CHILD)?.payload);
      await assertChildFinished(child);
      const transcript = (await call({ type: "get_subagent_messages", subagentId: child.id })).data.messages;
      const native = transcript.find(message => message.role === "assistant" && message.responseId?.startsWith("codex-bridge:"));
      assert.ok(native, "native answer is persisted");
      assert.deepEqual([native.usage.input, native.usage.cacheRead, native.usage.output, native.usage.totalTokens, native.usage.contextTokens], [100, 20, 30, 150, 90]);
      assert.ok(JSON.stringify(transcript).includes("partial answer"), "partial native answer remains observable");
      const yielded = transcript.flatMap(message => message.role === "assistant" ? message.content.filter(block => block.type === "toolCall" && block.name === "yield") : []);
      assert.equal(yielded.length, 1, "structured task ends through one real yield");
      assert.deepEqual(yielded[0].arguments.data, { ok: true });
      assert.deepEqual(sent("turn/start")[0].outputSchema, OUTPUT_SCHEMA);
      assert.equal(sent("turn/start")[0].effort, "high");
      assertSingleWorkspaceTurn();
      return;
    }
    if (mode === "rpc-removed-sandbox") {
      // The real OMP tool path (validation, then execute) must refuse it as SANDBOX_REMOVED: an error tool
      // result and no native thread or turn at all.
      assert.equal((await call({ type: "prompt", message: "Run the Codex removed-sandbox fixture." })).success, true);
      const result = await until("codex_bridge tool result", async () =>
        (await call({ type: "get_messages" })).data?.messages?.find((message) => message.role === "toolResult" && message.toolName === "codex_bridge"));
      const text = JSON.stringify(result.content);
      console.log("codex_bridge result:", text.slice(0, 2000));
      assert.equal(result.isError, true, `removed sandbox argument accepted: ${text}`);
      assert.match(text, /SANDBOX_REMOVED|sandbox is no longer accepted/, "refused as the removed sandbox argument");
      await Bun.sleep(2000);
      assert.deepEqual(counts(), { "thread/start": 0, "thread/resume": 0, "turn/start": 0, "turn/steer": 0, "turn/interrupt": 0 });
      return;
    }
    if (SELECTOR) {
      // OMP's own registry lists the profiles its background fetchDynamicModels refresh discovered;
      // discovery read every native model/list page and mutated nothing.
      const codexIds = async () => (await call({ type: "get_available_models" }, 30000)).data.models
        .filter((model) => model.provider === "codex-bridge").map((model) => model.id);
      const ids = await until("discovered native profiles", async () => { const found = await codexIds(); return found.includes(NATIVE_MODELS.at(-1)) ? found : undefined; });
      for (const native of NATIVE_MODELS) assert.ok(ids.includes(native), `discovered ${native}: ${ids}`);
      assert.ok(ids.includes("default"), "the default profile stays listed");
      assert.ok(!ids.some((id) => /^(read-only|workspace-write)(--|$)/.test(id)), `no permission-prefixed profile: ${ids}`);
      assert.ok(sent("model/list").length >= 3, "every model/list page read");
      assert.deepEqual(counts(), { "thread/start": 0, "thread/resume": 0, "turn/start": 0, "turn/steer": 0, "turn/interrupt": 0 });
    }
    assert.equal((await call({ type: "prompt", message: "Run the Codex hub fixture." })).success, true);
    await until("native turn/start", () => sent("turn/start").length === 1);
    const child = await until("registered child", async () =>
      (await call({ type: "get_subagents" })).data?.subagents?.find((agent) => agent.id === CHILD || agent.agent === AGENT));
    console.log("subagent:", JSON.stringify({ id: child.id, agent: child.agent, agentSource: child.agentSource, status: child.status }));
    // Only user-level (or bundled) agent frontmatter grants a per-call model; the fixture installs it there.
    assert.equal(child.agentSource, "user");
    assert.equal(child.agent, AGENT);

    const steered = await call({ type: "steer_subagent", subagentId: child.id, message: STEER });
    assert.equal(steered.success, true, JSON.stringify(steered));
    if (mode === "rpc-queued") {
      // The first turn is still running (it ends 3 s after admission). Without live steering OMP holds the
      // message and sends it as the next native turn once the first one ends: no turn/steer, exactly one
      // more turn/start carrying the message and nothing already delivered.
      const turns = await until("queued message as 2nd turn/start", () => { const all = sent("turn/start"); return all.length >= 2 ? all : undefined; }, 20000);
      assert.equal(sent("turn/steer").length, 0, "no live steer with providers.openaiLiveSteering false");
      assert.ok(!JSON.stringify(turns[0].input).includes(STEER), "the message was not in the first native input");
      assert.equal(turns[1].threadId, turns[0].threadId);
      const input = JSON.stringify(turns[1].input);
      assert.equal(input.split(STEER).length - 1, 1, `message delivered once: ${input}`);
      assert.ok(!input.includes("Inspect the current directory") && !input.includes("6d1f"), `earlier input resent: ${input}`);
      await Bun.sleep(3000);
      assert.equal(sent("turn/start").length, 2);
      assert.equal(sent("turn/steer").length, 0);
      assertSingleWorkspaceTurn(2);
      await assertChildFinished(child);
      return;
    }
    const [steer] = await until("native turn/steer", () => { const steers = sent("turn/steer"); return steers.length ? steers : undefined; });
    assert.ok(JSON.stringify(steer.input).includes(STEER), JSON.stringify(steer.input));

    // The child transcript is real OMP session history and carries the native answer.
    const transcript = await until("child transcript with steered answer", async () => {
      const result = await call({ type: "get_subagent_messages", subagentId: child.id });
      const text = JSON.stringify(result.data?.messages ?? []);
      return text.includes("steered:") ? result.data.messages : undefined;
    });
    // Native tools stay inside Codex: the child transcript has no OMP tool call besides a possible yield.
    const toolCalls = transcript.flatMap((message) => message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall") : []);
    assert.deepEqual(toolCalls.map((block) => block.name).filter((name) => name !== "yield"), []);
    // OMP records the selected concrete profile (or the default) as the child's model.
    const models = new Set(transcript.filter((message) => message.role === "assistant").map((message) => `${message.provider}/${message.model}`));
    assert.deepEqual([...models], [SELECTOR ?? "codex-bridge/default"]);
    // The child's provider record binds the fixed sandbox and the native model (absent = Codex default) for later reloads.
    const records = readdirSync(join(FIX, "codex-bridge-state")).filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(FIX, "codex-bridge-state", name), "utf8")));
    assert.deepEqual(records.map((record) => [record.sandbox, record.cwd, record.model]), [["workspace-write", realpathSync(join(FIX, "work")), NATIVE_MODEL]]);
    await Bun.sleep(3000);
    assert.equal(sent("turn/steer").length, 1);
    assertSingleWorkspaceTurn();
    await assertChildFinished(child);
  } finally {
    proc.kill();
    await proc.exited;
  }
}

try {
  await (mode.startsWith("rpc") ? rpc() : tui());
  console.log(`hub-smoke ${mode}: PASS ${JSON.stringify(counts())}`);
  // Holds the isolated OMP HOME/XDG state too; nothing outside it was created.
  rmSync(FIX, { recursive: true, force: true });
} catch (error) {
  process.exitCode = 1;
  console.error(`hub-smoke ${mode}: FAIL (fixture, including isolated OMP home, kept at ${FIX})`);
  throw error;
}
