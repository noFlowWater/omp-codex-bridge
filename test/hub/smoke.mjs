// TEST-ONLY real-OMP smoke: no model inference, no real Codex.
// `bun test/hub/smoke.mjs <mode>`: delegation/lifecycle plus operator, live progress and execution-card UX.
// The orchestrator emits real task/direct-tool calls; native-root modes run the production provider.
// Both paths use the fake app-server. Assertions read its protocol trace (what Codex would receive)
// plus OMP's actual TUI document/paint (OMP_TUI_DEBUG socket) or RPC responses. New usability modes
// assert rendered values, failure tails, structured state and read-only history after process restart.
// Exit 0 = all assertions held. OMP runs with HOME/XDG directories inside the
// fixture directory (see fixture.sh), which is removed on success and kept (path printed) on failure.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "tui-steer";
const QUESTION_MODES = ["rpc-question", "rpc-question-secret", "rpc-question-ask", "rpc-question-cancel", "rpc-question-headless", "rpc-elicitation", "rpc-async-question"];
const USABILITY_MODES = ["tui-operator", "tui-progress", "tui-execution", "tui-approval", "tui-form"];
if (!["tui-steer", "tui-followup", "tui-kill", "tui-revive", "tui-question", "tui-question-secret", "tui-progress-many", "tui-clear", "rpc", "rpc-queued", "rpc-model", "rpc-rich", "rpc-direct-rich", "rpc-lifecycle", "rpc-branches", ...QUESTION_MODES, ...USABILITY_MODES].includes(mode)) throw new Error(`unknown mode ${mode}`);
const AGENT = "codex-bridge";
// rpc-model: the task item picks one concrete native model with OMP's per-call `model` selector. The fake
// native model/list serves the real slug list in pages of 3; the grant comes from the production agent
// frontmatter, the fixture config only opens the gate and allowlists this one selector.
const NATIVE_MODEL = mode === "rpc-model" ? "gpt-6-astra" : undefined;
const SELECTOR = NATIVE_MODEL && `codex-bridge/${NATIVE_MODEL}`;
const NATIVE_MODELS = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const FIX = mkdtempSync(join(tmpdir(), "codex-hub-smoke-"));
const SCRIPT = join(import.meta.dir, "fixture.sh");
const CHILD = "CodexChild";
const SECRET = randomUUID();
const redact = (text) => text.replaceAll(SECRET, "[redacted fixture secret]");
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

// Native configuration stays authoritative; the bridge supplies cwd and task identity only.
function assertSingleWorkspaceTurn(turns = 1, resumes = 0) {
  const work = realpathSync(join(FIX, "work"));
  const [start] = sent("thread/start");
  assert.ok(!("sandbox" in start));
  assert.ok(!("approvalPolicy" in start));
  // The child shares the parent's cwd (no isolation) in every mode.
  assert.equal(start.cwd, work);
  for (const resume of sent("thread/resume")) {
    assert.equal(resume.cwd, work);
    assert.ok(!("sandbox" in resume));
    assert.ok(!("approvalPolicy" in resume));
  }
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
    assert.ok(!("sandboxPolicy" in turn));
    assert.ok(!("approvalPolicy" in turn));
  }
  assert.equal(sent("thread/start").length, 1, "one native thread per child session");
  assert.equal(sent("thread/resume").length, resumes, "the live child keeps its loaded thread; only a revived one resumes it");
  assert.equal(sent("turn/start").length, turns, "no duplicate native turn (yield reminder, retry or queued steer)");
  const named = sent("thread/name/set").find(params => params.threadId === sent("turn/start")[0].threadId);
  assert.ok(named?.name?.trim(), "OMP task metadata names the native thread");
  assert.equal(JSON.parse(readFileSync(join(FIX, "store.json"), "utf8")).threads[named.threadId].name, named.name);
}

async function tui() {
  const socket = join(FIX, "tui.sock");
  const output = [];
  const env = { ...process.env, CODEX_HUB_FIXTURE_DIR: FIX, OMP_TUI_DEBUG: socket, CODEX_HUB_FIXTURE_CONTEXT: CONTEXT,
    ...(["tui-question", "tui-question-secret"].includes(mode) ? { CODEX_HUB_FIXTURE_OPTIONS: JSON.stringify({ turns: ["question"], questionIsSecret: mode === "tui-question-secret" }) } : {}),
    ...(mode === "tui-progress-many" ? { CODEX_HUB_FIXTURE_CHILDREN: "3", CODEX_HUB_FIXTURE_OPTIONS: JSON.stringify({
      turns: ["usability-many", "usability-many", "usability-many"],
      rateLimitUpdatesOnTurn: [{ rateLimits: { limitId: "codex", primary: { usedPercent: 100, resetsAt: 1900000000 } } }],
    }) } : {}),
    ...(mode === "tui-clear" ? { CODEX_HUB_FIXTURE_ROOT_MODEL: "codex-bridge/default", CODEX_HUB_FIXTURE_OPTIONS: '{"turns":["rich-output","finish-later","finish-later"]}', CODEX_HUB_FIXTURE_KEEP_RECENT_TOKENS: "1" } : {}),
    ...(USABILITY_MODES.includes(mode) ? { CODEX_HUB_FIXTURE_OPTIONS: '{"turns":["usability"]}' } : {}),
    ...(mode === "tui-operator" ? { CODEX_HUB_FIXTURE_OPTIONS: '{"turns":["usability","finish-later"]}' } : {}),
    ...(["tui-operator", "tui-progress"].includes(mode) ? { CODEX_HUB_FIXTURE_ROOT_MODEL: "codex-bridge/default" } : {}),
    ...(mode === "tui-execution" ? { CODEX_HUB_FIXTURE_DIRECT_JSON: JSON.stringify({ action: "run", prompt: "fixture execution card", effort: "high" }) } : {}),
    ...(mode === "tui-approval" ? { CODEX_HUB_FIXTURE_DIRECT_JSON: JSON.stringify({ action: "run", prompt: "fixture approval" }), CODEX_HUB_FIXTURE_OPTIONS: '{"turns":["approval"]}' } : {}),
    ...(mode === "tui-form" ? { CODEX_HUB_FIXTURE_DIRECT_JSON: JSON.stringify({ action: "run", prompt: "fixture form" }), CODEX_HUB_FIXTURE_OPTIONS: JSON.stringify({ turns: ["elicitation"], elicitationSchema: {
      type: "object", properties: { count: { type: "integer", minimum: 1 }, colors: { type: "array", items: { enum: ["red", "blue"] }, minItems: 2, maxItems: 2 } }, required: ["count", "colors"],
    } }) } : {}),
  };
  let proc;
  let connection;
  let replies;
  const stop = async () => {
    connection?.destroy();
    if (proc) {
      proc.kill();
      await proc.exited;
      proc = undefined;
    }
  };
  const start = async () => {
    rmSync(socket, { force: true });
    proc = Bun.spawn([SCRIPT], {
      env,
      terminal: { cols: Number(process.env.CODEX_HUB_FIXTURE_COLS ?? 160), rows: 48, data: (_terminal, data) => { output.push(new TextDecoder().decode(data)); } },
    });
    await until("TUI debug socket", () => existsSync(socket));
    connection = createConnection(socket);
    replies = createInterface({ input: connection })[Symbol.asyncIterator]();
  };
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
  try {
    await start();
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
    // Framed Markdown can wrap a visible phrase across rows; keep its words, remove only frame padding.
    const visibleText = (text) => text.split("\n").map(line => line.replace(/^\s*│ ?/, "").replace(/ ?│\s*$/, "").trim()).join(" ");
    const enter = async (text) => {
      await ask({ op: "paste", text });
      await ask({ op: "keys", keys: "enter" });
    };
    const command = async (text, label) => {
      const marker = label === "error" ? "Codex operator error:" : `Codex ${label} (read-only):`;
      const before = (await screen()).split(marker).length - 1;
      await enter(text);
      return until(`${text} rendered result`, async () => {
        const document = await screen();
        return document.split(marker).length - 1 > before ? visibleText(document.slice(document.lastIndexOf(marker))) : undefined;
      });
    };
    const mutationTrace = () => trace().filter(({ message }) =>
      /^(thread\/(start|resume|fork|compact\/start)|turn\/(start|steer|interrupt))$/.test(message?.method ?? "")).map(({ message }) => message);
    if (mode === "tui-operator") {
      await enter("/model");
      await until("model picker opened", async () => /free per M|Search models/i.test(await painted()));
      await ask({ op: "paste", text: "codex-bridge" });
      await until("model picker discloses unknown native cost", async () => {
        const text = await painted();
        return text.includes("codex-bridge") && text.includes("cost unknown");
      });
      await ask({ op: "keys", keys: "escape" });
      await ask({ op: "keys", keys: "escape" });
      await until("model picker closed", async () => !(await painted()).includes("free per M"));
      await enter("/codex");
      await until("multiline command help", async () => (await screen()).includes("Codex commands"));
      const helpLines = (await screen()).split("\n");
      assert.ok(helpLines.find(line => line.includes("/codex doctor") && line.includes("Check connection")));
      assert.ok(helpLines.find(line => line.includes("/codex history") && line.includes("Browse saved")));
      assert.ok(!helpLines.some(line => line.includes("/codex doctor") && line.includes("/codex history")));
      const status = await command("/codex status", "status");
      assert.match(status, /No locally loaded direct-tool threads/);
      assert.ok(!status.includes('"threads"'), 'collapsed status must not dump JSON');
      const doctor = await command("/codex doctor", "doctor");
      assert.match(doctor, /codex-cli 0\.167\.2 \(test fixture\)/);
      for (const section of ["connection", "Login", "Configured", "permissions"]) assert.ok(doctor.includes(section), `doctor omitted ${section}`);
      assert.ok(doctor.includes("┌") && doctor.includes("│"), "doctor uses OMP's native table layout");
      assert.match(doctor, /Signed in/);
      assert.ok(!doctor.includes('"supportedReasoningEfforts"'), 'collapsed doctor must not dump the model catalog');
      assert.ok(doctor.includes("fake-model") && doctor.includes("workspace-write"));
      for (const secret of ["PRIVATE-EMAIL", "PRIVATE-WORKSPACE", "PRIVATE-INSTRUCTIONS", "PRIVATE-KEY", "PRIVATE-REQUIREMENTS-KEY"]) assert.ok(!doctor.includes(secret), `doctor exposed ${secret}`);
      assert.ok(sent("account/read").every(params => params.refreshToken === false), "doctor must not refresh native authentication");
      assert.deepEqual(mutationTrace(), [], "doctor cannot create, attach, fork, steer or interrupt native work");
      await show("read-only native doctor before any turn");
      await ask({ op: "keys", keys: "C-o" });
      await until("expanded doctor retains full native catalog", async () => (await screen()).includes('"supportedReasoningEfforts"'));
      await ask({ op: "keys", keys: "C-o" });
      await until("collapsed doctor restores summary", async () => !(await screen()).includes('"supportedReasoningEfforts"'));
    }

    const clearBefore = "fixture-native-before-clear-29e5";
    const clearAfter = "fixture-native-after-clear-71a3";
    await ask({ op: "paste", text: mode === "tui-clear" ? clearBefore : "Run the Codex hub fixture." });
    await ask({ op: "keys", keys: "enter" });
    // The child provider reached the fake app-server; the `work` turn stays active.
    await until("native turn/start", () => sent("turn/start").length === (mode === "tui-progress-many" ? 3 : 1));
    if (mode === "tui-operator") {
      const input = JSON.stringify(sent("turn/start")[0].input);
      assert.ok(input.includes("Signed in"), "native input retains the compact diagnostic summary");
      assert.ok(!input.includes("supportedReasoningEfforts") && !input.includes("perCallModelAllow"), "raw diagnostic catalogs stay out of native input");
      const names = await until("native history named after the question", () => sent("thread/name/set").length ? sent("thread/name/set") : undefined);
      assert.equal(names[0].name, "Run the Codex hub fixture.");
    }
    if (mode === "tui-progress-many") {
      const turns = sent("turn/start");
      const ids = turns.map(turn => turn.threadId);
      assert.equal(new Set(ids).size, 3, "three independent native sessions must actually start");
      const live = await until("three active workers in the native footer", async () => {
        const text = await painted();
        return text.includes("Codex 3 active") && text.includes("Alt+A") ? text : undefined;
      });
      assert.ok(!live.includes("Codex activity ["));
      assert.ok(!live.includes("sessions omitted"));
      assert.ok(!live.includes("Plan: unknown"));
      const quota = await until("one native quota warning across three workers", async () => {
        const text = visibleText(await screen());
        return text.includes("limit reached") ? text : undefined;
      });
      assert.equal(quota.split("limit reached").length - 1, 1);
      assert.ok(quota.includes("100%") && quota.includes("reset"));
      assert.equal(sent("thread/start").length, 3);
      assert.equal(sent("turn/start").length, 3);
      assert.equal(sent("thread/resume").length, 0);
      assert.equal(sent("turn/steer").length, 0);
      assert.equal(sent("turn/interrupt").length, 0, "all three sessions stay active during the consumer assertion");
      console.log(`--- compact native footer with three workers ---\n${live}`);
      return;
    }
    if (USABILITY_MODES.includes(mode)) {
      if (mode === "tui-form") {
        await until("numeric form input", async () => { const text = await painted(); return text.includes("count") && text.includes("minimum"); });
        await ask({ op: "paste", text: "0" });
        await ask({ op: "keys", keys: "enter" });
        await until("field correction prompt", async () => (await painted()).includes("Other answers are kept."));
        await ask({ op: "keys", keys: "enter" });
        await until("numeric field reopened", async () => { const text = await painted(); return text.includes("count") && text.includes("minimum"); });
        await ask({ op: "paste", text: "2" });
        await ask({ op: "keys", keys: "enter" });
        await until("native multi-select", async () => { const text = await painted(); return text.includes("red") && text.includes("blue") && text.includes("colors"); });
        await showPainted("native MCP multi-select after correcting one field");
        await ask({ op: "bytes", data: " " });
        await ask({ op: "keys", keys: "down" });
        await ask({ op: "bytes", data: " " });
        await ask({ op: "keys", keys: "enter" });
        await until("explicit form submission", async () => (await painted()).includes("Submit these answers?"));
        await ask({ op: "keys", keys: "enter" });
        const answer = await until("validated form response", () => trace().find(({ message }) => message?.id === 902 && !message.method)?.message);
        assert.deepEqual(answer.result, { action: "accept", content: { count: 2, colors: ["red", "blue"] } });
        return;
      }
      if (mode === "tui-approval") {
        const prompt = await until("native approval prompt", async () => {
          const text = await painted();
          return text.includes("touch forbidden") ? text : undefined;
        });
        assert.ok(!prompt.includes('"threadId"'));
        await showPainted("native Codex approval");
        await ask({ op: "keys", keys: "escape" });
        await until("explicit native denial", () => trace().some(({ message }) => message?.id === 900 && message?.result?.decision === "decline"));
        return;
      }
      const threadId = sent("turn/start")[0].threadId;
      const nativeTurn = () => {
        const path = join(FIX, "store.json");
        return existsSync(path) && JSON.parse(readFileSync(path, "utf8")).threads[threadId]?.turns[0];
      };
      if (mode === "tui-progress") {
        await until("native command history exceeds the append-log capacity", () => {
          const commands = nativeTurn()?.items.filter(item => item.type === "commandExecution").map(item => item.command ?? "").join("");
          return commands?.length > 65536;
        });
        const live = await until("compact native footer remains visible past the log cap", async () => {
          const text = await painted();
          return text.includes("Codex 1 active") && text.includes("Alt+A") ? text : undefined;
        });
        assert.match(live, /Codex 1 active · fake-model · Alt\+A/, "footer identifies the observed native model");
        assert.ok(!live.includes("Codex activity ["));
        assert.ok(!live.includes("Plan: unknown"));
        console.log(`--- compact native progress footer (painted) ---\n${live}`);
      }
      await until("usability turn terminal failure", () => nativeTurn()?.status === "failed");
      assert.equal(sent("turn/start").length, 1, "failed native work must not silently retry");
      if (mode === "tui-execution") {
        const beforeStatus = mutationTrace();
        const beforeCards = (await screen()).split("Codex result").length;
        await enter(`fixture-execution-status:${threadId}`);
        const card = await until("completed direct-tool execution card", async () => {
          const text = await screen();
          const index = text.lastIndexOf("Codex result");
          const body = text.slice(index);
          return index >= 0 && text.split("Codex result").length > beforeCards && body.includes("Failure output") ? body : undefined;
        });
        const cardText = visibleText(card);
        for (const text of ["fake-model", realpathSync(join(FIX, "work")), "Requested effort", "high", threadId,
          "LATEST NATIVE ACTIVITY", "Fix failing command", "old.txt", "new.txt", "Command failed", "exit 17", "FAILURE TAIL", "second failure line"]) {
          assert.ok(cardText.includes(text), `execution card omitted ${text}`);
        }
        assert.deepEqual(mutationTrace(), beforeStatus, "rendering the execution card must not start or resume native work");
        console.log(`--- completed execution card ---\n${card}`);
        return;
      }
      if (mode === "tui-operator") {
        const beforeRestart = mutationTrace();
        const savedStore = readFileSync(join(FIX, "store.json"), "utf8");
        const spawns = trace().filter(entry => entry.spawn).length;
        await stop();
        await start();
        await until("restarted first paint", async () => (await reply({ op: "text" })).parsed.ok);
        const doctor = await command("/codex doctor --json", "doctor");
        assert.match(doctor, /"readOnly"\s*:\s*true/);
        const history = await command('/codex history --json {"limit":1}', "history");
        assert.ok(history.includes(threadId), "saved native thread is discoverable after an actual OMP restart");
        assert.match(history, /"readOnly"\s*:\s*true/);
        assert.ok(trace().filter(entry => entry.spawn).length > spawns, "history is read by a new native process");
        const summary = await command(`/codex show ${threadId} {"includeItems":true,"includeDiff":true,"limit":3}`, "details");
        assert.ok(summary.includes(threadId) && summary.includes("Command failed") && summary.includes("exit 17"));
        assert.ok(!summary.includes('"inspectionOnly"') && !summary.includes('"latestPlan"'));
        assert.ok(summary.includes("NATIVE RENAME DIFF"), "explicitly requested diffs render without raw JSON mode");
        const details = await command(`/codex show --json ${threadId} {"includeItems":true,"includeDiff":true,"limit":3}`, "details");
        for (const text of [threadId, "native-usability-command", "FAILURE TAIL", "second failure line", "old.txt", "new.txt", "NATIVE RENAME DIFF"]) {
          assert.ok(details.includes(text), `restarted native details omitted ${text}`);
        }
        assert.match(details, /"exitCode"\s*:\s*17/);
        assert.match(details, /"outputTruncated"\s*:\s*true/);
        assert.match(details, /"diffTruncated"\s*:\s*true/);
        assert.match(details, /"inspectionOnly"\s*:\s*true/);
        assert.match(details, /"latestPlan"\s*:\s*null/, "notification-only plan must not be invented from native history");
        const cursor = /"nextCursor"\s*:\s*"([^"]+)"/.exec(details)?.[1];
        assert.ok(cursor, "large native item history exposes a continuation cursor");
        const selectedTurnId = /"turnId"\s*:\s*"([^"]+)"/.exec(details)?.[1];
        assert.ok(selectedTurnId, "native details expose the selected turn identity for item continuation");
        let nextCursor = cursor;
        let latestSeen = false;
        let pages = 0;
        while (nextCursor) {
          assert.ok(++pages <= 5, "native item history pagination must terminate");
          const next = await command(`/codex show --json ${threadId} ${JSON.stringify({ includeItems: true, turnId: selectedTurnId, cursor: nextCursor, limit: 100 })}`, "details");
          latestSeen ||= next.includes("LATEST NATIVE ACTIVITY");
          const cursorAfter = /"nextCursor"\s*:\s*"([^"]+)"/.exec(next)?.[1];
          assert.notEqual(cursorAfter, nextCursor, "native history advances its item cursor");
          if (!cursorAfter) assert.match(next, /"nextCursor"\s*:\s*null/);
          nextCursor = cursorAfter;
        }
        assert.ok(latestSeen, "native history pagination reaches items beyond the progress cap");
        const error = await command("/codex show missing-thread", "error");
        assert.match(error, /Code\s*│\s*-32600/, "native numeric RPC error remains visible");
        assert.ok(!error.includes('"errorTruncated"'));
        assert.ok(error.includes("thread not found: missing-thread"));
        assert.deepEqual(mutationTrace(), beforeRestart, "doctor/history/details after restart must never create, attach, replay, steer, fork or interrupt a thread");
        assert.equal(readFileSync(join(FIX, "store.json"), "utf8"), savedStore, "read-only inspection leaves native saved history unchanged");
        await show("read-only history and details after process restart");
        await enter("/codex tier");
        await until("native processing tier picker", async () => (await painted()).includes("OpenAI-family service tier"));
        for (let index = 0; index < 4; index++) await ask({ op: "keys", keys: "down" });
        await ask({ op: "keys", keys: "enter" });
        await until("priority selection recorded", async () => /Service tier\s*│\s*priority/.test(visibleText(await screen())));
        await enter("fixture completed history boundary");
        await until("completed boundary for explicit fork", () => {
          const store = JSON.parse(readFileSync(join(FIX, "store.json"), "utf8"));
          return sent("turn/start").length === 2 && Object.values(store.threads).some(thread => thread.turns?.at(-1)?.status === "completed");
        });
        await until("completed native request leaves the active footer", async () => !(await painted()).includes("Codex 1 active"));
        assert.equal(sent("turn/start")[1].serviceTierForTurn, "priority");
        assert.ok(!Object.hasOwn(sent("turn/start")[1], "serviceTier"));
        const sourceId = sent("turn/start")[0].threadId;
        const beforeFork = structuredClone(JSON.parse(readFileSync(join(FIX, "store.json"), "utf8")).threads[sourceId]);
        assert.equal(beforeFork.turns.at(-1).status, "failed", "the picker must retain failed history");
        await enter('/codex history {"limit":10}');
        await until("native history picker", async () => (await painted()).includes("Codex saved history"));
        await show("native saved-history choices");
        await ask({ op: "keys", keys: "enter" });
        await until("history action picker", async () => (await painted()).includes("Fork as new direct thread"));
        await ask({ op: "keys", keys: "down" });
        await ask({ op: "keys", keys: "enter" });
        await until("explicit fork confirmation", async () => (await painted()).includes("Confirm fork"));
        await ask({ op: "keys", keys: "down" });
        await ask({ op: "keys", keys: "enter" });
        await until("fork receipt rendered", async () => (await screen()).includes("Created a direct-tool thread. No inference started."));
        const afterFork = JSON.parse(readFileSync(join(FIX, "store.json"), "utf8"));
        assert.deepEqual(afterFork.threads[sourceId], beforeFork);
        assert.equal(sent("thread/fork").length, 1);
        assert.equal(sent("thread/fork")[0].threadId, sourceId);
        assert.equal(sent("thread/fork")[0].lastTurnId, beforeFork.turns.at(-1).id);
        assert.equal(sent("turn/start").length, 2, "history fork never starts inference");
        await show("native history picker, processing tier and explicit fork");
        return;
      }
      await until("terminal native footer cleared", async () => !(await painted()).includes("Codex 1 active"));
      // Ctrl+T is OMP's official thinking display toggle, including retired transcript rows.
      if (!(await screen()).includes("native execution:")) await ask({ op: "bytes", data: "\x14" });
      const log = await until("native progress thinking displayed", async () => {
        const text = await screen();
        return text.includes("native execution:") ? text : undefined;
      });
      const logText = visibleText(log);
      for (const text of ["model fake-model", "[completed] Inspect native output",
        "[inProgress] Fix failing command", "files completed: old.txt", "native-usability-command", "exit 17",
        "command output tail (truncated); may contain sensitive data:", "FAILURE TAIL", "second failure line",
        "64K-character append log limit reached"]) assert.ok(logText.includes(text), `native progress log omitted ${text}`);
      assert.ok(!logText.includes("LATEST NATIVE ACTIVITY"), "the append log is capped; newer activity remains available through native status/details");
      console.log(`--- bounded native progress and failure log ---\n${log}`);
      const details = await command(`/codex show ${threadId} {"includeItems":true,"limit":3}`, "details");
      assert.match(details, /Command failed\s*│\s*exit 17/);
      for (const text of ["FAILURE TAIL", "second failure line", "old.txt", "new.txt"]) assert.ok(details.includes(text), `native details omitted ${text}`);
      assert.ok(!details.includes("NATIVE RENAME DIFF"), "native diffs remain opt-in");
      assert.equal(sent("thread/resume").length, 0);
      assert.equal(sent("turn/steer").length, 0);
      assert.equal(sent("turn/start").length, 1);
      await show("native failure output tail and file-change metadata");
      return;
    }
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
    if (mode === "tui-question" || mode === "tui-question-secret") {
      await until("root TUI question painted", async () => (await painted()).includes("Which environment?"));
      await showPainted("native question in main TUI");
      if (mode === "tui-question-secret") {
        const pasted = await reply({ op: "paste", text: SECRET });
        assert.equal(pasted.parsed.ok, true, "secret paste accepted");
        const masked = await until("secret input visibly masked", async () => {
          const text = await painted();
          assert.ok(!text.includes(SECRET), "secret input must not appear in the painted dialog");
          return text.includes("•".repeat(SECRET.length)) ? text : undefined;
        });
        assert.ok(masked.includes("Which environment?"), "masking assertion targets the native question dialog");
        await ask({ op: "keys", keys: "enter" });
        const response = await until("secret answer reaches native request", () => trace().find(({ message }) => message?.id === 901 && !message.method)?.message);
        assert.ok(response.result?.answers?.environment?.answers?.[0] === SECRET, "the native request receives the exact secret");
        const sessionRoot = join(FIX, "home", ".omp", "agent", "sessions");
        const journals = await until("root and child transcripts persisted after secret answer", () => {
          if (!existsSync(sessionRoot)) return;
          const paths = readdirSync(sessionRoot, { recursive: true }).filter(name => name.endsWith(".jsonl")).map(name => join(sessionRoot, name));
          return paths.length >= 2 && paths.some(path => readFileSync(path, "utf8").includes("question answered")) ? paths : undefined;
        });
        for (const path of journals) assert.ok(!readFileSync(path, "utf8").includes(SECRET), "OMP root and child transcripts must not retain the secret answer");
        assert.ok(!(await screen()).includes(SECRET), "main transcript must not display the secret answer");
        assert.ok(!output.join("").includes(SECRET), "raw terminal paint must never emit the secret answer");
        assertSingleWorkspaceTurn();
        return;
      }
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
    console.error(`--- last PTY output ---\n${redact(output.join("")).slice(-4096)}`);
    throw error;
  } finally {
    await stop();
  }
}

async function rpc() {
  const needsUI = ["rpc-lifecycle", "rpc-branches"].includes(mode) || QUESTION_MODES.includes(mode) && mode !== "rpc-question-headless";
  const proc = Bun.spawn([SCRIPT, "--mode", "rpc", ...(needsUI ? [] : ["--no-ui"])], {
    env: {
      ...process.env, CODEX_HUB_FIXTURE_DIR: FIX, CODEX_HUB_FIXTURE_CONTEXT: CONTEXT,
      // rpc-queued: OMP's shipped default (no live steering) and a first native turn that ends on its own.
      ...(mode === "rpc-queued" ? { CODEX_HUB_FIXTURE_LIVE_STEERING: "false", CODEX_HUB_FIXTURE_OPTIONS: '{"turns":["work-then-finish","finish-later"]}' } : {}),
      ...(SELECTOR ? { CODEX_HUB_FIXTURE_MODEL: SELECTOR, CODEX_HUB_FIXTURE_OPTIONS: JSON.stringify({ turns: ["work"], models: NATIVE_MODELS, modelPageSize: 3 }) } : {}),
      ...(QUESTION_MODES.includes(mode) ? { CODEX_HUB_FIXTURE_OPTIONS: JSON.stringify({ turns: [mode === "rpc-elicitation" ? "elicitation" : mode === "rpc-async-question" ? "async-question" : "question"], questionIsOther: mode === "rpc-question-ask", questionIsSecret: mode === "rpc-question-secret" }) } : {}),
      ...(mode === "rpc-rich" ? { CODEX_HUB_FIXTURE_OPTIONS: '{"turns":["rich-output"]}', CODEX_HUB_FIXTURE_STRUCTURED: "true", CODEX_HUB_FIXTURE_SCHEMA: JSON.stringify(OUTPUT_SCHEMA), CODEX_HUB_FIXTURE_ENABLE_EFFORT: "true", CODEX_HUB_FIXTURE_EFFORT: "hi" } : {}),
      ...(mode === "rpc-direct-rich" ? { CODEX_HUB_FIXTURE_OPTIONS: '{"turns":["rich-output"]}', CODEX_HUB_FIXTURE_DIRECT_JSON: JSON.stringify(DIRECT_RICH) } : {}),
      ...(mode === "rpc-lifecycle" ? { CODEX_HUB_FIXTURE_OPTIONS: '{"turns":["finish-later","rich-output","finish-later","finish-later","finish-later"]}', CODEX_HUB_FIXTURE_KEEP_RECENT_TOKENS: "1" } : {}),
      ...(mode === "rpc-branches" ? { CODEX_HUB_FIXTURE_OPTIONS: JSON.stringify({ turns: Array(5).fill("finish-later") }) } : {}),
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
    assert.equal(ended.payload.status, "completed", redact(JSON.stringify(ended.payload)));
    const listed = (await call({ type: "get_subagents" })).data.subagents.find((agent) => agent.id === child.id);
    assert.ok(!listed || !["running", "pending"].includes(listed.status), `child still ${listed?.status}`);
    const cancelled = await call({ type: "cancel_subagent", subagentId: child.id });
    assert.equal(cancelled.success, true, redact(JSON.stringify(cancelled)));
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
    if (mode === "rpc-lifecycle" || mode === "rpc-branches") {
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
      if (mode === "rpc-branches") {
        const baseline = "fixture branch source baseline 6af1";
        const future = "fixture branch source future 982b";
        const first = (await promptNative(baseline, 1)).at(-1);
        const second = (await promptNative(future, 2)).at(-1);
        assert.ok(first?.id && second?.id, "real native answers expose journal entry anchors");
        const sourceState = (await call({ type: "get_state" })).data;
        assert.ok(sourceState.sessionFile && sourceState.sessionId, "RPC exposes the actual source session identity");
        const sourceEntries = (await call({ type: "get_entries" })).data.entries;
        const futureEntry = sourceEntries.find(entry => entry.type === "message" && entry.message?.role === "user" && JSON.stringify(entry.message).includes(future));
        assert.ok(futureEntry?.id);
        const originalThreadId = sent("turn/start")[0].threadId;
        const nativeStore = () => JSON.parse(readFileSync(join(FIX, "store.json"), "utf8"));
        const originalThread = nativeStore().threads[originalThreadId];
        const branches = [
          { command: { type: "fork", entryId: first.id }, anchor: first, discardsFuture: true },
          { command: { type: "branch", entryId: futureEntry.id }, anchor: first, discardsFuture: true },
          { command: { type: "fork" }, anchor: second, discardsFuture: false },
        ];
        const threadIds = new Set([originalThreadId]);
        for (let index = 0; index < branches.length; index++) {
          if (index) {
            const resumed = await call({ type: "switch_session", sessionPath: sourceState.sessionFile });
            assert.equal(resumed.success, true, JSON.stringify(resumed));
            assert.equal(resumed.data?.cancelled, false);
            assert.equal((await call({ type: "get_state" })).data.sessionId, sourceState.sessionId);
          }
          const { command, anchor, discardsFuture } = branches[index];
          const before = sent("turn/start").length;
          const changed = await call(command, 30000);
          assert.equal(changed.success, true, JSON.stringify({
            response: changed,
            notifications: frames.filter(frame => frame.type === "extension_ui_request" && frame.method === "notify").slice(-3),
          }));
          assert.equal(changed.data?.cancelled, false);
          assert.notEqual((await call({ type: "get_state" })).data.sessionId, sourceState.sessionId, "real OMP transition creates a new journal");
          assert.equal(sent("thread/fork").length, index, "transition defers native fork until new input");
          assert.equal(sent("turn/start").length, before, "transition never replays transcript input");
          const prompt = `fixture branch fresh input ${index} 34e9`;
          const answer = (await promptNative(prompt, index + 3)).at(-1);
          assert.ok(answer?.message.responseId);
          const fork = sent("thread/fork").at(-1);
          assert.equal(sent("thread/fork").length, index + 1, "one native fork per actual OMP transition");
          assert.equal(fork.threadId, originalThreadId);
          assert.equal(fork.lastTurnId, anchor.message.responseId.split(":").at(-1));
          const turn = sent("turn/start").at(-1);
          assert.ok(!threadIds.has(turn.threadId), "each branch gets its own native thread");
          threadIds.add(turn.threadId);
          const input = JSON.stringify(turn.input);
          assert.equal(input.split(prompt).length - 1, 1);
          assert.ok(!input.includes(baseline) && !input.includes(future), "no earlier prompt is replayed");
          assert.equal(sent("thread/start").length, 1, "branches fork native history instead of starting empty replacement threads");
          assert.equal(sent("turn/steer").length, 0);
          assert.deepEqual(nativeStore().threads[originalThreadId], originalThread, "source native history remains unchanged");
          if (discardsFuture) {
            assert.ok(!nativeStore().threads[turn.threadId].turns.some(item => item.id === originalThread.turns[1].id), "selected checkpoint excludes the discarded future");
          }
        }
        assert.equal(sent("turn/start").length, 5, "only two source inputs and three fresh branch inputs run");
        assert.equal(threadIds.size, 4);
        return;
      }
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
      assert.equal(question.method, mode === "rpc-question-secret" ? "input" : mode === "rpc-question-ask" ? "ask" : "select", "native question uses the appropriate official dialog");
      await until("main settled with child question pending", idle);
      assert.ok(!frames.some(frame => frame.method === "cancel" && frame.targetId === question.id), "main turn end must not cancel child question");
      if (mode === "rpc-question-secret") {
        assert.equal(question.secret, true, "official RPC input request carries the secret masking flag");
        respondUI(question, { value: SECRET });
        const response = await until("secret RPC answer reaches native request", () => nativeResponse(901));
        assert.ok(response.result?.answers?.environment?.answers?.[0] === SECRET, "only the native request receives the exact secret");
        await assertChildFinished(child);
        const root = await call({ type: "get_messages" });
        const entries = await call({ type: "get_entries" });
        const childMessages = await call({ type: "get_subagent_messages", subagentId: child.id });
        assert.ok(!JSON.stringify([root.data, entries.data, childMessages.data, frames]).includes(SECRET), "RPC root/child transcripts and emitted events must not expose the secret answer");
        assertSingleWorkspaceTurn();
        return;
      }
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
      assert.ok(!("approvalPolicy" in turn));
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
    // Native package install discovers agents/ as user scope and preserves its exact per-call model grants.
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
    // Receipts bind native override identity, cwd and model for later reloads.
    const records = readdirSync(join(FIX, "codex-bridge-state")).filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(FIX, "codex-bridge-state", name), "utf8")));
    assert.deepEqual(records.map((record) => [record.policy, record.config, record.cwd, record.model]), [["native-config", {}, realpathSync(join(FIX, "work")), NATIVE_MODEL]]);
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
