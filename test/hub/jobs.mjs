// Explicit opt-in: CODEX_HUB_API_OMP=/path/to/patched/omp bun test/hub/jobs.mjs [history|mixed]
// Real OMP TUI and production bridge, isolated fixture HOME, protocol-double Codex; no inference.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

const binary = process.env.CODEX_HUB_API_OMP;
if (!binary) {
  console.log("hub-jobs: SKIP (set CODEX_HUB_API_OMP to an OMP build with the extension Agent Hub API)");
  process.exit(0);
}
const mode = process.argv[2] ?? "history";
assert.ok(["mixed", "history"].includes(mode), `unknown mode ${mode}`);
const columns = Number(process.env.CODEX_HUB_FIXTURE_COLS ?? 160);
const executable = realpathSync(binary);
const fixture = mkdtempSync(join(tmpdir(), "codex-hub-jobs-"));
const socket = join(fixture, "tui.sock");
const work = join(fixture, "work");
const bin = join(fixture, "omp-bin");
mkdirSync(work);
mkdirSync(bin);
symlinkSync(executable, join(bin, "omp"));

const SOURCE = "saved-jobs-source";
const BOUNDARY = "saved-finished-turn";
const OLD = "SAVED-TRANSCRIPT-MUST-NOT-REPLAY-652c";
const QUESTION = "jobs-history-child-7b2f: inspect retained context";
const FOLLOWUP = "jobs-followup-9c14: continue the same inspection";
const DIRECT = "jobs-direct-31ab";
const source = { id: SOURCE, name: "jobs saved source", cwd: realpathSync(work), model: "fake-model", turns: [{
  id: BOUNDARY, status: "completed", prompt: OLD, error: null,
  items: [
    { type: "userMessage", id: "saved-user", content: [{ type: "text", text: OLD }] },
    { type: "agentMessage", id: "saved-answer", text: `${OLD}: retained native answer`, phase: "final_answer" },
  ],
}] };
writeFileSync(join(fixture, "store.json"), JSON.stringify({ nextThread: 0, nextTurn: 1000, threads: { [SOURCE]: source } }));

const jsonl = path => {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
};
const trace = () => jsonl(join(fixture, "trace.jsonl"));
const sent = method => trace().filter(entry => entry.message?.method === method).map(entry => entry.message.params);
const mutations = () => trace().filter(entry => /^(thread\/(start|resume|fork|name\/set|compact\/start)|turn\/(start|steer|interrupt))$/.test(entry.message?.method ?? ""));
const counts = () => Object.fromEntries(["thread/start", "thread/fork", "turn/start", "turn/steer", "turn/interrupt"].map(method => [method, sent(method).length]));
const store = () => JSON.parse(readFileSync(join(fixture, "store.json"), "utf8"));
const journals = () => {
  const root = join(fixture, "home", ".omp", "agent", "sessions");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true }).filter(name => name.endsWith(".jsonl")).flatMap(name => jsonl(join(root, name)));
};
async function until(what, probe, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const result = await probe();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}; ${JSON.stringify(counts())}`);
    await Bun.sleep(100);
  }
}

const output = [];
const screenshots = [];
let proc;
let connection;
let replies;
let verified;
async function ask(request, allowUnpainted = false) {
  connection.write(`${JSON.stringify(request)}\n`);
  let timeout;
  try {
    const result = await Promise.race([
      replies.next(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`TUI ${request.op} timed out`)), 15000); }),
    ]);
    const response = JSON.parse(result.value);
    if (!allowUnpainted) assert.equal(response.ok, true, `${JSON.stringify(request)} -> ${result.value}`);
    return response;
  } finally { clearTimeout(timeout); }
}
const text = async () => (await ask({ op: "text" })).lines.join("\n");
const frame = async () => (await ask({ op: "frame" })).lines.join("\n");
const keys = keys => ask({ op: "keys", keys });
async function enter(value) {
  await ask({ op: "paste", text: value });
  await keys("enter");
}
async function choose(index) {
  // Small native selectors do not enable search; use their original option order.
  await keys("C-u");
  for (let step = 0; step < index; step++) await keys("down");
  await keys("enter");
}
async function capture(label) { screenshots.push({ label, frame: await frame(), text: await text() }); }
async function rawCommand(command, label) {
  const before = new Set(journals().map(entry => entry.id));
  await enter(command);
  return until(`${command} persisted result`, () => {
    const entry = journals().find(entry => !before.has(entry.id) && entry.type === "custom_message"
      && entry.customType === "codex-bridge-operator" && entry.details?.label === label);
    return entry && (entry.details.result ?? JSON.parse(entry.content.slice(entry.content.indexOf("\n") + 1)));
  });
}
async function jobAction(action, threadId) {
  const listed = await rawCommand("/codex jobs --json", "jobs");
  const index = listed.value.findIndex(job => job.kind === "hub" && job.threadId === threadId);
  assert.ok(index >= 0, "selected native child belongs to the current Hub jobs list");
  await enter("/codex jobs");
  await until("jobs picker with Hub child", async () => {
    const painted = await text();
    return painted.includes("Codex jobs") && painted.includes("[Hub]");
  });
  if (mode === "mixed") assert.ok((await text()).includes("[direct]"), "current direct and Hub jobs share one picker");
  await capture(`${columns}-column jobs picker`);
  if (columns === 80 && action === "View details") console.log(`80-column jobs picker:\n${await text()}`);
  await choose(index);
  await until(`Hub job ${action} action`, async () => (await text()).includes(action));
  await capture(`${columns}-column Hub job actions`);
  if (columns === 80 && action === "View details") console.log(`80-column Hub job actions:\n${await text()}`);
  await choose({ "View details": 0, "Send message": 1, Interrupt: 2 }[action]);
}

try {
  proc = Bun.spawn([join(import.meta.dir, "fixture.sh")], {
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, CODEX_HUB_FIXTURE_DIR: fixture,
      OMP_TUI_DEBUG: socket,
      CODEX_HUB_FIXTURE_OPTIONS: JSON.stringify({ turns: mode === "mixed" ? ["work", "finish-later", "work"] : ["finish-later", "work"] }),
      ...(mode === "mixed" ? { CODEX_HUB_FIXTURE_DIRECT_JSON: JSON.stringify({ action: "run", prompt: DIRECT }) } : {}),
    },
    terminal: { cols: columns, rows: 48, data: (_terminal, data) => { output.push(new TextDecoder().decode(data)); } },
  });
  await until("TUI debug socket", () => existsSync(socket));
  connection = createConnection(socket);
  replies = createInterface({ input: connection })[Symbol.asyncIterator]();
  await until("first paint", async () => (await ask({ op: "text" }, true)).ok);

  if (mode === "mixed") {
    await enter("/codex jobs --json");
    await until("empty jobs result", async () => /"value":\s*\[\]/.test(await frame()));
    assert.deepEqual(mutations(), [], "enumerating an empty jobs list starts no native work");
    await enter("Run the isolated direct worker fixture");
    await until("one direct worker", () => sent("turn/start").length === 1);
    await until("orchestrator finished", async () => (await frame()).includes("codex-hub-fixture parent reply"));
  }
  const parentDispatchBaseline = jsonl(join(fixture, "provider-dispatch.jsonl")).length;
  const beforeHistory = mutations().length;
  await enter('/codex history {"searchTerm":"jobs saved source"}');
  await until("saved history picker", async () => (await text()).includes("jobs saved source"));
  await keys("enter");
  await until("history continuation action", async () => (await text()).includes("Continue in Agent Hub"));
  await choose(1);
  await until("finished boundary selector", async () => (await text()).includes("Continue through a finished native turn"));
  await keys("enter");
  await until("explicit continuation question", async () => (await text()).includes("Continue in a new Codex Hub child"));
  assert.equal(mutations().length, beforeHistory, "history and boundary inspection submit no native mutation");
  await capture("history question before explicit submission");
  await enter(QUESTION);
  const expectedTurns = mode === "mixed" ? 2 : 1;
  await until("native history fork and explicit question", async () => {
    const document = await frame();
    if (document.includes("Question draft retained")) throw new Error(`History continuation refused:\n${document}`);
    return sent("thread/fork").length === 1 && sent("turn/start").length === expectedTurns;
  });
  const fork = sent("thread/fork")[0];
  assert.equal(fork.threadId, SOURCE);
  assert.equal(fork.lastTurnId, BOUNDARY);
  const first = sent("turn/start").at(-1);
  const childThread = first.threadId;
  assert.notEqual(childThread, SOURCE);
  assert.ok(JSON.stringify(first.input).includes(QUESTION));
  assert.ok(!JSON.stringify(first.input).includes(OLD), "saved transcript must stay native, not be replayed as a prompt");
  assert.deepEqual(store().threads[SOURCE], source);
  await until("first child native completion", () => store().threads[childThread].turns.at(-1).status === "completed");
  await keys("M-a");
  await until("new child in native Agent Hub", async () => {
    const painted = await text();
    return painted.includes("Agent Hub") && painted.includes("Roster") && painted.includes("jobs-history");
  });
  await capture("continued native history child in Agent Hub");
  await keys("C-u");
  await keys("escape");

  let jobs;
  await until("completed child visible in jobs", async () => {
    jobs = await rawCommand("/codex jobs --json", "jobs");
    return jobs.value.some(job => job.kind === "hub" && job.threadId === childThread && job.status === "completed");
  });
  assert.equal(jobs.value.filter(job => job.kind === "hub").length, 1);
  assert.ok(jobs.value.find(job => job.threadId === childThread).name.includes("jobs-history-child-7b2f"), "Hub job name identifies the submitted question");
  assert.equal(jobs.value.filter(job => job.kind === "direct").length, mode === "mixed" ? 1 : 0);
  const status = await rawCommand("/codex status --json", "status");
  assert.ok(status.threads.every(thread => thread.threadId !== childThread), "direct client must not acquire Hub thread ownership");
  const beforeDetails = mutations().length;
  await jobAction("View details", childThread);
  await until("job details rendered in base document", async () => (await frame()).includes("Selected status"));
  assert.equal(mutations().length, beforeDetails, "job enumeration and details do not mutate native work");
  await capture("current direct and Hub jobs, details");

  await jobAction("Send message", childThread);
  await until("message input", async () => (await text()).includes("Message to"));
  assert.equal(sent("turn/start").length, expectedTurns, "opening a message editor submits no prompt");
  await enter(FOLLOWUP);
  await until("follow-up on same Hub child", () => sent("turn/start").length === expectedTurns + 1 || sent("turn/steer").length === 1);
  const followup = sent("turn/steer").at(-1) ?? sent("turn/start").at(-1);
  assert.equal(followup.threadId, childThread);
  assert.ok(JSON.stringify(followup.input).includes(FOLLOWUP));
  assert.ok(!JSON.stringify(followup.input).includes(OLD) && !JSON.stringify(followup.input).includes(QUESTION), "follow-up must not replay prior input");
  assert.equal(sent("thread/fork").length, 1);
  await capture("same Hub child running follow-up");
  await jobAction("Interrupt", childThread);
  await until("selected Hub child interrupt", () => sent("turn/interrupt").length === 1);
  assert.equal(sent("turn/interrupt")[0].threadId, childThread);
  await until("Hub native interruption confirmed", () => store().threads[childThread].turns.at(-1).status === "interrupted");
  if (mode === "mixed") {
    const direct = sent("turn/start")[0];
    assert.equal(store().threads[direct.threadId].turns.at(-1).status, "inProgress", "interrupting Hub child leaves direct worker running");
  }
  assert.deepEqual(store().threads[SOURCE], source);
  assert.equal(sent("thread/start").length, mode === "mixed" ? 1 : 0, "history continuation forks context instead of starting an empty native thread");
  assert.ok(sent("thread/resume").every(params => params.threadId !== SOURCE), "source inspection must not attach or resume the source");
  assert.equal(sent("turn/start").length, expectedTurns + 1);
  assert.equal(sent("turn/steer").length, 0);
  assert.equal(jsonl(join(fixture, "provider-dispatch.jsonl")).length, parentDispatchBaseline,
    "operator continuation and job controls never dispatch the parent model");
  await capture("only chosen Hub child interrupted");
  verified = counts();
} catch (error) {
  if (connection) {
    try { await capture("failure"); } catch { /* Boot failures may not expose the debug socket. */ }
  }
  writeFileSync(join(fixture, "terminal.log"), output.join(""));
  writeFileSync(join(fixture, "screens.json"), JSON.stringify(screenshots, null, 2));
  console.error(`hub-jobs ${mode}: FAIL; isolated artifacts kept at ${fixture}`);
  console.error(output.join("").slice(-4096));
  throw error;
} finally {
  connection?.destroy();
  if (proc) { proc.kill(); await proc.exited; }
}
console.log(`hub-jobs ${mode}: PASS ${JSON.stringify(verified)}`);
rmSync(fixture, { recursive: true, force: true });
