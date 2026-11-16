// Bun only (imports the TypeScript extension): `bun test ./test/provider.test.mjs` from the repository root.
// The extension's default `codex app-server --stdio` command resolves to a temporary `codex` executable
// that runs the protocol double in client.test.mjs; no Codex process or inference is involved.
import assert from 'node:assert/strict';
import { afterAll, mock, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import Ajv from 'ajv';
import * as zod from 'zod';
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const validateJsonSchemaValue = (schema, value) => {
  const validate = ajv.compile(schema);
  const success = validate(value);
  return {
    success,
    issues: (validate.errors ?? []).map(error => ({ path: error.instancePath.split('/').slice(1), message: error.message })),
  };
};

// Plain Bun supplies a test host with public Ajv/Zod and a canonical stream container.
// Production uses OMP's root validateJsonSchemaValue export; hub-smoke covers that real runtime.
// Every assistant event below still comes from the production provider.
class AssistantMessageEventStream {
  #queue = [];
  #waiting = [];
  #done = false;
  #result = Promise.withResolvers();
  push(event) {
    if (this.#done) return;
    if (event.type === 'done' || event.type === 'error') {
      this.#done = true;
      this.#result.resolve(event.type === 'done' ? event.message : event.error);
    }
    const waiter = this.#waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.#queue.push(event);
    if (this.#done) for (const rest of this.#waiting.splice(0)) rest({ value: undefined, done: true });
  }
  end(result) {
    this.#done = true;
    if (result) this.#result.resolve(result);
    for (const rest of this.#waiting.splice(0)) rest({ value: undefined, done: true });
  }
  result() { return this.#result.promise; }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#queue.length) return Promise.resolve({ value: this.#queue.shift(), done: false });
        if (this.#done) return Promise.resolve({ value: undefined, done: true });
        const { promise, resolve } = Promise.withResolvers();
        this.#waiting.push(resolve);
        return promise;
      },
    };
  }
}
mock.module('@oh-my-pi/pi-ai', () => ({
  AssistantMessageEventStream, validateJsonSchemaValue,
  isValidJsonSchema: schema => ajv.validateSchema(schema),
}));
// The provider's per-session records go to a temporary directory of this test file, never
// ~/.omp/agent/codex-bridge-state. Any value exported by the calling shell is overridden. The extension
// reads the variable once at import, so it is set here; each withHost empties the directory afterwards.
const STATE_DIR = mkdtempSync(join(tmpdir(), 'codex-bridge-state-'));
const previousStateDir = process.env.OMP_CODEX_BRIDGE_STATE_DIR;
process.env.OMP_CODEX_BRIDGE_STATE_DIR = STATE_DIR;
mock.module('@oh-my-pi/pi-coding-agent', () => ({
  getAgentDir: () => STATE_DIR,
}));
afterAll(() => {
  rmSync(STATE_DIR, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.OMP_CODEX_BRIDGE_STATE_DIR;
  else process.env.OMP_CODEX_BRIDGE_STATE_DIR = previousStateDir;
});
const { default: extension } = await import('../extensions/codex-bridge.ts');

const cwd = realpathSync(process.cwd());
const FAKE = fileURLToPath(new URL('./client.test.mjs', import.meta.url));
// The double runs on Node, as in client.test.mjs; Bun is only needed to load the TypeScript extension.
const FAKE_RUNTIME = Bun.which('node') ?? process.execPath;
// Same final text as the double's `big` turns: 700 KB of UTF-8.
const BIG_TEXT = '가🙂'.repeat(100000);
const LIMIT = 24 * 1024;
const TIMEOUT = 20000;
const MUTATIONS = new Set(['thread/start', 'thread/resume', 'thread/fork', 'thread/compact/start', 'turn/start', 'turn/steer', 'turn/interrupt']);
const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

function trace(dir) {
  const path = join(dir, 'trace.jsonl');
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
const prompts = (dir) => trace(dir).filter(({ message }) => message?.method === 'turn/start').map(({ message }) => message.params.input[0].text);
const mutations = (dir) => trace(dir).filter(({ message }) => MUTATIONS.has(message?.method));
const spawns = (dir) => trace(dir).filter(({ spawn }) => spawn).length;

async function until(probe) {
  const deadline = Date.now() + 5000;
  while (!(await probe())) {
    if (Date.now() > deadline) assert.fail('Condition timed out');
    await delay(5);
  }
}

// Loads the extension into a minimal host that records its tool, providers, lifecycle handlers and
// follow-ups. `child(name)` binds the same factory again as OMP does for each task child session
// (module state shared, fresh API) and announces it with session_start carrying ctx.agent.
async function withHost(options, store, body) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-bridge-ext-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'options.json'), JSON.stringify(options));
  if (store) writeFileSync(join(dir, 'store.json'), JSON.stringify(store));
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec ${quote(FAKE_RUNTIME)} ${quote(FAKE)} --fake-app-server\n`);
  chmodSync(join(bin, 'codex'), 0o755);
  const previous = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, OMP_CODEX_BRIDGE_CONFIG: process.env.OMP_CODEX_BRIDGE_CONFIG };
  process.env.PATH = `${bin}${delimiter}${previous.PATH ?? ''}`;
  process.env.CODEX_HOME = dir;
  delete process.env.OMP_CODEX_BRIDGE_CONFIG;
  // Not thenable, so awaiting an inert result does not hang.
  const anything = new Proxy(() => {}, { get: (_target, key) => (key === 'then' ? undefined : anything), apply: () => anything });
  const bound = [];
  const bind = async (agent) => {
    const tools = new Map();
    const providers = new Map();
    const handlers = new Map();
    const followUps = [];
    const api = {
      zod,
      registerTool: (tool) => tools.set(tool.name, tool),
      registerCommand: () => {},
      getServiceTiers: () => options.ompServiceTier ? { openai: options.ompServiceTier } : {},
      registerProvider: (name, config) => providers.set(name, config),
      // Several registrations of one event all run, as in the host.
      on: (event, handler) => {
        const previous = handlers.get(event);
        handlers.set(event, previous ? (...args) => Promise.all([previous(...args), handler(...args)]) : handler);
      },
      sendMessage: (message, options) => followUps.push({
        message, options,
        bytes: Buffer.byteLength(message.content),
        summary: JSON.parse(message.content.slice(message.content.indexOf('\n') + 1)),
      }),
    };
    // Host surfaces this harness does not model are inert.
    await extension(new Proxy(api, { get: (target, key) => (key in target ? target[key] : anything) }));
    const ctx = new Proxy({
      cwd,
      mode: 'json', hasUI: false,
      ui: { notify() {}, setStatus() {} },
      sessionManager: {
        getSessionId: () => agent ? `${agent}-child` : 'fixture-main',
        getBranch: () => [], getEntry: () => undefined,
      },
      agent: agent ? { kind: 'sub', id: `${agent}-child`, name: agent, depth: 1, parentId: 'Main' } : { kind: 'main', id: 'Main', name: 'main', depth: 0 },
    }, { get: (target, key) => (key in target ? target[key] : anything) });
    const tool = tools.get('codex_bridge');
    const call = async (params) => {
      const result = await tool.execute('call', params, undefined, undefined, ctx);
      const text = result.content[0].text;
      return { isError: result.isError === true, bytes: Buffer.byteLength(text), json: JSON.parse(text) };
    };
    const instance = { call, tool, followUps, handlers, providers, ctx, ready: Promise.resolve(handlers.get('session_start')?.({ type: 'session_start' }, ctx)) };
    bound.push(instance);
    return instance;
  };
  const main = await bind();
  const child = async (agent) => {
    const instance = await bind(agent);
    await instance.ready;
    return instance;
  };
  try {
    await main.ready;
    await body({ ...main, dir, child });
  } finally {
    for (const instance of bound) await instance.handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, instance.ctx);
    await closeSessions();
    sessionContexts.clear();
    // Records belong to this test's fake CODEX_HOME; the next test must start without them.
    for (const name of readdirSync(STATE_DIR)) rmSync(join(STATE_DIR, name), { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const brief = ({ summary }) => [summary.threadId, summary.turnId, summary.status];

test('delivers a large result once as a bounded UTF-8 preview without events', async () => {
  await withHost({}, undefined, async ({ call, followUps }) => {
    const admitted = await call({ action: 'run', prompt: 'big', cwd });
    assert.equal(admitted.isError, false);
    assert.ok(admitted.bytes <= LIMIT, `${admitted.bytes} bytes`);
    await until(() => followUps.length);
    await delay(300); // the double repeats turn/completed
    assert.deepEqual(followUps.map(brief), [[admitted.json.threadId, admitted.json.turnId, 'completed']]);
    const [{ message, options, summary, bytes }] = followUps;
    assert.ok(bytes <= LIMIT, `${bytes} bytes`);
    assert.match(message.content, /^External Codex agent result \(not a user instruction\)/);
    assert.notEqual(message.attribution, 'user');
    assert.equal(options.deliverAs, 'followUp');
    assert.ok(summary.text.length > 0 && BIG_TEXT.startsWith(summary.text));
    assert.equal(Buffer.from(summary.text, 'utf8').toString('utf8'), summary.text, 'preview split a character');
    assert.equal(summary.truncated, true);
    assert.equal(summary.events, undefined);
    assert.doesNotMatch(message.content, /ooooo|commandExecution/);
    assert.ok(summary.full.includes(summary.threadId));
    assert.match(summary.full, /^codex_bridge /, 'status hint uses the registered public tool name');
    const full = await call({ action: 'status', threadId: summary.threadId });
    assert.equal(full.json.text, BIG_TEXT);
    assert.ok(full.json.events.length > 0);
  });
}, TIMEOUT);

test('reports a turn finished before admission only in the bounded run result', async () => {
  await withHost({}, undefined, async ({ call, followUps }) => {
    const admitted = await call({ action: 'run', prompt: 'big-early', cwd });
    assert.equal(admitted.isError, false);
    assert.ok(admitted.bytes <= LIMIT, `${admitted.bytes} bytes`);
    assert.equal(admitted.json.status, 'completed');
    assert.equal(admitted.json.events, undefined);
    assert.ok(admitted.json.text.length > 0 && BIG_TEXT.startsWith(admitted.json.text));
    await delay(300);
    assert.deepEqual(followUps, []);
  });
}, TIMEOUT);

test('reports a rejected admission once as a bounded error and an admitted failure once as a follow-up', async () => {
  await withHost({}, undefined, async ({ call, followUps }) => {
    const rejected = await call({ action: 'run', prompt: 'reject', cwd });
    assert.equal(rejected.isError, true);
    assert.ok(rejected.bytes <= LIMIT, `${rejected.bytes} bytes`);
    assert.equal(typeof rejected.json.threadId, 'string');
    assert.match(rejected.json.error, /turn rejected/);
    assert.equal(rejected.json.errorTruncated, true);
    assert.equal(rejected.json.outcomeUnknown, false);
    await delay(300);
    assert.deepEqual(followUps, []);
    const admitted = await call({ action: 'run', threadId: rejected.json.threadId, prompt: 'fail-later', cwd });
    assert.equal(admitted.isError, false);
    await until(() => followUps.length);
    await delay(300);
    assert.deepEqual(followUps.map(brief), [[rejected.json.threadId, admitted.json.turnId, 'failed']]);
    assert.match(followUps[0].summary.error, /quota exhausted/);
  });
}, TIMEOUT);

test('passes permission refusals through as structured errors without starting or reporting a turn', async () => {
  await withHost({ nativeErrors: { 'thread/start': -32099 } }, undefined, async ({ call, followUps, dir }) => {
    const refused = await call({ action: 'run', prompt: 'must not run', cwd });
    assert.equal(refused.isError, true);
    assert.equal(refused.json.code, -32099);
    await delay(200);
    assert.deepEqual(prompts(dir), []);
    assert.deepEqual(followUps, []);
  });
}, TIMEOUT);

test('never delivers results of threads the session did not run', async () => {
  await withHost({}, undefined, async ({ call, followUps }) => {
    const admitted = await call({ action: 'run', prompt: 'child', cwd });
    await until(() => followUps.length);
    await delay(300);
    assert.deepEqual(followUps.map(brief), [[admitted.json.threadId, admitted.json.turnId, 'completed']]);
    assert.doesNotMatch(JSON.stringify(followUps.map(({ message }) => message)), /child-thread|child secret/);
  });
}, TIMEOUT);

test('status reads a saved thread without mutating it or subscribing to its results', async () => {
  const store = {
    nextThread: 0, nextTurn: 100, threads: { 'saved-thread': { id: 'saved-thread', cwd, turns: [{
      id: 'turn-saved', prompt: '', status: 'completed', error: null,
      items: [{ type: 'agentMessage', id: 'answer', text: 'saved answer', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null }],
    }] } },
  };
  await withHost({}, store, async ({ call, followUps, dir }) => {
    assert.deepEqual((await call({ action: 'status' })).json, []);
    assert.equal(spawns(dir), 0, 'listing local threads must not start a server');
    const saved = await call({ action: 'status', threadId: 'saved-thread' });
    assert.equal(saved.isError, false);
    assert.equal(saved.json.turnId, 'turn-saved');
    assert.equal(saved.json.status, 'completed');
    assert.equal(saved.json.text, 'saved answer');
    const missing = await call({ action: 'status', threadId: 'missing-thread' });
    assert.equal(missing.isError, true);
    assert.deepEqual((await call({ action: 'status' })).json, []);
    assert.deepEqual(mutations(dir), []);
    await delay(200);
    assert.deepEqual(followUps, []);
  });
}, TIMEOUT);

test('direct run inherits native policy and exposes no model-controlled sandbox or config parameter', async () => {
  await withHost({}, undefined, async ({ call, tool, dir }) => {
    assert.equal(Object.hasOwn(tool.parameters.shape, 'sandbox'), false);
    assert.equal(Object.hasOwn(tool.parameters.shape, 'config'), false);
    assert.equal(tool.parameters.safeParse({ action: 'run', prompt: 'x', sandbox: 'danger-full-access' }).success, false);
    const admitted = await call({ action: 'run', prompt: 'native defaults' });
    assert.equal(admitted.isError, false);
    const [start] = sentParams(dir, 'thread/start');
    assert.equal(start.cwd, cwd);
    for (const params of [start, ...sentParams(dir, 'turn/start')]) {
      assert.equal(Object.hasOwn(params, 'sandbox'), false);
      assert.equal(Object.hasOwn(params, 'sandboxPolicy'), false);
      assert.equal(Object.hasOwn(params, 'approvalPolicy'), false);
    }
  });
}, TIMEOUT);

test('run never resumes a thread this server lifecycle did not start, including its own after shutdown', async () => {
  const store = { nextThread: 0, nextTurn: 100, threads: { 'saved-thread': { id: 'saved-thread', cwd, turns: [] } } };
  await withHost({}, store, async ({ call, followUps, dir }) => {
    const notOwned = (result) => {
      assert.equal(result.isError, true);
      assert.equal(result.json.code, 'THREAD_NOT_OWNED');
      assert.match(result.json.error, /was not started by this session's Codex server/);
      assert.match(result.json.error, /run without threadId to start a new thread/);
    };
    notOwned(await call({ action: 'run', threadId: 'saved-thread', prompt: 'must not run', cwd }));
    assert.deepEqual(mutations(dir), [], 'no thread/resume or turn/start');
    const own = await call({ action: 'run', prompt: 'finish-later', cwd });
    assert.equal(own.isError, false);
    await until(() => followUps.length === 1);
    assert.equal((await call({ action: 'shutdown' })).json.stopped, true);
    const before = mutations(dir).length;
    notOwned(await call({ action: 'run', threadId: own.json.threadId, prompt: 'must not run', cwd }));
    assert.equal(mutations(dir).length, before);
    // Reading stays available.
    assert.equal((await call({ action: 'status', threadId: own.json.threadId })).isError, false);
    assert.equal(sentParams(dir, 'thread/resume').length, 0);
  });
}, TIMEOUT);

test('recovers from an app-server crash on the next explicit run without shutdown', async () => {
  await withHost({}, undefined, async ({ call, followUps, dir }) => {
    // Turns finish after admission: a turn finished before its run returns is reported by the run instead.
    const first = await call({ action: 'run', prompt: 'finish-later', cwd });
    await until(() => followUps.length === 1);
    const crashed = await call({ action: 'run', prompt: 'crash-later', cwd });
    await until(() => followUps.length === 2);
    assert.equal(followUps[1].summary.outcomeUnknown, true);
    const next = await call({ action: 'run', threadId: first.json.threadId, prompt: 'finish-later', cwd });
    assert.equal(next.isError, false);
    await until(() => followUps.length === 3);
    await delay(200);
    assert.deepEqual(followUps.map(brief), [
      [first.json.threadId, first.json.turnId, 'completed'],
      [crashed.json.threadId, crashed.json.turnId, 'disconnected'],
      [first.json.threadId, next.json.turnId, 'completed'],
    ]);
    assert.equal(spawns(dir), 2);
    assert.deepEqual(prompts(dir), ['finish-later', 'crash-later', 'finish-later']);
  });
}, TIMEOUT);

test('a session switch during admission does not suppress the next session results', async () => {
  await withHost({ slowExit: 200 }, undefined, async ({ call, followUps, handlers, dir, ctx }) => {
    const old = call({ action: 'run', prompt: 'slow-admit', cwd });
    await until(() => prompts(dir).includes('slow-admit'));
    const oldPid = trace(dir).find(entry => entry.spawn).pid;
    // The new session's run starts before the old run's continuation settles.
    const nextContext = {
      ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => 'fixture-main-switched' },
    };
    const switched = handlers.get('session_switch')({
      type: 'session_switch', reason: 'new', previousSessionFile: undefined,
    }, nextContext);
    const current = call({ action: 'run', prompt: 'finish-later', cwd });
    await until(() => spawns(dir) === 2);
    assert.throws(() => process.kill(oldPid, 0), error => error.code === 'ESRCH',
      'the replacement native process must wait for the previous process to exit');
    const [stale, fresh] = await Promise.all([old, current, switched]);
    assert.equal(stale.isError, true, JSON.stringify(stale.json));
    assert.equal(fresh.isError, false, JSON.stringify(fresh.json));
    await until(() => followUps.length);
    await delay(300);
    assert.deepEqual(followUps.map(brief), [[fresh.json.threadId, fresh.json.turnId, 'completed']]);
    const again = await call({ action: 'run', threadId: fresh.json.threadId, prompt: 'finish-later', cwd });
    await until(() => followUps.length === 2);
    await delay(200);
    assert.deepEqual(followUps.map(brief).at(-1), [fresh.json.threadId, again.json.turnId, 'completed']);
    assert.equal(followUps.length, 2);
  });
}, TIMEOUT);

// ---------------------------------------------------------------------------------------------------
// Command-backed provider `codex-bridge` (the model of the codex-bridge task agent), driven exactly as
// OMP's agent loop drives it: cfg.streamSimple(model, context, options) with the stable child session
// id, cwd, abort signal and live-steering source, consuming the canonical AssistantMessageEventStream.
// Behaviour of the fake app-server is scripted per turn/start by options.json `turns`.

const PROVIDER = 'codex-bridge';
const user = (text, extra = {}) => ({ role: 'user', content: text, timestamp: Date.now(), ...extra });
const sentParams = (dir, method) => trace(dir).filter(({ message }) => message?.method === method).map(({ message }) => message.params);
const inputText = (params) => JSON.stringify(params.input);

// Default: the model the codex-bridge task agent pins (agentModel is hoisted).
function providerModel(providers, pick = agentModel('codex-bridge')) {
  const config = providers.get(PROVIDER);
  assert.ok(config, `extension registers provider ${PROVIDER}`);
  assert.equal(typeof config.streamSimple, 'function');
  const model = pick(config.models);
  assert.ok(model, 'provider model');
  return { config, model: { ...model, provider: PROVIDER, api: model.api ?? config.api, baseUrl: config.baseUrl } };
}

// OMP's per-session provider state: one Map per session id, closed when the session is disposed.
const sessionStates = new Map();
const sessionContexts = new Map();
const sessionState = (sessionId) => {
  if (!sessionStates.has(sessionId)) sessionStates.set(sessionId, new Map());
  return sessionStates.get(sessionId);
};
async function closeSessions(...ids) {
  const closing = [];
  for (const id of ids.length ? ids : [...sessionStates.keys()]) {
    for (const state of sessionStates.get(id)?.values() ?? []) closing.push(state.close?.());
    sessionStates.delete(id);
  }
  await Promise.all(closing);
}

// Runs one provider request to its terminal event (bounded by the test timeout); returns every event
// and the final message.
async function stream(providers, context, options = {}, pick) {
  const { config, model } = providerModel(providers, pick);
  const events = [];
  const { outputSchema, ...requestContext } = context;
  const ctx = sessionContexts.get(options.sessionId) ?? lifecycleContext(options.sessionId, model, [
    { id: 'fixture-init', parentId: null, type: 'session_init', outputSchema },
  ]);
  ctx.model = model;
  const adapted = config.streamSimple.context({ messages: requestContext.messages }, ctx);
  const result = config.streamSimple(model, {
    systemPrompt: ['fixture system prompt'], tools: [], ...requestContext,
    messages: adapted?.messages ?? requestContext.messages,
  }, {
    cwd, ...options,
    onPayload: options.onPayload ?? (payload => config.streamSimple.beforeProviderRequest({ type: 'before_provider_request', payload }, ctx)),
    providerSessionState: options.sessionId ? sessionState(options.sessionId) : undefined,
  });
  for await (const event of result) {
    events.push(event);
    if (event.type === 'done' || event.type === 'error') break;
  }
  const final = events.at(-1);
  assert.ok(final?.type === 'done' || final?.type === 'error', `stream ended with ${final?.type}`);
  return { events, final, message: final.type === 'done' ? final.message : final.error };
}

const textOf = (message) => message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
const toolCalls = (events) => events.filter((event) => event.type === 'toolcall_end').map((event) => event.toolCall.name);

test('provider streams native progress and the final answer as assistant events; native tools never become OMP tool calls', async () => {
  await withHost({ turns: ['progress'] }, undefined, async ({ providers, dir, followUps }) => {
    const { events, final, message } = await stream(providers, { messages: [user('inspect the repo')] }, { sessionId: 'session-a' });
    assert.equal(final.type, 'done', JSON.stringify(message.errorMessage));
    assert.equal(final.reason, 'stop');
    assert.equal(events[0].type, 'start');
    assert.deepEqual(toolCalls(events), [], 'a native commandExecution must not be emitted as an executable OMP tool call');
    assert.ok(message.content.every((block) => block.type !== 'toolCall'));
    // Native activity is visible before the result: some streamed event before `done` names the native command.
    const progress = events.slice(0, -1).map((event) => event.delta ?? event.content ?? '').join('\n');
    assert.match(progress, /ls -la|commandExecution|fixture command output/, 'native progress visible in the stream');
    assert.match(textOf(message), /done: /);
    // Native configuration supplies policy; the bridge preserves only the working directory.
    const [start] = sentParams(dir, 'thread/start');
    assert.equal(Object.hasOwn(start, 'sandbox'), false);
    assert.equal(Object.hasOwn(start, 'approvalPolicy'), false);
    assert.equal(start.cwd, cwd);
    assert.equal(Object.hasOwn(sentParams(dir, 'turn/start')[0], 'sandboxPolicy'), false);
    // The child's result reaches the parent through the task result only, never as a tool follow-up.
    await delay(300);
    assert.deepEqual(followUps, []);
  });
}, TIMEOUT);

test('provider keeps one native thread per OMP session and sends only the new prompt on follow-up', async () => {
  await withHost({ turns: ['finish-later', 'finish-later', 'finish-later'] }, undefined, async ({ providers, dir }) => {
    const first = await stream(providers, { messages: [user('first question')] }, { sessionId: 'session-a' });
    assert.equal(first.final.type, 'done');
    const history = [user('first question'), first.message, user('second question')];
    const second = await stream(providers, { messages: history }, { sessionId: 'session-a' });
    assert.equal(second.final.type, 'done');
    const other = await stream(providers, { messages: [user('other session question')] }, { sessionId: 'session-b' });
    assert.equal(other.final.type, 'done');
    const starts = sentParams(dir, 'thread/start');
    assert.equal(starts.length, 2, 'one thread per session id');
    const turns = sentParams(dir, 'turn/start');
    assert.equal(turns.length, 3);
    assert.equal(turns[0].threadId, turns[1].threadId, 'follow-up continues the session thread');
    assert.notEqual(turns[2].threadId, turns[0].threadId, 'another session gets its own thread');
    // Codex holds the conversation: the follow-up is not a replay of the OMP transcript.
    assert.match(inputText(turns[1]), /second question/);
    assert.doesNotMatch(inputText(turns[1]), /first question/);
    assert.match(inputText(turns[2]), /other session question/);
    assert.doesNotMatch(inputText(turns[2]), /first question|second question/);
  });
}, TIMEOUT);

test('provider reports a native usage-limit failure as a stream error and a host retry does not start another turn', async () => {
  await withHost({ turns: ['usage-limit', 'finish-later'] }, undefined, async ({ providers, dir }) => {
    const context = { messages: [user('quota-limited task')] };
    const failed = await stream(providers, context, { sessionId: 'session-a' });
    assert.equal(failed.final.type, 'error');
    assert.equal(failed.final.reason, 'error');
    assert.equal(failed.message.stopReason, 'error');
    assert.match(failed.message.errorMessage, /usage limit/);
    assert.equal(textOf(failed.message), '', 'no fabricated answer');
    // OMP classifies usage-limit text as retriable and may replay the identical request.
    const replay = await stream(providers, context, { sessionId: 'session-a' });
    assert.equal(replay.final.type, 'error');
    assert.equal(sentParams(dir, 'turn/start').length, 1, 'a replayed request must not resubmit native work');
  });
}, TIMEOUT);

test('provider abort interrupts the active native turn once and reports aborted', async () => {
  await withHost({ turns: ['work'] }, undefined, async ({ providers, dir }) => {
    const controller = new AbortController();
    const running = stream(providers, { messages: [user('long task')] }, { sessionId: 'session-a', signal: controller.signal });
    await until(() => sentParams(dir, 'turn/start').length === 1);
    await delay(200);
    controller.abort();
    const { final, message } = await running;
    assert.equal(final.type, 'error');
    assert.equal(final.reason, 'aborted');
    assert.equal(message.stopReason, 'aborted');
    await until(() => sentParams(dir, 'turn/interrupt').length === 1);
    await delay(300);
    assert.equal(sentParams(dir, 'turn/interrupt').length, 1);
    assert.equal(sentParams(dir, 'turn/interrupt')[0].turnId, 'turn-1');
    assert.equal(sentParams(dir, 'turn/start').length, 1);
  });
}, TIMEOUT);

test('provider reports a lost app-server as an unknown outcome and never resubmits the turn', async () => {
  await withHost({ turns: ['crash-later', 'finish-later'] }, undefined, async ({ providers, dir }) => {
    const context = { messages: [user('task whose server dies')] };
    const lost = await stream(providers, context, { sessionId: 'session-a' });
    assert.equal(lost.final.type, 'error');
    assert.match(lost.message.errorMessage, /unknown|disconnected/i);
    const replay = await stream(providers, context, { sessionId: 'session-a' });
    assert.equal(replay.final.type, 'error');
    assert.equal(sentParams(dir, 'turn/start').length, 1, 'no automatic resubmission after an unknown outcome');
    assert.equal(spawns(dir) <= 2, true);
  });
}, TIMEOUT);

test('provider answers task yield reminders without another native turn', async () => {
  await withHost({ turns: ['finish-later', 'finish-later'] }, undefined, async ({ providers, dir }) => {
    const yieldTool = { name: 'yield', description: 'Finish the task', parameters: { type: 'object', properties: {} } };
    const first = await stream(providers, { messages: [user('structured task')], tools: [yieldTool] }, { sessionId: 'session-a' });
    assert.equal(first.final.type, 'done');
    assert.deepEqual(toolCalls(first.events).filter((name) => name !== 'yield'), [], 'native work never becomes an OMP tool call');
    // OMP's executor sends the reminder through session.prompt(..., { synthetic: true, attribution: 'agent' }),
    // which records it as a synthetic developer message (agent-session.ts synthetic prompt branch).
    const reminder = {
      role: 'developer', synthetic: true, attribution: 'agent', timestamp: Date.now(),
      content: '<system-reminder>\nLast turn had no tool call → session idle. Reminder 1 of 3.\n</system-reminder>',
    };
    const answered = await stream(providers, { messages: [user('structured task'), first.message, reminder], tools: [yieldTool] }, { sessionId: 'session-a' });
    assert.equal(answered.final.type, 'done');
    assert.deepEqual(toolCalls(answered.events), ['yield'], 'the reminder is answered with the OMP yield tool only');
    assert.equal(sentParams(dir, 'turn/start').length, 1, 'a yield reminder must not start a native turn');
    assert.equal(sentParams(dir, 'turn/steer').length, 0);
  });
}, TIMEOUT);

test('provider delivers claimed live steering to the active native turn exactly once', async () => {
  await withHost({ turns: ['work'] }, undefined, async ({ providers, dir }) => {
    let offered = false;
    const settled = [];
    const { promise: ready, resolve: open } = Promise.withResolvers();
    const aborted = (signal) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    // Like OMP's queue: wait() resolves while steering is claimable, then only on abort.
    const liveSteering = {
      wait: (signal) => (offered ? aborted(signal) : Promise.race([ready, aborted(signal)])),
      claim: async () => {
        if (offered) return undefined;
        offered = true;
        return {
          messages: [user('steer: also check tests')],
          accept: () => settled.push('accept'),
          reject: () => settled.push('reject'),
        };
      },
    };
    const running = stream(providers, { messages: [user('active task')] }, { sessionId: 'session-a', liveSteering });
    await until(() => sentParams(dir, 'turn/start').length === 1);
    await delay(200);
    open();
    const { final, message } = await running;
    assert.equal(final.type, 'done');
    const steers = sentParams(dir, 'turn/steer');
    assert.equal(steers.length, 1);
    assert.equal(steers[0].expectedTurnId, 'turn-1');
    assert.match(inputText(steers[0]), /steer: also check tests/);
    assert.deepEqual(settled, ['accept']);
    assert.match(textOf(message), /steered: /);
    assert.equal(sentParams(dir, 'turn/start').length, 1);
  });
}, TIMEOUT);

test('provider and the direct codex_bridge tool coexist without crossing results', async () => {
  await withHost({ turns: ['finish-later', 'finish-later'] }, undefined, async ({ providers, call, followUps, dir }) => {
    const provided = await stream(providers, { messages: [user('provider task')] }, { sessionId: 'session-a' });
    assert.equal(provided.final.type, 'done');
    const direct = await call({ action: 'run', prompt: 'direct task', cwd });
    assert.equal(direct.isError, false);
    await until(() => followUps.length);
    await delay(300);
    // Only the directly run thread produces a follow-up; the provider thread is reported by its stream.
    assert.deepEqual(followUps.map(brief), [[direct.json.threadId, direct.json.turnId, 'completed']]);
    const threads = new Set(sentParams(dir, 'turn/start').map(({ threadId }) => threadId));
    assert.equal(threads.size, 2);
  });
}, TIMEOUT);

// The models a task agent definition names (frontmatter `model:` as a YAML list or comma list, OMP's
// parseModelList), in order: OMP runs the first by default, the rest are what a per-call selector may pick.
function agentModels(name) {
  const file = join(fileURLToPath(new URL('../agents/', import.meta.url)), `${name}.md`);
  assert.ok(existsSync(file), `agent definition ${file}`);
  const [, frontmatter = ''] = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/) ?? [];
  const [, inline = '', block = ''] = frontmatter.match(/^model:[ \t]*(.*)\n((?:[ \t]+-.*\n?)*)/m) ?? [];
  const unquote = (value) => value.trim().replace(/^["']|["']$/g, '');
  const list = inline.trim().startsWith('[') ? inline.trim().slice(1, -1).split(',')
    : inline.trim() ? inline.split(',') : block.split('\n').map((line) => line.replace(/^\s*-\s*/, ''));
  return list.map(unquote).filter(Boolean);
}

// The model a task agent runs by default (its first frontmatter candidate), as OMP resolves it.
function agentModel(name) {
  const selector = agentModels(name)[0];
  assert.ok(selector?.startsWith(`${PROVIDER}/`), `${name} pins a ${PROVIDER} model, got ${selector}`);
  const id = selector.slice(PROVIDER.length + 1);
  return (models) => models.find((model) => model.id === id);
}

const NATIVE_MODELS = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];

test('one codex-bridge task agent: the Codex default first, then exact native model selectors without permission prefixes', () => {
  assert.ok(!existsSync(join(fileURLToPath(new URL('../../agents/', import.meta.url)), 'codex-bridge-write.md')), 'no separate write agent');
  const [first, ...rest] = agentModels('codex-bridge');
  assert.equal(first, `${PROVIDER}/default`, 'the Codex default model stays the default');
  // One exact OMP selector each (task/structured-subagent.ts): no whitespace, comma, glob or `@` role.
  for (const selector of rest) assert.match(selector, new RegExp(`^${PROVIDER}/[^\\s,*?{}\\[\\]]+$`), selector);
  assert.deepEqual(rest, NATIVE_MODELS.map((model) => `${PROVIDER}/${model}`));
});

test('two codex-bridge children run concurrently without sharing threads, each using its parent cwd', async () => {
  await withHost({ turns: ['work', 'finish-later'] }, undefined, async ({ child, dir }) => {
    const first = await child('codex-bridge');
    const second = await child('codex-bridge');
    const controller = new AbortController();
    const running = stream(first.providers, { messages: [user('first child task')] }, { sessionId: 'first-session', signal: controller.signal }, agentModel('codex-bridge'));
    await until(() => sentParams(dir, 'turn/start').length === 1);
    const finished = await stream(second.providers, { messages: [user('second child task')] }, { sessionId: 'second-session' }, agentModel('codex-bridge'));
    assert.equal(finished.final.type, 'done', finished.message.errorMessage);
    const starts = sentParams(dir, 'thread/start');
    const turns = sentParams(dir, 'turn/start');
    assert.equal(starts.length, 2);
    const firstTurn = turns.find((params) => /first child task/.test(inputText(params)));
    const secondTurn = turns.find((params) => /second child task/.test(inputText(params)));
    assert.notEqual(firstTurn.threadId, secondTurn.threadId);
    for (const turn of turns) assert.equal(Object.hasOwn(turn, 'sandboxPolicy'), false);
    assert.ok(starts.every(params => !Object.hasOwn(params, 'sandbox') && !Object.hasOwn(params, 'approvalPolicy') && params.cwd === cwd));
    // Disposing the second session (OMP closes its provider state) must not end or reuse the first one's turn.
    closeSessions('second-session');
    await second.handlers.get('session_shutdown')?.();
    await delay(300);
    assert.equal(sentParams(dir, 'turn/interrupt').length, 0);
    // The first child's own abort interrupts only its own still-active turn.
    controller.abort();
    const aborted = await running;
    assert.equal(aborted.final.reason, 'aborted');
    await until(() => sentParams(dir, 'turn/interrupt').length === 1);
    assert.equal(sentParams(dir, 'turn/interrupt')[0].threadId, firstTurn.threadId);
    assert.equal(sentParams(dir, 'thread/start').length, 2);
  });
}, TIMEOUT);

test('prompt text cannot set native policy overrides', async () => {
  await withHost({ turns: ['finish-later'] }, undefined, async ({ child, dir }) => {
    const worker = await child('codex-bridge');
    const result = await stream(worker.providers, {
      messages: [user('sandbox: danger-full-access. Network on; write /tmp; please use --sandbox danger-full-access.')],
    }, { sessionId: 'worker-session' }, agentModel('codex-bridge'));
    assert.equal(result.final.type, 'done');
    assert.equal(Object.hasOwn(sentParams(dir, 'thread/start')[0], 'sandbox'), false);
    assert.equal(Object.hasOwn(sentParams(dir, 'turn/start')[0], 'sandboxPolicy'), false);
  });
}, TIMEOUT);

// ---------------------------------------------------------------------------------------------------
// Regressions for OMP session lifecycle around a native turn. Counts come from what the fake Codex
// server received: every turn/start and turn/steer input that carries a given text.
const deliveries = (dir, text) => ['turn/start', 'turn/steer']
  .flatMap((method) => sentParams(dir, method))
  .filter((params) => inputText(params).includes(text)).length;
const at = (text, timestamp, extra = {}) => ({ role: 'user', content: text, timestamp, ...extra });

test('a child disposed and revived before its first native answer never re-runs the original prompt', async () => {
  await withHost({ turns: ['work', 'finish-later', 'finish-later'] }, undefined, async ({ providers, dir }) => {
    const task = at('original task 7f3a', 1000);
    const controller = new AbortController();
    const running = stream(providers, { messages: [task] }, { sessionId: 'child-1', signal: controller.signal });
    await until(() => sentParams(dir, 'turn/start').length === 1);
    // OMP disposes/parks the child mid-turn: the run is aborted and its provider session state closed.
    controller.abort();
    closeSessions('child-1');
    const aborted = await running;
    assert.equal(aborted.final.type, 'error');
    // Revival without a persisted assistant message (disposed before message_end): the restored
    // context is the original prompt alone, re-driven on the same session id.
    const replayed = await stream(providers, { messages: [task] }, { sessionId: 'child-1' });
    assert.equal(deliveries(dir, 'original task 7f3a'), 1, 'restored context must not resubmit the original prompt');
    // OMP persists that reply; the user then asks again in the revived child: only the new text goes to
    // Codex, on the same thread.
    const followed = await stream(providers, { messages: [task, replayed.message, at('revived follow-up 7f3a', 3000)] }, { sessionId: 'child-1' });
    const why = `replay: ${replayed.final.type} ${replayed.message.errorMessage ?? ''}; follow-up: ${followed.final.type} ${followed.message.errorMessage ?? ''}; record: ${readFileSync(recordFile('child-1'), 'utf8')}; native calls: ${JSON.stringify(mutations(dir).map(({ message }) => message.method))}`;
    assert.equal(deliveries(dir, 'original task 7f3a'), 1, `follow-up after revival must not resend the original prompt (${why})`);
    assert.equal(deliveries(dir, 'revived follow-up 7f3a'), 1, why);
    assert.equal(sentParams(dir, 'thread/start').length, 1, 'the revived child keeps its native thread');
    const threads = new Set(sentParams(dir, 'turn/start').map(({ threadId }) => threadId));
    assert.equal(threads.size, 1);
  });
}, TIMEOUT);

test('a child revived from a persisted aborted turn continues its thread without resending the prompt', async () => {
  await withHost({ turns: ['work', 'finish-later'] }, undefined, async ({ providers, dir }) => {
    const task = at('original task 9c1d', 1000);
    const controller = new AbortController();
    const running = stream(providers, { messages: [task] }, { sessionId: 'child-2', signal: controller.signal });
    await until(() => sentParams(dir, 'turn/start').length === 1);
    controller.abort();
    const aborted = await running;
    assert.equal(aborted.final.reason, 'aborted');
    closeSessions('child-2');
    // OMP persisted the aborted assistant message; revival rebuilds the context from the session file.
    const persisted = structuredClone(aborted.message);
    const revived = await stream(providers, { messages: [task, persisted, at('continue 9c1d', 3000)] }, { sessionId: 'child-2' });
    assert.equal(revived.final.type, 'done', revived.message.errorMessage);
    assert.equal(deliveries(dir, 'original task 9c1d'), 1);
    assert.equal(deliveries(dir, 'continue 9c1d'), 1);
    assert.equal(sentParams(dir, 'thread/start').length, 1, 'the persisted turn identifies the native thread');
    assert.equal(new Set(sentParams(dir, 'turn/start').map(({ threadId }) => threadId)).size, 1);
  });
}, TIMEOUT);

test('an accepted live steer is not delivered again when OMP requeues it after an abort', async () => {
  await withHost({ turns: ['work', 'finish-later'], steerHolds: true }, undefined, async ({ providers, dir }) => {
    const task = at('steered task 4b2e', 1000);
    const steer = at('live steer 4b2e', 2000);
    let offered = false;
    const settled = [];
    const aborted = (signal) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    const liveSteering = {
      wait: (signal) => (offered ? aborted(signal) : Promise.resolve()),
      claim: async () => {
        if (offered) return undefined;
        offered = true;
        return { messages: [steer], accept: () => settled.push('accept'), reject: () => settled.push('reject') };
      },
    };
    const controller = new AbortController();
    const running = stream(providers, { messages: [task] }, { sessionId: 'child-3', signal: controller.signal, liveSteering });
    await until(() => sentParams(dir, 'turn/steer').length === 1);
    await until(() => settled.length);
    assert.deepEqual(settled, ['accept']);
    controller.abort();
    const first = await running;
    assert.equal(first.final.reason, 'aborted');
    // After the abort OMP sends the accepted input again as an ordinary queued prompt.
    await stream(providers, { messages: [task, first.message, steer] }, { sessionId: 'child-3' });
    assert.equal(deliveries(dir, 'live steer 4b2e'), 1, 'the accepted steer reached Codex once');
    assert.equal(deliveries(dir, 'steered task 4b2e'), 1);
  });
}, TIMEOUT);

test('the first native thread gets the whole delegating system prompt as developerInstructions', async () => {
  // Shared context as a delegating agent writes it: markdown, code, unicode and nested delegation text
  // that itself quotes prompt-style headings. hub-smoke.mjs sends the same kind of context through the
  // real task tool, so OMP's own subagent template renders it there.
  const context = [
    'Goal: audit the parser 5e8b.',
    '# Contract',
    '- keep `parse(input: string)` stable',
    '```ts',
    'export const LIMIT = 4096;',
    '```',
    '⁂ Role',
    'Nested delegation notes from the parent (quoted).',
    '§ Context',
    '한글 ✓ 🙂 final line 5e8b',
  ].join('\n');
  // Shaped like a task child's prompt: default blocks, then the per-spawn block holding Role/Context/Coop.
  const systemPrompt = [
    'Default OMP system prompt block.\n<project-context>\nworkspace notes\n</project-context>',
    `⁂ Role\nThis agent runs on the native Codex app-server.\n\n⁂ Context\n${context}\n\n⁂ Coop\nYou are operating on a piece of work assigned to you by the main agent.`,
  ];
  await withHost({ turns: ['finish-later', 'finish-later'] }, undefined, async ({ providers, dir }) => {
    const first = await stream(providers, { systemPrompt, messages: [at('do the audit', 1000)] }, { sessionId: 'child-4' });
    assert.equal(first.final.type, 'done', first.message.errorMessage);
    const [turn] = sentParams(dir, 'turn/start');
    const [thread] = sentParams(dir, 'thread/start');
    assert.equal(thread.developerInstructions, systemPrompt.join('\n\n'));
    assert.ok(thread.developerInstructions.includes(context));
    assert.equal(turn.input.map(part => part.text ?? '').join('\n'), 'do the audit');
    // Codex keeps the conversation: the context is not sent again on follow-up.
    await stream(providers, { systemPrompt, messages: [at('do the audit', 1000), first.message, at('next 5e8b step', 3000)] }, { sessionId: 'child-4' });
    assert.equal(deliveries(dir, 'Goal: audit the parser 5e8b.'), 0, 'delegation never becomes user input');
    assert.equal(deliveries(dir, 'next 5e8b step'), 1);
  });
}, TIMEOUT);

test('a session with earlier native turns but no provider record stops without any native mutation', async () => {
  await withHost({ turns: ['finish-later'] }, undefined, async ({ providers, dir }) => {
    // E.g. the state directory was wiped: the transcript proves native work happened, the record of
    // what was submitted is gone, so resending could duplicate it.
    const earlier = {
      role: 'assistant', provider: PROVIDER, api: 'codex-bridge-app-server', model: 'default',
      content: [{ type: 'text', text: 'earlier native answer' }],
      stopReason: 'stop', timestamp: 2000, usage: {},
    };
    const result = await stream(providers, { messages: [at('old task', 1000), earlier, at('new question', 3000)] }, { sessionId: 'child-5' });
    assert.equal(result.final.type, 'error');
    assert.deepEqual(mutations(dir), [], 'no thread/start, resume, turn or steer without a provider record');
  });
}, TIMEOUT);

test('a definitely rejected submission retains thread instructions and sends only undelivered input next time', async () => {
  await withHost({ turns: ['reject', 'finish-later'] }, undefined, async ({ providers, dir }) => {
    const systemPrompt = ['Default OMP system prompt block.', 'Shared context 2d7c for the Codex child.'];
    const task = at('rejected task 2d7c', 1000);
    const rejected = await stream(providers, { systemPrompt, messages: [task] }, { sessionId: 'child-6' });
    assert.equal(rejected.final.type, 'error');
    assert.equal(rejected.message.errorMessage.includes('turn rejected'), true, rejected.message.errorMessage);
    // The rejected input goes with the next message; the native thread retains its developerInstructions.
    const next = await stream(providers, { systemPrompt, messages: [task, rejected.message, at('retry note 2d7c', 3000)] }, { sessionId: 'child-6' });
    assert.equal(next.final.type, 'done', next.message.errorMessage);
    const turns = sentParams(dir, 'turn/start');
    assert.equal(turns.length, 2);
    assert.equal(turns[1].threadId, turns[0].threadId);
    for (const text of ['rejected task 2d7c', 'retry note 2d7c']) assert.match(inputText(turns[1]), new RegExp(text));
    assert.equal(sentParams(dir, 'thread/start')[0].developerInstructions, systemPrompt.join('\n\n'));
    assert.doesNotMatch(inputText(turns[1]), /Shared context 2d7c/);
    const resent = inputText(turns[1]);
    assert.ok(resent.indexOf('rejected task 2d7c') < resent.indexOf('retry note 2d7c'), `task and new text retain order: ${resent}`);
    assert.equal(resent.split('rejected task 2d7c').length - 1, 1, 'the task is sent once');
    assert.equal(sentParams(dir, 'thread/start').length, 1);
  });
}, TIMEOUT);

// ---------------------------------------------------------------------------------------------------
// Restarts: OMP (and with it the app-server) dies, a new process loads the same provider module with the
// same state directory and drives the same session again. Each restart is a NEW createCodexBridgeProvider
// with its own client; nothing is aborted or interrupted. Records are written in the provider's
// documented format and the fake's persisted store says what native history shows.
const { createCodexBridgeProvider, inputId, CODEX_BRIDGE_MODELS } = await import('../src/omp/provider.mjs');
const { CodexAppServerClient } = await import('../src/codex/client.mjs');
const { createHash } = await import('node:crypto');
const DEFAULT_MODEL = { id: 'default', provider: PROVIDER, api: 'codex-bridge-app-server' };
const restartClients = [];

async function afterRestart(context, options, createClient, model = DEFAULT_MODEL) {
  const streamSimple = createCodexBridgeProvider({ EventStream: AssistantMessageEventStream, stateDir: STATE_DIR, ...(createClient ? { createClient } : {}) });
  const providerSessionState = new Map();
  restartClients.push(providerSessionState);
  const events = [];
  for await (const event of streamSimple(model, { systemPrompt: ['restart system prompt 3e9a'], tools: [], ...context }, { cwd, ...options, providerSessionState })) {
    events.push(event);
    if (event.type === 'done' || event.type === 'error') break;
  }
  const final = events.at(-1);
  return { events, final, message: final.type === 'done' ? final.message : final.error };
}
const closeRestarts = async () => {
  await Promise.all(restartClients.splice(0).flatMap(state => [...state.values()].map(entry => entry.close?.())));
};
const recordFile = (sessionId) => join(STATE_DIR, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
const writeRecord = (sessionId, record) => writeFileSync(recordFile(sessionId), JSON.stringify({ policy: 'native-config', config: {}, cwd, failure: undefined, ...record }));
const readRecord = (sessionId) => JSON.parse(readFileSync(recordFile(sessionId), 'utf8'));
const restartStore = (turns) => ({ nextThread: 0, nextTurn: 100, threads: { T1: { id: 'T1', cwd, turns } } });
const nativeTurn = (id, status) => ({ id, prompt: 'task', status, error: null, items: status === 'completed' ? [{
  type: 'agentMessage', id: `${id}-answer`, text: `answer of ${id}`, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null,
}] : [] });
const TASK = at('crash task 3e9a', 1000);
const NEW_INPUT = at('after restart 3e9a', 5000);
const withRestart = (options, store, body) => withHost(options, store, async (host) => {
  try { await body(host); } finally { await closeRestarts(); }
});

test('R1: after a hard crash with the recorded turn still running natively, new input is refused without any mutation', async () => {
  await withRestart({ staleTurns: true }, restartStore([nativeTurn('U1', 'inProgress')]), async ({ dir }) => {
    writeRecord('crash-1', { threadId: 'T1', turnId: 'U1', admitted: true, sent: [inputId(TASK)] });
    const result = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'crash-1' });
    assert.equal(result.final.type, 'error');
    assert.deepEqual(mutations(dir).map(({ message }) => message.method), [], 'no thread/resume, turn/start or turn/steer');
    assert.ok(!readRecord('crash-1').sent.includes(inputId(NEW_INPUT)), 'refused input is not recorded as sent');
  });
}, TIMEOUT);

test('R2: after a hard crash with the recorded turn finished natively, only the new input is sent on the same thread', async () => {
  await withRestart({}, restartStore([nativeTurn('U1', 'completed')]), async ({ dir }) => {
    writeRecord('crash-2', { threadId: 'T1', turnId: 'U1', admitted: true, sent: [inputId(TASK)] });
    const result = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'crash-2' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.equal(sentParams(dir, 'thread/resume').length, 1);
    assert.equal(sentParams(dir, 'thread/resume')[0].threadId, 'T1');
    const turns = sentParams(dir, 'turn/start');
    assert.equal(turns.length, 1);
    assert.equal(turns[0].threadId, 'T1');
    const input = inputText(turns[0]);
    assert.match(input, /after restart 3e9a/);
    assert.doesNotMatch(input, /crash task 3e9a/, 'the original task is not resent');
    assert.doesNotMatch(input, /restart system prompt 3e9a/, 'the system prompt went with the first admitted turn');
    assert.equal(sentParams(dir, 'thread/start').length, 0);
  });
}, TIMEOUT);

test('R3: a crash before admission stops while native history shows a running turn', async () => {
  await withRestart({ staleTurns: true }, restartStore([nativeTurn('U9', 'inProgress')]), async ({ dir }) => {
    writeRecord('crash-3a', { threadId: 'T1', turnId: undefined, admitted: false, failure: 'Codex submission in flight; outcome unknown', sent: [inputId(TASK)] });
    const result = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'crash-3a' });
    assert.equal(result.final.type, 'error');
    assert.deepEqual(mutations(dir), []);
  });
}, TIMEOUT);

// The provider records `failure` before submitting (cleared once the turn is confirmed): after a crash
// it marks a submission whose fate only native history can settle. `admitted` only gates the system prompt.
const IN_FLIGHT = 'Codex submission in flight; outcome unknown';
const BASELINE_ANSWER = {
  role: 'assistant', provider: PROVIDER, api: 'codex-bridge-app-server', model: 'default',
  content: [{ type: 'text', text: 'answer of U0' }], stopReason: 'stop', timestamp: 2000, usage: {},
};
const PENDING_FOLLOWUP = at('pending follow-up 3e9a', 3000);

test('R3: a crash with no new native turn since the recorded baseline stops instead of dropping the task', async () => {
  // Case 1, new thread: the task's first turn was in flight and Codex shows no turn.
  await withRestart({}, restartStore([]), async ({ dir }) => {
    writeRecord('crash-3b', { threadId: 'T1', turnId: undefined, admitted: false, failure: IN_FLIGHT, sent: [inputId(TASK)] });
    const result = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'crash-3b' });
    assert.equal(result.final.type, 'error');
    assert.deepEqual(mutations(dir), []);
    assert.ok(!readRecord('crash-3b').sent.includes(inputId(NEW_INPUT)), 'refused input is not recorded as sent');
  });
  // Case 2, follow-up: U0 is the finished baseline, the follow-up was in flight, history shows only U0.
  await withRestart({}, restartStore([nativeTurn('U0', 'completed')]), async ({ dir }) => {
    writeRecord('crash-3b2', { threadId: 'T1', turnId: 'U0', admitted: true, failure: IN_FLIGHT, sent: [inputId(TASK), inputId(PENDING_FOLLOWUP)] });
    const result = await afterRestart({ messages: [TASK, BASELINE_ANSWER, PENDING_FOLLOWUP, NEW_INPUT] }, { sessionId: 'crash-3b2' });
    assert.equal(result.final.type, 'error');
    assert.deepEqual(mutations(dir), []);
    assert.ok(!readRecord('crash-3b2').sent.includes(inputId(NEW_INPUT)));
  });
}, TIMEOUT);

test('R3: a crash proceeds once native history shows a new finished turn after the baseline', async () => {
  await withRestart({ turns: ['finish-later'] }, restartStore([nativeTurn('U0', 'completed'), nativeTurn('U8', 'completed')]), async ({ dir }) => {
    writeRecord('crash-3c', { threadId: 'T1', turnId: 'U0', admitted: true, failure: IN_FLIGHT, sent: [inputId(TASK), inputId(PENDING_FOLLOWUP)] });
    const result = await afterRestart({ messages: [TASK, BASELINE_ANSWER, PENDING_FOLLOWUP, NEW_INPUT] }, { sessionId: 'crash-3c' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    const started = sentParams(dir, 'turn/start');
    assert.equal(started.length, 1);
    assert.equal(started[0].threadId, 'T1');
    const input = inputText(started[0]);
    assert.match(input, /after restart 3e9a/);
    assert.doesNotMatch(input, /crash task 3e9a|pending follow-up 3e9a/, 'what already ran natively is not resent');
    assert.doesNotMatch(input, /restart system prompt 3e9a/);
    assert.equal(sentParams(dir, 'thread/start').length, 0);
    const record = readRecord('crash-3c');
    assert.ok(record.turnId && !['U0', 'U8'].includes(record.turnId), `record holds the new turn, got ${record.turnId}`);
    assert.ok(!record.failure, `failure cleared, got ${record.failure}`);
  });
}, TIMEOUT);

const EARLIER_ANSWER = {
  role: 'assistant', provider: PROVIDER, api: 'codex-bridge-app-server', model: 'default',
  content: [{ type: 'text', text: 'answer of U1' }], stopReason: 'stop', timestamp: 2000, usage: {},
};
const FOLLOWUP_INPUT = at('follow-up before crash 3e9a', 3000);

test('R8: a follow-up pending at the crash stops until native history shows its turn', async () => {
  // Record: U1 is the finished baseline, the follow-up was being submitted (pending failure marker).
  const record = { threadId: 'T1', turnId: 'U1', admitted: true, failure: 'Codex turn/start for the follow-up timed out; outcome unknown, not resubmitted', sent: [inputId(TASK), inputId(FOLLOWUP_INPUT)] };
  const messages = [TASK, EARLIER_ANSWER, FOLLOWUP_INPUT, NEW_INPUT];
  await withRestart({}, restartStore([nativeTurn('U1', 'completed')]), async ({ dir }) => {
    writeRecord('crash-8', record);
    const result = await afterRestart({ messages }, { sessionId: 'crash-8' });
    assert.equal(result.final.type, 'error');
    assert.deepEqual(mutations(dir), []);
    assert.ok(!readRecord('crash-8').sent.includes(inputId(NEW_INPUT)));
  });
  await withRestart({}, restartStore([nativeTurn('U1', 'completed'), nativeTurn('U2', 'completed')]), async ({ dir }) => {
    writeRecord('crash-8', record);
    const result = await afterRestart({ messages }, { sessionId: 'crash-8' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    const started = sentParams(dir, 'turn/start');
    assert.equal(started.length, 1);
    assert.equal(started[0].threadId, 'T1');
    const input = inputText(started[0]);
    assert.match(input, /after restart 3e9a/);
    assert.doesNotMatch(input, /follow-up before crash 3e9a|crash task 3e9a/, 'nothing already delivered is resent');
    assert.doesNotMatch(input, /restart system prompt 3e9a/);
  });
}, TIMEOUT);

test('R9: an unknown first turn/start followed by a restart with no native turn stops, never sending input without the system prompt', async () => {
  await withRestart({}, restartStore([]), async ({ dir }) => {
    writeRecord('crash-9', { threadId: 'T1', turnId: undefined, admitted: true, failure: 'Codex turn/start timed out; outcome unknown, not resubmitted', sent: [inputId(TASK)] });
    const result = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'crash-9' });
    assert.equal(result.final.type, 'error');
    assert.deepEqual(mutations(dir), []);
    assert.ok(!readRecord('crash-9').sent.includes(inputId(NEW_INPUT)));
  });
}, TIMEOUT);

test('R4: a native history read that times out stops without any mutation', async () => {
  const createClient = (options) => new CodexAppServerClient({ ...options, timeoutMs: 500 });
  await withRestart({ hangTurnsList: true }, restartStore([nativeTurn('U1', 'completed')]), async ({ dir }) => {
    writeRecord('crash-4t', { threadId: 'T1', turnId: 'U1', admitted: true, sent: [inputId(TASK)] });
    const result = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'crash-4t' }, createClient);
    assert.equal(result.final.type, 'error');
    assert.deepEqual(mutations(dir), []);
    assert.ok(!readRecord('crash-4t').sent.includes(inputId(NEW_INPUT)));
  });
}, TIMEOUT);

test('R4: an unreadable native history stops without any mutation', async () => {
  await withRestart({ failTurnsList: true }, restartStore([nativeTurn('U1', 'completed')]), async ({ dir }) => {
    writeRecord('crash-4', { threadId: 'T1', turnId: 'U1', admitted: true, sent: [inputId(TASK)] });
    const result = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'crash-4' });
    assert.equal(result.final.type, 'error');
    assert.deepEqual(mutations(dir), []);
    assert.ok(!readRecord('crash-4').sent.includes(inputId(NEW_INPUT)));
  });
}, TIMEOUT);

test('R5: after the app-server dies mid-turn, new input waits for native history to show the turn ended', async () => {
  // staleTurns: the replacement server still lists the dead turn as running.
  await withHost({ turns: ['crash-later', 'finish-later'], staleTurns: true }, undefined, async ({ providers, dir }) => {
    const task = at('live task 3e9a', 1000);
    const lost = await stream(providers, { messages: [task] }, { sessionId: 'live-5' });
    assert.equal(lost.final.type, 'error');
    const next = await stream(providers, { messages: [task, lost.message, at('next after crash 3e9a', 3000)] }, { sessionId: 'live-5' });
    assert.equal(next.final.type, 'error');
    assert.equal(sentParams(dir, 'turn/start').length, 1, 'no new turn while the dead turn is not shown finished');
    assert.equal(deliveries(dir, 'next after crash 3e9a'), 0);
  });
  // Without staleTurns the replacement server reports the dead turn interrupted: new input proceeds once.
  await withHost({ turns: ['crash-later', 'finish-later'] }, undefined, async ({ providers, dir }) => {
    const task = at('live task 3e9a', 1000);
    const lost = await stream(providers, { messages: [task] }, { sessionId: 'live-5b' });
    assert.equal(lost.final.type, 'error');
    const next = await stream(providers, { messages: [task, lost.message, at('next after crash 3e9a', 3000)] }, { sessionId: 'live-5b' });
    assert.equal(next.final.type, 'done', next.message.errorMessage);
    assert.equal(deliveries(dir, 'next after crash 3e9a'), 1);
    assert.equal(deliveries(dir, 'live task 3e9a'), 1, 'the lost task is not resubmitted');
  });
}, TIMEOUT);

test('R6: a turn/start whose outcome is unknown (timeout) is never resent with the next message', async () => {
  const createClient = (options) => new CodexAppServerClient({ ...options, timeoutMs: 500 });
  // dropTurnReply: Codex runs the turn but its turn/start reply never arrives in time.
  await withRestart({ dropTurnReply: 1500 }, undefined, async ({ dir }) => {
    const task = at('timed out task 3e9a', 1000);
    const lost = await afterRestart({ messages: [task] }, { sessionId: 'unknown-6' }, createClient);
    assert.equal(lost.final.type, 'error');
    await delay(1700);
    const retry = await afterRestart({ messages: [task, lost.message, at('retry 3e9a', 3000)] }, { sessionId: 'unknown-6' }, createClient);
    assert.ok(retry.final.type === 'done' || retry.final.type === 'error');
    assert.equal(deliveries(dir, 'timed out task 3e9a'), 1, 'an unknown-outcome submission is never resent');
  });
}, TIMEOUT);

test('a thread/start timeout leaves nothing delivered: the next message starts a new thread with prompt, task and new text', async () => {
  const createClient = (options) => new CodexAppServerClient({ ...options, timeoutMs: 500 });
  await withRestart({ startDelay: 1500, turns: ['finish-later'] }, undefined, async ({ dir }) => {
    const task = at('unstarted task 3e9a', 1000);
    const lost = await afterRestart({ messages: [task] }, { sessionId: 'start-7' }, createClient);
    assert.equal(lost.final.type, 'error');
    assert.equal(sentParams(dir, 'turn/start').length, 0);
    // The process dies before the late thread/start reply could confirm a thread.
    await closeRestarts();
    const next = await afterRestart({ messages: [task, lost.message, at('again 3e9a', 3000)] }, { sessionId: 'start-7' }, createClient);
    assert.equal(next.final.type, 'done', next.message.errorMessage);
    assert.equal(sentParams(dir, 'thread/start').length, 2, 'a new thread is started');
    const [turn] = sentParams(dir, 'turn/start');
    for (const text of ['unstarted task 3e9a', 'again 3e9a']) assert.match(inputText(turn), new RegExp(text));
    assert.equal(sentParams(dir, 'thread/start').at(-1).developerInstructions, 'restart system prompt 3e9a');
    assert.ok(inputText(turn).indexOf('unstarted task 3e9a') < inputText(turn).indexOf('again 3e9a'));
    assert.equal(inputText(turn).split('unstarted task 3e9a').length - 1, 1, 'the task is sent once');
  });
}, TIMEOUT);

test('R7: provider labels unknown subscription cost and native usage availability', () => {
  for (const model of CODEX_BRIDGE_MODELS) assert.match(model.name, /native usage when available; cost unknown/);
});


test('a second request while the first is still awaiting admission sends nothing', async () => {
  await withHost({ turns: ['slow-admit'] }, undefined, async ({ providers, dir }) => {
    const task = at('slow task 3e9a', 1000);
    const first = stream(providers, { messages: [task] }, { sessionId: 'inflight-8' });
    await until(() => sentParams(dir, 'turn/start').length === 1);
    const impatient = at('impatient 3e9a', 3000);
    const second = await stream(providers, { messages: [task, impatient] }, { sessionId: 'inflight-8' });
    assert.equal(second.final.type, 'error');
    assert.match(second.message.errorMessage, /in flight/);
    // Refused for now, not consumed: the text stays in the transcript for the next message.
    assert.equal(deliveries(dir, 'impatient 3e9a'), 0, 'not sent during the refused request');
    assert.ok(!(readRecord('inflight-8').sent ?? []).includes(inputId(impatient)), 'not recorded as sent');
    assert.equal(sentParams(dir, 'turn/start').length, 1);
    assert.equal(sentParams(dir, 'turn/steer').length, 0);
    assert.equal((await first).final.type, 'done');
  });
}, TIMEOUT);

test('a crash before any thread was confirmed resends system prompt, task and new text once on a new thread', async () => {
  await withRestart({ turns: ['finish-later'] }, undefined, async ({ dir }) => {
    writeRecord('crash-10', { threadId: undefined, turnId: undefined, admitted: false, failure: 'Codex submission in flight; outcome unknown', sent: [inputId(TASK)] });
    const result = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'crash-10' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.equal(sentParams(dir, 'thread/start').length, 1);
    assert.equal(sentParams(dir, 'thread/resume').length, 0);
    const started = sentParams(dir, 'turn/start');
    assert.equal(started.length, 1);
    for (const text of ['crash task 3e9a', 'after restart 3e9a']) assert.match(inputText(started[0]), new RegExp(text));
    assert.equal(sentParams(dir, 'thread/start')[0].developerInstructions, 'restart system prompt 3e9a');
    const record = readRecord('crash-10');
    assert.ok(record.threadId && !record.failure && record.admitted === true);
  });
}, TIMEOUT);

test('a full sent-input record refuses new input instead of forgetting what was delivered', async () => {
  await withRestart({}, restartStore([nativeTurn('U1', 'completed')]), async ({ dir }) => {
    const sent = [inputId(TASK), ...Array.from({ length: 4999 }, (_, index) => `${index}:${'0'.repeat(32)}`)];
    writeRecord('full-11', { threadId: 'T1', turnId: 'U1', admitted: true, sent });
    const result = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'full-11' });
    assert.equal(result.final.type, 'error');
    assert.match(result.message.errorMessage, /full/);
    assert.deepEqual(mutations(dir), []);
    assert.equal(sentParams(dir, 'thread/turns/list').length, 0, 'refused before even reading native history');
    const record = readRecord('full-11');
    assert.equal(record.sent.length, 5000, 'nothing dropped or added');
    assert.ok(record.sent.includes(inputId(TASK)));
  });
}, TIMEOUT);

// ---------------------------------------------------------------------------------------------------
// Native model selection. An OMP model id is `default` (Codex config default model) or the exact native
// slug; the concrete ids come from the native `model/list` through the provider's fetchDynamicModels.
// Permissions are not part of the id: every profile inherits native Codex configuration.
const modelId = (id) => () => ({ id });
const chosen = (native) => ({ id: native, provider: PROVIDER, api: 'codex-bridge-app-server' });
const MODEL_LOCKED = /Native model changes are not applied mid-session/;
const LEGACY_IDS = ['read-only', 'workspace-write', 'read-only--gpt-6-astra', 'workspace-write--gpt-5.6-luna'];

test('fetchDynamicModels lists every native model page as one exact profile each, after the default', async () => {
  // Slugs no exact OMP selector can name (whitespace, CSV comma), `default` itself and legacy
  // permission-shaped ids are not offered.
  const unofferable = ['has space', 'a,b', 'default', ...LEGACY_IDS];
  await withHost({ models: [...NATIVE_MODELS, ...unofferable], modelPageSize: 3 }, undefined, async ({ providers, dir }) => {
    const config = providers.get(PROVIDER);
    assert.equal(typeof config.fetchDynamicModels, 'function');
    assert.deepEqual(config.models.map(({ id }) => id), ['default']);
    const models = await config.fetchDynamicModels(undefined);
    assert.deepEqual(models.map(({ id }) => id), ['default', ...NATIVE_MODELS]);
    for (const model of models) assert.match(model.name, /cost unknown/);
    for (const model of models.slice(1)) assert.ok(model.name.includes(model.id), model.name);
    assert.ok(sentParams(dir, 'model/list').length >= 3, 'all pages read');
    assert.deepEqual(mutations(dir), [], 'discovery never starts a thread or turn');
  });
}, TIMEOUT);

test('selected native models reach thread/start and turn/start per session; the default sends no model', async () => {
  await withHost({ turns: ['finish-later', 'finish-later', 'finish-later'] }, undefined, async ({ providers, dir }) => {
    const astra = await stream(providers, { messages: [user('astra task')] }, { sessionId: 'model-astra' }, modelId('gpt-6-astra'));
    assert.equal(astra.final.type, 'done', astra.message.errorMessage);
    assert.equal(astra.message.model, 'gpt-6-astra');
    const luna = await stream(providers, { messages: [user('luna task')] }, { sessionId: 'model-luna' }, modelId('gpt-5.6-luna'));
    assert.equal(luna.final.type, 'done', luna.message.errorMessage);
    const plain = await stream(providers, { messages: [user('default task')] }, { sessionId: 'model-default' });
    assert.equal(plain.final.type, 'done', plain.message.errorMessage);
    assert.equal(plain.message.model, 'default');
    const starts = sentParams(dir, 'thread/start');
    const turns = sentParams(dir, 'turn/start');
    assert.equal(starts.length, 3, 'one thread per session');
    assert.deepEqual(starts.map(({ model }) => model), ['gpt-6-astra', 'gpt-5.6-luna', undefined]);
    assert.ok(!('model' in starts[2]) && !('model' in turns[2]), 'the Codex config default is not overridden');
    assert.deepEqual(turns.map(({ model }) => model), ['gpt-6-astra', 'gpt-5.6-luna', undefined]);
    assert.equal(new Set(turns.map(({ threadId }) => threadId)).size, 3);
    for (const turn of turns) assert.equal(Object.hasOwn(turn, 'sandboxPolicy'), false);
    assert.ok(starts.every(params => !Object.hasOwn(params, 'sandbox') && !Object.hasOwn(params, 'approvalPolicy') && params.cwd === cwd));
    // The record binds the model (absent = Codex default) and marks native-config policy.
    assert.deepEqual(['model-astra', 'model-luna', 'model-default'].map((id) => [readRecord(id).policy, readRecord(id).model]), [
      ['native-config', 'gpt-6-astra'], ['native-config', 'gpt-5.6-luna'], ['native-config', undefined],
    ]);
  });
}, TIMEOUT);

test('legacy permission ids, empty and unselectable model ids start nothing', async () => {
  await withHost({}, undefined, async ({ providers, dir }) => {
    for (const id of [...LEGACY_IDS, '', 'has space', 'a,b', 'gpt-*']) {
      const result = await stream(providers, { messages: [user(`bad id ${id}`)] }, { sessionId: `bad-${id}` }, modelId(id));
      assert.equal(result.final.type, 'error', id);
      assert.match(result.message.errorMessage, /Unknown codex-bridge model/, id);
    }
    assert.deepEqual(mutations(dir), []);
    assert.deepEqual(readdirSync(STATE_DIR), [], 'no session record written');
  });
}, TIMEOUT);

test('previous fixed-policy session records stop untouched and require a fresh session', async () => {
  await withRestart({ turns: ['finish-later'] }, restartStore([nativeTurn('U1', 'completed')]), async ({ dir }) => {
    for (const sandbox of ['read-only', 'workspace-write']) {
      const sessionId = `legacy-${sandbox}`;
      const model = 'gpt-6-astra';
      writeRecord(sessionId, { policy: undefined, sandbox, threadId: 'T1', turnId: 'U1', admitted: true, model, sent: [inputId(TASK)] });
      const before = readFileSync(recordFile(sessionId), 'utf8');
      const result = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId }, undefined, model ? chosen(model) : undefined);
      assert.equal(result.final.type, 'error');
      assert.match(result.message.errorMessage, /previous fixed sandbox policy; start a new task or fresh session/);
      assert.equal(readFileSync(recordFile(sessionId), 'utf8'), before, 'record kept as it was');
    }
    assert.deepEqual(mutations(dir), [], 'no thread/resume, turn/start or turn/steer');
    assert.equal(sentParams(dir, 'thread/turns/list').length, 0, 'refused before reading native history');
    // A record without any policy marker is not guessed into native defaults.
    writeFileSync(recordFile('no-sandbox'), JSON.stringify({ cwd, threadId: 'T1', turnId: 'U1', admitted: true, sent: [inputId(TASK)] }));
    const malformed = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'no-sandbox' });
    assert.equal(malformed.final.type, 'error');
    assert.match(malformed.message.errorMessage, /is malformed/);
    assert.deepEqual(mutations(dir), []);
  });
}, TIMEOUT);

test('bridge override changes refuse saved sessions before native access, while identical overrides resume', async () => {
  await withRestart({ turns: ['finish-later'] }, restartStore([nativeTurn('U1', 'completed')]), async ({ dir }) => {
    const config = { sandbox_mode: 'read-only', approval_policy: 'on-request' };
    writeRecord('config-bound', { config, threadId: 'T1', turnId: 'U1', admitted: true, sent: [inputId(TASK)] });
    const before = readFileSync(recordFile('config-bound'), 'utf8');
    for (const changed of [{}, { sandbox_mode: 'workspace-write', approval_policy: 'on-request' }]) {
      const refused = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'config-bound' },
        options => new CodexAppServerClient({ ...options, config: changed }));
      assert.equal(refused.final.type, 'error');
      assert.match(refused.message.errorMessage, /config overrides changed.*start a new task or fresh session/);
      assert.equal(readFileSync(recordFile('config-bound'), 'utf8'), before);
      assert.equal(spawns(dir), 0);
      assert.deepEqual(mutations(dir), []);
    }
    const resumed = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'config-bound' },
      options => new CodexAppServerClient({ ...options, config: { approval_policy: 'on-request', sandbox_mode: 'read-only' } }));
    assert.equal(resumed.final.type, 'done', resumed.message.errorMessage);
    assert.deepEqual(sentParams(dir, 'thread/resume')[0].config, config);
    assert.deepEqual(readRecord('config-bound').config, config);
    assert.equal(deliveries(dir, NEW_INPUT.content), 1);
  });
}, TIMEOUT);

test('operator environment overrides reach provider and direct clients and bind the provider receipt', async () => {
  await withHost({ turns: ['finish-later', 'finish-later'] }, undefined, async ({ providers, call, dir }) => {
    const config = { sandbox_mode: 'read-only', approval_policy: 'on-request' };
    process.env.OMP_CODEX_BRIDGE_CONFIG = JSON.stringify(config);
    const task = at('native env config', 29901);
    const first = await stream(providers, { messages: [task] }, { sessionId: 'env-config' });
    assert.equal(first.final.type, 'done', first.message.errorMessage);
    assert.deepEqual(readRecord('env-config').config, config);
    assert.deepEqual(sentParams(dir, 'thread/start')[0].config, config);
    const direct = await call({ action: 'run', prompt: 'direct native env config' });
    assert.equal(direct.isError, false);
    assert.deepEqual(sentParams(dir, 'thread/start')[1].config, config);
    const { config: provider } = providerModel(providers);
    await provider.streamSimple.close('env-config');
    const before = mutations(dir).length;
    process.env.OMP_CODEX_BRIDGE_CONFIG = JSON.stringify({ sandbox_mode: 'danger-full-access' });
    const refused = await stream(providers, { messages: [task, first.message, at('must not widen', 29902)] }, { sessionId: 'env-config' });
    assert.equal(refused.final.type, 'error');
    assert.match(refused.message.errorMessage, /config overrides changed.*fresh session/);
    assert.equal(mutations(dir).length, before);
    assert.deepEqual(readRecord('env-config').config, config);
  });
}, TIMEOUT);

test('a native-config record continues its thread in the same cwd and refuses another cwd', async () => {
  await withRestart({ turns: ['finish-later'] }, restartStore([nativeTurn('U1', 'completed')]), async ({ dir }) => {
    writeRecord('ww-record', { cwd: join(cwd, 'elsewhere'), threadId: 'T1', turnId: 'U1', admitted: true, sent: [inputId(TASK)] });
    const moved = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'ww-record' });
    assert.equal(moved.final.type, 'error');
    assert.match(moved.message.errorMessage, /start a new task for/);
    assert.deepEqual(mutations(dir), []);
    writeRecord('ww-record', { threadId: 'T1', turnId: 'U1', admitted: true, sent: [inputId(TASK)] });
    const resumed = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'ww-record' });
    assert.equal(resumed.final.type, 'done', resumed.message.errorMessage);
    assert.equal(Object.hasOwn(sentParams(dir, 'thread/resume')[0], 'sandbox'), false);
    assert.equal(Object.hasOwn(sentParams(dir, 'thread/resume')[0], 'approvalPolicy'), false);
    assert.deepEqual(sentParams(dir, 'turn/start').map(({ threadId, sandboxPolicy }) => [threadId, sandboxPolicy]), [['T1', undefined]]);
  });
}, TIMEOUT);

test('a session keeps its native model: a changed selection is refused before any native mutation', async () => {
  await withHost({ turns: ['finish-later'] }, undefined, async ({ providers, dir }) => {
    const first = await stream(providers, { messages: [user('astra task 4b2e')] }, { sessionId: 'model-lock' }, modelId('gpt-6-astra'));
    assert.equal(first.final.type, 'done', first.message.errorMessage);
    const before = mutations(dir).length;
    const history = [user('astra task 4b2e'), first.message, user('switch 4b2e')];
    for (const id of ['gpt-6-luna', 'default']) {
      const switched = await stream(providers, { messages: history }, { sessionId: 'model-lock' }, modelId(id));
      assert.equal(switched.final.type, 'error', id);
      assert.match(switched.message.errorMessage, MODEL_LOCKED);
    }
    assert.equal(mutations(dir).length, before, 'no thread/resume, turn/start or turn/steer');
    assert.equal(deliveries(dir, 'switch 4b2e'), 0);
    assert.equal(readRecord('model-lock').model, 'gpt-6-astra');
  });
}, TIMEOUT);

test('after a reload the recorded native model is resumed exactly and a different one is refused without mutation', async () => {
  await withRestart({ turns: ['finish-later'] }, restartStore([nativeTurn('U1', 'completed')]), async ({ dir }) => {
    writeRecord('reload-model', { threadId: 'T1', turnId: 'U1', admitted: true, model: 'gpt-6-astra', sent: [inputId(TASK)] });
    const refused = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'reload-model' }, undefined, chosen('gpt-6-luna'));
    assert.equal(refused.final.type, 'error');
    assert.match(refused.message.errorMessage, MODEL_LOCKED);
    assert.deepEqual(mutations(dir), []);
    assert.equal(readRecord('reload-model').model, 'gpt-6-astra');
    assert.ok(!readRecord('reload-model').sent.includes(inputId(NEW_INPUT)));
    const resumed = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'reload-model' }, undefined, chosen('gpt-6-astra'));
    assert.equal(resumed.final.type, 'done', resumed.message.errorMessage);
    assert.equal(sentParams(dir, 'thread/resume')[0].model, 'gpt-6-astra');
    assert.equal(sentParams(dir, 'turn/start')[0].model, 'gpt-6-astra');
  });
}, TIMEOUT);

test('a native-config record without a model keeps the Codex default and refuses a selected model', async () => {
  await withRestart({ turns: ['finish-later'] }, restartStore([nativeTurn('U1', 'completed')]), async ({ dir }) => {
    writeRecord('legacy-model', { threadId: 'T1', turnId: 'U1', admitted: true, sent: [inputId(TASK)] });
    const refused = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'legacy-model' }, undefined, chosen('gpt-6-astra'));
    assert.equal(refused.final.type, 'error');
    assert.match(refused.message.errorMessage, MODEL_LOCKED);
    assert.deepEqual(mutations(dir), []);
    assert.equal(readRecord('legacy-model').model, undefined);
    const resumed = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'legacy-model' });
    assert.equal(resumed.final.type, 'done', resumed.message.errorMessage);
    assert.ok(!('model' in sentParams(dir, 'thread/resume')[0]));
    assert.ok(!('model' in sentParams(dir, 'turn/start')[0]));
    assert.equal(readRecord('legacy-model').model, undefined);
  });
}, TIMEOUT);

test('a native thread reporting another model than selected gets no turn', async () => {
  await withHost({ permissions: { model: 'gpt-6.1-sol' } }, undefined, async ({ providers, dir }) => {
    const result = await stream(providers, { messages: [user('mismatch task 8d1c')] }, { sessionId: 'mismatch' }, modelId('gpt-6-astra'));
    assert.equal(result.final.type, 'error');
    assert.match(result.message.errorMessage, /MODEL_MISMATCH|Codex reported model/);
    assert.equal(sentParams(dir, 'thread/start').length, 1);
    assert.deepEqual(prompts(dir), [], 'no turn/start');
  });
}, TIMEOUT);

const RESULT_SCHEMA = {
  type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false,
};
const structuredYield = {
  name: 'yield', description: 'Finish the task',
  parameters: {
    type: 'object', additionalProperties: false, required: [],
    properties: {
      type: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      // OMP's wire sanitizer removes closure before its transport's strict-enforcement phase.
      // The normalized declaration in description remains authoritative for this native transport.
      data: {
        description: `Structured output matching the schema:\n${JSON.stringify(RESULT_SCHEMA, null, 2)}`,
        anyOf: [{ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, { type: 'boolean' }],
      },
      error: { type: 'string' },
    },
  },
};

test('structured native output uses the terminal data schema and final JSON, retaining partial prose', async () => {
  await withHost({ turns: ['rich-output'] }, undefined, async ({ providers, dir }) => {
    const task = at('structured boundary', 11000);
    const first = await stream(providers, { messages: [task], tools: [structuredYield], outputSchema: RESULT_SCHEMA }, { sessionId: 'structured' });
    assert.equal(first.final.type, 'done', first.message.errorMessage);
    assert.equal(first.final.reason, 'toolUse');
    assert.deepEqual(sentParams(dir, 'turn/start')[0].outputSchema, RESULT_SCHEMA);
    const result = first.message.content.find(block => block.type === 'toolCall');
    assert.deepEqual(result.arguments, { data: { ok: true } });
    assert.match(textOf(first.message), /partial answer/);
    assert.match(textOf(first.message), /"ok":true/);
    assert.match(first.message.responseId, /^codex-bridge:[^:]+:[^:]+$/);
    const reminder = { role: 'developer', content: 'yield reminder', synthetic: true, timestamp: 12000 };
    const repeated = await stream(providers, { messages: [task, first.message, reminder], tools: [structuredYield], outputSchema: RESULT_SCHEMA }, { sessionId: 'structured' });
    assert.equal(repeated.final.type, 'done', repeated.message.errorMessage);
    assert.deepEqual(repeated.message.content.find(block => block.type === 'toolCall').arguments, { data: { ok: true } });
    assert.equal(sentParams(dir, 'turn/start').length, 1);
  });
}, TIMEOUT);

for (const mode of ['invalid-json', 'invalid-data', 'invalid-extra', 'explicit-empty-final']) {
  test(`${mode} reports structured failure without retrying native work`, async () => {
    await withHost({ turns: [mode] }, undefined, async ({ providers, dir }) => {
      const context = { messages: [at(mode, 13000)], tools: [structuredYield], outputSchema: RESULT_SCHEMA };
      const first = await stream(providers, context, { sessionId: mode });
      assert.equal(first.final.type, 'error');
      assert.match(first.message.errorMessage, /invalid structured data/);
      assert.match(first.message.errorClassificationMessage, /not replayed/);
      assert.deepEqual(toolCalls(first.events), []);
      const retry = await stream(providers, context, { sessionId: mode });
      assert.equal(retry.final.type, 'error');
      assert.equal(sentParams(dir, 'turn/start').length, 1, 'validation never replays an admitted native turn');
    });
  }, TIMEOUT);
}

test('unstructured completion preserves all native answer text without requesting outputSchema', async () => {
  await withHost({ turns: ['rich-output'] }, undefined, async ({ providers, dir }) => {
    const result = await stream(providers, { messages: [at('plain answer', 14000)] }, { sessionId: 'plain-answer' });
    assert.equal(result.final.reason, 'stop');
    assert.equal(textOf(result.message), 'partial answer\n\nfinal answer');
    assert.deepEqual(toolCalls(result.events), []);
    assert.ok(!('outputSchema' in sentParams(dir, 'turn/start')[0]));
  });
}, TIMEOUT);

test('native usage sums the agentic turn while context uses only the last request', async () => {
  await withHost({ turns: ['rich-output', 'rich-output'] }, undefined, async ({ providers }) => {
    const first = await stream(providers, { messages: [at('usage first', 15000)] }, { sessionId: 'usage-count' });
    const second = await stream(providers, { messages: [first.message, at('usage second', 16000)] }, { sessionId: 'usage-count' });
    for (const result of [first, second]) {
      assert.equal(result.final.type, 'done', result.message.errorMessage);
      assert.deepEqual(result.message.usage, {
        input: 100, cacheRead: 20, cacheWrite: 0, output: 30, totalTokens: 150,
        reasoningTokens: 5, contextTokens: 90,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });
      assert.match(result.message.content.filter(block => block.type === 'thinking').map(block => block.thinking).join('\n'), /native context 90\/200000 tokens/);
    }
  });
}, TIMEOUT);

test('image-only OMP input reaches native as MIME data URLs and distinct durable identities', async () => {
  const firstImage = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' };
  const secondImage = { ...firstImage, data: 'd29ybGQ=' };
  const first = user('', { timestamp: 17000, content: [firstImage] });
  const second = user('', { timestamp: 17000, content: [secondImage] });
  assert.notEqual(inputId(first), inputId(second));
  await withHost({ turns: ['finish-later', 'finish-later'] }, undefined, async ({ providers, dir }) => {
    const result = await stream(providers, { messages: [first] }, { sessionId: 'images' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    const next = await stream(providers, { messages: [first, result.message, second] }, { sessionId: 'images' });
    assert.equal(next.final.type, 'done', next.message.errorMessage);
    assert.deepEqual(sentParams(dir, 'turn/start').map(turn => turn.input), [
      [{ type: 'image', url: 'data:image/png;base64,aGVsbG8=' }],
      [{ type: 'image', url: 'data:image/png;base64,d29ybGQ=' }],
    ]);
  });
}, TIMEOUT);

test('OMP effort maps explicitly and unsupported off/max stop before a native mutation', async () => {
  await withHost({ turns: Array(5).fill('finish-later') }, undefined, async ({ providers, dir }) => {
    for (const reasoning of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
      const result = await stream(providers, { messages: [at(reasoning, 18000)] }, { sessionId: `effort-${reasoning}`, reasoning });
      assert.equal(result.final.type, 'done', result.message.errorMessage);
      assert.equal(sentParams(dir, 'turn/start').at(-1).effort, reasoning);
    }
    const before = mutations(dir).length;
    for (const options of [{ disableReasoning: true }, { reasoning: 'off' }, { reasoning: 'max' }]) {
      const result = await stream(providers, { messages: [at('unsupported effort', 19000)] }, { sessionId: `unsupported-${JSON.stringify(options)}`, ...options });
      assert.equal(result.final.type, 'error');
      assert.match(result.message.errorMessage, /reasoning effort/);
    }
    assert.equal(mutations(dir).length, before);
  });
}, TIMEOUT);

test('explicit reasoning off becomes native none only when the catalog advertises none', async () => {
  await withHost({ reasoningEfforts: ['none', 'high'], turns: ['finish-later'] }, undefined, async ({ providers, dir }) => {
    const result = await stream(providers, { messages: [at('off supported', 20000)] }, { sessionId: 'effort-none', disableReasoning: true });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.equal(sentParams(dir, 'turn/start')[0].effort, 'none');
  });
}, TIMEOUT);

test('native catalog capabilities and measured context window become model metadata', async () => {
  const { fetchCodexModels } = await import('../src/omp/provider.mjs');
  let closed = false;
  const models = await fetchCodexModels({ createClient: () => ({
    listModels: async () => [{
      model: 'catalog-model', isDefault: true, contextWindow: 200000,
      inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
    }],
    close: async () => { closed = true; },
  }) });
  assert.equal(closed, true);
  for (const model of models) {
    assert.equal(model.contextWindow, 200000);
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.input, ['text', 'image']);
    assert.match(model.name, /cost unknown/);
  }
});

function lifecycleContext(sessionId, model, initial = []) {
  let entries = initial;
  const notices = [];
  let aborted = false;
  const ctx = {
    cwd, model, ui: { notify: (message, type) => notices.push({ message, type }), setStatus() {} },
    notices, abort: () => { aborted = true; }, get aborted() { return aborted; },
    setEntries: value => { entries = value; },
    sessionManager: {
      getSessionId: () => sessionId,
      getEntry: id => entries.find(entry => entry.id === id),
      getBranch: id => {
        if (id === undefined) return entries;
        const result = [];
        let entry = entries.find(value => value.id === id);
        while (entry) { result.unshift(entry); entry = entries.find(value => value.id === entry.parentId); }
        return result;
      },
    },
  };
  sessionContexts.set(sessionId, ctx);
  return ctx;
}
const messageEntry = (id, parentId, message) => ({ id, parentId, type: 'message', message });

test('tree completed-turn rewind forks once at the visible anchor and never replays older prompts', async () => {
  await withHost({ turns: ['finish-later', 'finish-later', 'finish-later'] }, undefined, async ({ providers, dir }) => {
    const { config, model } = providerModel(providers);
    const task = at('branch original task', 21000);
    const first = await stream(providers, { messages: [task] }, { sessionId: 'tree' });
    const second = await stream(providers, { messages: [task, first.message, at('branch abandoned request', 22000)] }, { sessionId: 'tree' });
    const entries = [
      messageEntry('user1', null, task), messageEntry('answer1', 'user1', first.message),
      messageEntry('user2', 'answer1', at('branch abandoned request', 22000)), messageEntry('answer2', 'user2', second.message),
    ];
    const ctx = lifecycleContext('tree', model, entries);
    const event = { preparation: { targetId: 'answer1', userWantsSummary: false }, signal: new AbortController().signal };
    assert.equal(await config.streamSimple.beforeTree(event, ctx), undefined);
    const before = mutations(dir).length;
    ctx.setEntries(entries.slice(0, 2));
    config.streamSimple.afterTree({ newLeafId: 'answer1' }, ctx);
    assert.equal(mutations(dir).length, before, 'tree notification performs no native mutation');
    const resumed = await stream(providers, { messages: [task, first.message, at('new branch request', 23000)] }, { sessionId: 'tree' });
    assert.equal(resumed.final.type, 'done', resumed.message.errorMessage);
    const [fork] = sentParams(dir, 'thread/fork');
    const [initial] = sentParams(dir, 'turn/start');
    assert.equal(fork.threadId, initial.threadId);
    assert.equal(fork.lastTurnId, first.message.responseId.split(':').at(-1));
    assert.equal(sentParams(dir, 'turn/start').length, 3);
    assert.equal(deliveries(dir, 'branch original task'), 1);
    assert.equal(deliveries(dir, 'branch abandoned request'), 1);
    assert.equal(deliveries(dir, 'new branch request'), 1);
    assert.notEqual(sentParams(dir, 'turn/start')[2].threadId, initial.threadId);
  });
}, TIMEOUT);

test('partial-turn tree boundaries and branch summarization refuse before native effects', async () => {
  await withHost({}, undefined, async ({ providers, dir }) => {
    const { config, model } = providerModel(providers);
    const partial = { role: 'assistant', provider: PROVIDER, content: [{ type: 'text', text: 'partial' }], stopReason: 'aborted' };
    const ctx = lifecycleContext('partial-tree', model, [messageEntry('partial', null, partial)]);
    const signal = new AbortController().signal;
    assert.deepEqual(await config.streamSimple.beforeTree({ preparation: { targetId: 'partial', userWantsSummary: false }, signal }, ctx), { cancel: true });
    assert.deepEqual(await config.streamSimple.beforeTree({ preparation: { targetId: 'partial', userWantsSummary: true }, signal }, ctx), { cancel: true });
    assert.equal(ctx.notices.length, 2);
    assert.deepEqual(mutations(dir), []);
  });
}, TIMEOUT);

test('native compact uses its lifecycle, persists opaque metadata, and blocks incompatible model use', async () => {
  await withHost({ turns: ['finish-later', 'finish-later'] }, undefined, async ({ providers, dir }) => {
    const { config, model } = providerModel(providers);
    const task = at('compact original request', 24000);
    const first = await stream(providers, { messages: [task] }, { sessionId: 'compact' });
    const entries = [messageEntry('user1', null, task), messageEntry('answer1', 'user1', first.message)];
    const ctx = lifecycleContext('compact', model, entries);
    const before = sentParams(dir, 'turn/start').length;
    const event = { preparation: { firstKeptEntryId: 'answer1', tokensBefore: 30000 }, branchEntries: entries, signal: new AbortController().signal };
    const replacement = await config.streamSimple.beforeCompact(event, ctx);
    assert.ok(replacement?.compaction, JSON.stringify(ctx.notices));
    assert.equal(sentParams(dir, 'thread/compact/start').length, 1);
    assert.equal(sentParams(dir, 'turn/start').length, before, 'compaction never becomes a workspace-write user task');
    assert.match(replacement.compaction.summary, /no readable summary/);
    assert.equal(replacement.compaction.details.summaryAvailable, false);
    const compactEntry = { id: 'compact1', parentId: 'answer1', type: 'compaction', ...replacement.compaction };
    ctx.setEntries([...entries, compactEntry]);
    config.streamSimple.afterCompact({ compactionEntry: compactEntry }, ctx);
    config.streamSimple.context({}, ctx);
    const preserved = replacement.compaction.preserveData.codexNative;
    assert.equal(preserved.threadId, sentParams(dir, 'turn/start')[0].threadId);
    assert.equal(readRecord('compact').opaque.threadId, preserved.threadId);
    ctx.model = { ...model, provider: 'incompatible-fixture' };
    assert.throws(() => config.streamSimple.context({}, ctx), /opaque Codex compaction/);
    assert.equal(ctx.aborted, true);
    assert.deepEqual(await config.streamSimple.beforeCompact(event, ctx), { cancel: true });
    assert.equal(sentParams(dir, 'turn/start').length, before);
    ctx.model = model;
    config.streamSimple.context({}, ctx);
    const nextInput = at('after native compact', 25000);
    const summary = { role: 'compactionSummary', summary: replacement.compaction.summary, tokensBefore: 30000, timestamp: 24500 };
    const adapted = config.streamSimple.context({ messages: [summary, nextInput] }, ctx);
    assert.deepEqual(adapted.messages, [nextInput], 'official summary role is removed before user-text conversion');
    await config.streamSimple.close('compact');
    config.streamSimple.context({ messages: [summary, nextInput] }, ctx);
    const next = await stream(providers, { messages: adapted.messages }, { sessionId: 'compact' });
    assert.equal(next.final.type, 'done', next.message.errorMessage);
    assert.equal(sentParams(dir, 'thread/fork').length, 0);
    assert.equal(deliveries(dir, 'compact original request'), 1);
    assert.equal(deliveries(dir, 'after native compact'), 1);
    // Rewinding to raw entries removes the opaque-model guard without touching native history.
    ctx.setEntries(entries);
    ctx.model = { ...model, provider: 'incompatible-fixture' };
    assert.equal(config.streamSimple.context({}, ctx), undefined);
  });
}, TIMEOUT);

test('clear retains old native identities and starts a new thread only for new user input', async () => {
  await withHost({ turns: ['finish-later', 'finish-later'] }, undefined, async ({ providers, dir }) => {
    const { config } = providerModel(providers);
    const task = at('before clear', 26000);
    const first = await stream(providers, { messages: [task] }, { sessionId: 'clear' });
    const oldThread = readRecord('clear').threadId;
    // OMP 18.20.3 tears down provider state before emitting session_clear.
    await closeSessions('clear');
    await config.streamSimple.clear('clear');
    const cleared = readRecord('clear');
    for (const { pid } of trace(dir).filter(entry => entry.spawn)) {
      assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'reset confirmation leaves no old-session server');
    }
    assert.equal(cleared.threadId, undefined);
    assert.ok(cleared.threads.includes(oldThread));
    assert.ok(cleared.sent.includes(inputId(task)));
    const next = await stream(providers, { messages: [at('after clear', 27000)] }, { sessionId: 'clear' });
    assert.equal(first.final.type, 'done');
    assert.equal(next.final.type, 'done', next.message.errorMessage);
    assert.equal(sentParams(dir, 'thread/start').length, 2);
    assert.notEqual(sentParams(dir, 'turn/start')[0].threadId, sentParams(dir, 'turn/start')[1].threadId);
    assert.equal(deliveries(dir, 'before clear'), 1);
  });
}, TIMEOUT);

test('closing a provider session waits for its old native process before a new binding resumes', async () => {
  await withHost({ slowExit: 100, turns: ['finish-later', 'finish-later'] }, undefined, async ({ providers, dir }) => {
    const { config } = providerModel(providers);
    const task = at('before provider close', 28000);
    const first = await stream(providers, { messages: [task] }, { sessionId: 'reload-close' });
    const firstPid = trace(dir).find(entry => entry.spawn).pid;
    await config.streamSimple.close('reload-close');
    assert.throws(() => process.kill(firstPid, 0), error => error.code === 'ESRCH');
    const next = await stream(providers, { messages: [task, first.message, at('after provider close', 29000)] }, { sessionId: 'reload-close' });
    assert.equal(next.final.type, 'done', next.message.errorMessage);
    assert.equal(sentParams(dir, 'thread/start').length, 1);
    assert.equal(sentParams(dir, 'thread/resume').length, 1);
    assert.equal(deliveries(dir, 'before provider close'), 1);
    assert.equal(deliveries(dir, 'after provider close'), 1);
    await config.streamSimple.closeAll();
  });
}, TIMEOUT);

test('a lifecycle-opened provider binds OMP teardown state on its first stream', async () => {
  await withHost({ turns: ['finish-later'] }, undefined, async ({ providers, dir }) => {
    const { config, model } = providerModel(providers);
    const sessionId = 'lifecycle-before-stream';
    const ctx = lifecycleContext(sessionId, model);
    config.streamSimple.afterTree({}, ctx);
    assert.equal(sessionState(sessionId).size, 0, 'lifecycle context has no provider teardown map');
    const result = await stream(providers, { messages: [at('after empty tree navigation', 29100)] }, { sessionId });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.ok(sessionState(sessionId).has(PROVIDER), 'the first stream registers the existing lifecycle client');
    await closeSessions(sessionId);
    for (const { pid } of trace(dir).filter(entry => entry.spawn)) {
      assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
    }
  });
}, TIMEOUT);

test('headless child native questions use root UI through official select and survive root turn_end', async () => {
  await withHost({ turns: ['question'] }, undefined, async ({ providers, ctx, handlers, child, dir }) => {
    ctx.hasUI = true;
    ctx.mode = 'rpc';
    let richDialogs = 0;
    ctx.ui.askDialog = async () => { richDialogs++; return { kind: 'cancel' }; };
    const choice = Promise.withResolvers();
    let requestSignal;
    const requests = [];
    ctx.ui.select = (title, options, { signal }) => {
      requests.push({ method: 'select', title, options });
      requestSignal = signal;
      return choice.promise;
    };
    const headless = await child('codex-bridge');
    assert.equal(headless.ctx.hasUI, false);
    const pending = stream(headless.providers, { messages: [at('root question', 30000)] }, { sessionId: 'root-ui-question' });
    await until(() => requests.length === 1);
    await handlers.get('turn_end')?.({ type: 'turn_end' }, ctx);
    assert.equal(requestSignal.aborted, false, 'root settling must not cancel a running child question');
    choice.resolve('Staging');
    const result = await pending;
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.equal(textOf(result.message), 'question answered');
    assert.equal(richDialogs, 0, 'closed native options cannot expose askDialog custom input');
    assert.match(requests[0].title, /Which environment/);
    assert.equal(requests[0].options[0].label, 'Staging');
    const answer = trace(dir).find(({ message }) => message?.id === 901 && !message.method)?.message;
    assert.deepEqual(answer.result, { answers: { environment: { answers: ['Staging'] } } });
    assert.equal(sentParams(dir, 'turn/start').length, 1);
    assert.equal(providers.get(PROVIDER).streamSimple, headless.providers.get(PROVIDER).streamSimple);
  });
}, TIMEOUT);

test('native command approval reaches root UI from a headless child and grants only explicit confirmation', async () => {
  for (const selection of ['Approve once', 'Decline', undefined]) {
    await withHost({ turns: ['approval'] }, undefined, async ({ ctx, child, dir }) => {
      ctx.hasUI = true;
      let asked = 0;
      ctx.ui.select = async (title, options) => {
        asked++;
        assert.match(title, /touch forbidden/);
        assert.deepEqual(options, ['Decline', 'Approve once']);
        return selection;
      };
      const worker = await child('codex-bridge');
      const result = await stream(worker.providers, { messages: [at('native approval', 29900)] },
        { sessionId: 'native-approval' });
      assert.equal(result.final.type, 'done', result.message.errorMessage);
      assert.equal(asked, 1);
      const response = trace(dir).find(({ message }) => message?.id === 900 && !message.method)?.message;
      assert.deepEqual(response.result, { decision: selection === 'Approve once' ? 'accept' : 'decline' });
      assert.equal(sentParams(dir, 'turn/start').length, 1);
    });
  }
}, TIMEOUT);

test('all native approval dialogs fail closed without UI, on dismissal, cancellation and root switch', async () => {
  const { onRequest } = await import('../src/omp/dialogs.ts');
  await withHost({}, undefined, async ({ ctx, handlers }) => {
    const methods = [
      'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
      'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval',
    ];
    const params = {
      threadId: 'T1', turnId: 'U1', command: 'touch requested-file',
      permissions: { network: { enabled: true } },
      networkApprovalContext: { host: 'example.com', protocol: 'https' },
      additionalPermissions: { fileSystem: { write: ['/outside-workspace'] } }, grantRoot: '/outside-workspace',
    };
    const controller = new AbortController();
    let selections = 0;
    let selection;
    let lastTitle;
    ctx.ui.select = async title => { selections++; lastTitle = title; return selection; };
    for (const method of methods) {
      const request = { method, params, signal: controller.signal };
      const denied = method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' }
        : method.endsWith('/requestApproval') ? { decision: 'decline' }
        : { decision: { denied: { rejection: 'User approval was not granted' } } };
      const granted = method === 'item/permissions/requestApproval' ? { permissions: params.permissions, scope: 'turn' }
        : method.endsWith('/requestApproval') ? { decision: 'accept' } : { decision: 'approved' };
      ctx.hasUI = false;
      selection = 'Approve once';
      assert.deepEqual(await onRequest(request), denied);
      ctx.hasUI = true;
      for (selection of [undefined, 'Decline', 'acceptForSession', 'unexpected']) {
        assert.deepEqual(await onRequest(request), denied);
      }
      selection = 'Approve once';
      assert.deepEqual(await onRequest(request), granted);
      assert.ok(lastTitle.includes(JSON.stringify(params, null, 2)), 'all requested permissions and managed-network scope reach the user');
    }
    assert.equal(selections, methods.length * 5);
    selections = 0;
    for (const availableDecisions of [[], ['acceptForSession', 'decline'], ['decline', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch'] } }]]) {
      assert.deepEqual(await onRequest({ method: methods[0], params: { ...params, availableDecisions }, signal: controller.signal }), { decision: 'decline' });
    }
    assert.equal(selections, 0, 'unsupported command approval choices never become accept');
    for (const permissions of [undefined, null, []]) {
      assert.deepEqual(await onRequest({ method: methods[2], params: { permissions }, signal: controller.signal }), { permissions: {}, scope: 'turn' });
    }
    assert.equal(selections, 0, 'malformed permission requests never open an approval dialog');
    for (const availableDecisions of [null, ['accept', 'decline']]) {
      assert.deepEqual(await onRequest({ method: methods[0], params: { ...params, availableDecisions }, signal: controller.signal }), { decision: 'accept' });
    }
    assert.equal(selections, 2, 'native default and explicit one-request choices permit user confirmation');
    const oldClient = onRequest.forClient();
    const answer = Promise.withResolvers();
    ctx.ui.select = async () => answer.promise;
    const pending = oldClient({ method: methods[0], params, signal: controller.signal });
    controller.abort();
    answer.resolve('Approve once');
    assert.deepEqual(await pending, { decision: 'decline' });
    await handlers.get('session_before_switch')?.({ type: 'session_before_switch', reason: 'resume' }, ctx);
    assert.deepEqual(await oldClient({ method: methods[0], params, signal: new AbortController().signal }), { decision: 'decline' });
  });
}, TIMEOUT);

test('native MCP form uses official root select APIs and replies with typed form content', async () => {
  await withHost({ turns: ['elicitation'] }, undefined, async ({ providers, ctx, dir }) => {
    ctx.hasUI = true;
    const selections = [];
    ctx.ui.select = async (title, options) => {
      selections.push({ title, options });
      return title.includes('Submit these answers?') ? 'Submit answers' : 'Production';
    };
    const result = await stream(providers, { messages: [at('root form', 31000)] }, { sessionId: 'root-form' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.equal(selections.length, 2);
    const answer = trace(dir).find(({ message }) => message?.id === 902 && !message.method)?.message;
    assert.deepEqual(answer.result, { action: 'accept', content: { environment: 'Production' } });
  });
}, TIMEOUT);

test('native questions without root UI return no fabricated user answer', async () => {
  await withHost({ turns: ['question'] }, undefined, async ({ providers, dir, ctx }) => {
    assert.equal(ctx.hasUI, false);
    const result = await stream(providers, { messages: [at('headless question', 32000)] }, { sessionId: 'headless-question' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    const answer = trace(dir).find(({ message }) => message?.id === 901 && !message.method)?.message;
    assert.deepEqual(answer.result, { answers: {} });
  });
}, TIMEOUT);

test('root switch aborts its open native UI request and old child cannot acquire replacement root', async () => {
  await withHost({ turns: ['question', 'question'] }, undefined, async ({ providers, handlers, ctx, dir }) => {
    ctx.hasUI = true;
    let requestSignal;
    ctx.ui.select = (_title, _options, { signal }) => {
      requestSignal = signal;
      return new Promise(resolve => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
    };
    const task = at('old-root first question', 33000);
    const pending = stream(providers, { messages: [task] }, { sessionId: 'old-root-child' });
    await until(() => requestSignal);
    await handlers.get('session_before_switch')?.({ type: 'session_before_switch', reason: 'resume' }, ctx);
    assert.equal(requestSignal.aborted, true);
    const first = await pending;
    assert.equal(first.final.type, 'done', first.message.errorMessage);
    let replacementRequests = 0;
    const replacement = {
      ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => 'new-root' },
      ui: { notify() {}, setStatus() {}, select: async () => { replacementRequests++; return 'Production'; } },
    };
    await handlers.get('session_switch')?.({ type: 'session_switch', reason: 'resume' }, replacement);
    const second = await stream(providers, { messages: [task, first.message, at('old-root second question', 34000)] }, { sessionId: 'old-root-child' });
    assert.equal(second.final.type, 'done', second.message.errorMessage);
    assert.equal(replacementRequests, 0, 'a client stays bound to the root that admitted it');
    const answers = trace(dir).filter(({ message }) => message?.id === 901 && !message.method).map(({ message }) => message.result);
    assert.deepEqual(answers, [{ answers: {} }, { answers: {} }]);
  });
}, TIMEOUT);

test('native turn cancellation aborts its root UI signal and ignores a late selection', async () => {
  await withHost({ turns: ['question'] }, undefined, async ({ providers, ctx, dir }) => {
    ctx.hasUI = true;
    const selected = Promise.withResolvers();
    let requestSignal;
    ctx.ui.select = (_title, _options, { signal }) => { requestSignal = signal; return selected.promise; };
    const controller = new AbortController();
    const pending = stream(providers, { messages: [at('cancel root question', 35000)] }, { sessionId: 'cancel-question', signal: controller.signal });
    await until(() => requestSignal);
    controller.abort();
    const result = await pending;
    assert.equal(result.final.reason, 'aborted');
    await until(() => requestSignal.aborted);
    selected.resolve('Production');
    await delay(20);
    const answers = trace(dir).filter(({ message }) => message?.id === 901 && !message.method).map(({ message }) => message.result);
    assert.ok(answers.every(answer => !answer?.answers?.environment), 'late user input never reaches an interrupted native turn');
    assert.equal(sentParams(dir, 'turn/start').length, 1);
  });
}, TIMEOUT);

test('direct native tool forwards typed input, effort, and output schema without a user-text wrapper', async () => {
  await withHost({ turns: ['rich-output'] }, undefined, async ({ call, dir, followUps }) => {
    const input = [{ type: 'text', text: 'typed direct input' }, { type: 'image', url: 'data:image/png;base64,aGVsbG8=' }];
    const result = await call({ action: 'run', input, effort: 'high', outputSchema: RESULT_SCHEMA, cwd });
    assert.equal(result.isError, false, JSON.stringify(result.json));
    const [native] = sentParams(dir, 'turn/start');
    assert.deepEqual(native.input.map(block => block.type === 'text' ? { type: block.type, text: block.text } : block), input);
    assert.equal(native.effort, 'high');
    assert.deepEqual(native.outputSchema, RESULT_SCHEMA);
    await until(() => followUps.length);
    assert.match(followUps[0].summary.text, /partial answer/);
    assert.match(followUps[0].summary.text, /"ok":true/);
  });
}, TIMEOUT);

test('default hidden yield without an output schema keeps native completion plain', async () => {
  const yieldTool = {
    name: 'yield', parameters: {
      type: 'object', properties: {
        type: { type: 'string' },
        data: { type: 'object', additionalProperties: true, description: 'Structured JSON output (no schema specified)' },
        error: { type: 'string' },
      }, required: [], additionalProperties: false,
    },
  };
  await withHost({ turns: ['rich-output'] }, undefined, async ({ providers, dir }) => {
    const result = await stream(providers, { messages: [at('default yield', 36000)], tools: [yieldTool] }, { sessionId: 'default-yield' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.equal(textOf(result.message), 'partial answer\n\nfinal answer');
    assert.deepEqual(result.message.content.find(block => block.type === 'toolCall').arguments, { type: 'result' });
    assert.ok(!('outputSchema' in sentParams(dir, 'turn/start')[0]));
  });
}, TIMEOUT);

test('a caller object-or-boolean schema remains a union instead of becoming an incremental-section wrapper', async () => {
  const union = { anyOf: [RESULT_SCHEMA, { type: 'boolean' }] };
  const data = { ...union, description: `Structured output matching the schema:\n${JSON.stringify(union)}` };
  await withHost({ turns: ['rich-output'] }, undefined, async ({ providers, dir }) => {
    const tool = { ...structuredYield, parameters: { ...structuredYield.parameters, properties: { ...structuredYield.parameters.properties, data } } };
    const result = await stream(providers, { messages: [at('union output', 37000)], tools: [tool], outputSchema: union }, { sessionId: 'union-output' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.deepEqual(sentParams(dir, 'turn/start')[0].outputSchema, union);
    assert.deepEqual(result.message.content.find(block => block.type === 'toolCall').arguments.data, { ok: true });
  });
}, TIMEOUT);

test('native compaction rejection preserves the original record and cannot fall back to a writable summarizer turn', async () => {
  await withHost({ compactError: 'fixture native compaction rejected', turns: ['finish-later'] }, undefined, async ({ providers, dir }) => {
    const { config, model } = providerModel(providers);
    const task = at('reject compaction', 38000);
    const first = await stream(providers, { messages: [task] }, { sessionId: 'compact-error' });
    const entries = [messageEntry('user1', null, task), messageEntry('answer1', 'user1', first.message)];
    const ctx = lifecycleContext('compact-error', model, entries);
    const original = readFileSync(recordFile('compact-error'), 'utf8');
    const event = { preparation: { firstKeptEntryId: 'answer1', tokensBefore: 30000 }, branchEntries: entries, signal: new AbortController().signal };
    assert.deepEqual(await config.streamSimple.beforeCompact(event, ctx), { cancel: true });
    assert.equal(readFileSync(recordFile('compact-error'), 'utf8'), original);
    assert.deepEqual(ctx.sessionManager.getBranch(), entries);
    assert.match(ctx.notices[0].message, /fixture native compaction rejected/);
    assert.equal(sentParams(dir, 'thread/compact/start').length, 1);
    assert.equal(sentParams(dir, 'turn/start').length, 1, 'no summarization task or inference retry');
  });
}, TIMEOUT);

test('focused compaction refuses explicitly before native compaction or fallback inference', async () => {
  await withHost({ turns: ['finish-later'] }, undefined, async ({ providers, dir }) => {
    const { config, model } = providerModel(providers);
    const first = await stream(providers, { messages: [at('focused compaction', 39000)] }, { sessionId: 'focused-compact' });
    const ctx = lifecycleContext('focused-compact', model, [messageEntry('answer1', null, first.message)]);
    const original = readFileSync(recordFile('focused-compact'), 'utf8');
    const event = {
      customInstructions: 'Preserve architecture decisions',
      preparation: { firstKeptEntryId: 'answer1', tokensBefore: 30000 }, signal: new AbortController().signal,
    };
    assert.deepEqual(await config.streamSimple.beforeCompact(event, ctx), { cancel: true });
    assert.match(ctx.notices[0].message, /does not accept summary focus instructions/);
    assert.equal(readFileSync(recordFile('focused-compact'), 'utf8'), original);
    assert.equal(sentParams(dir, 'thread/compact/start').length, 0);
    assert.equal(sentParams(dir, 'turn/start').length, 1);
  });
}, TIMEOUT);

test('invalid image MIME and mismatched data URLs stop before native effects', async () => {
  await withHost({}, undefined, async ({ providers, dir }) => {
    for (const image of [
      { type: 'image', mimeType: 'application/pdf', data: 'aGVsbG8=' },
      { type: 'image', mimeType: 'image/png', data: 'data:text/plain;base64,aGVsbG8=' },
    ]) {
      const result = await stream(providers, { messages: [user('', { timestamp: 40000, content: [image] })] }, { sessionId: `bad-image-${image.mimeType}` });
      assert.equal(result.final.type, 'error');
      assert.match(result.message.errorMessage, /image/);
    }
    assert.deepEqual(mutations(dir), []);
  });
}, TIMEOUT);

test('mixed live steering preserves image data URLs and the durable attachment identity on requeue', async () => {
  await withHost({ turns: ['work'] }, undefined, async ({ providers, dir }) => {
    const attachment = user('', { timestamp: 41000, content: [
      { type: 'text', text: 'inspect this attachment' },
      { type: 'image', mimeType: 'image/png', data: 'data:image/png;base64,aGVsbG8=' },
    ] });
    let offered = false;
    let accepted = false;
    const liveSteering = {
      wait: signal => offered ? new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) : Promise.resolve(),
      claim: async () => {
        if (offered) return undefined;
        offered = true;
        return { messages: [attachment], accept: () => { accepted = true; }, reject: () => assert.fail('native mixed steering was rejected') };
      },
    };
    const task = at('mixed steering task', 40500);
    const first = await stream(providers, { messages: [task] }, { sessionId: 'image-steer', liveSteering });
    assert.equal(first.final.type, 'done', first.message.errorMessage);
    assert.equal(accepted, true);
    const [steer] = sentParams(dir, 'turn/steer');
    assert.deepEqual(steer.input, [
      { type: 'text', text: 'inspect this attachment', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,aGVsbG8=' },
    ]);
    assert.ok(readRecord('image-steer').sent.includes(inputId(attachment)));
    const repeated = await stream(providers, { messages: [task, first.message, attachment] }, { sessionId: 'image-steer' });
    assert.equal(repeated.final.type, 'done', repeated.message.errorMessage);
    assert.equal(sentParams(dir, 'turn/start').length, 1);
    assert.equal(sentParams(dir, 'turn/steer').length, 1);
  });
}, TIMEOUT);

test('usage from an older native request is not reused as the next turn context measurement', async () => {
  await withHost({ turns: ['rich-output', 'finish-later'] }, undefined, async ({ providers }) => {
    const first = await stream(providers, { messages: [at('measured usage', 42000)] }, { sessionId: 'stale-usage' });
    assert.equal(first.message.usage.contextTokens, 90);
    const second = await stream(providers, { messages: [first.message, at('unreported usage', 43000)] }, { sessionId: 'stale-usage' });
    assert.equal(second.final.type, 'done', second.message.errorMessage);
    assert.equal(second.message.usage.contextTokens, undefined);
    assert.equal(second.message.usage.totalTokens, 0);
  });
}, TIMEOUT);

test('a fresh resumed client reports authoritative context but does not mistake last-request usage for turn billing', async () => {
  await withRestart({ turns: ['rich-output'] }, restartStore([nativeTurn('U1', 'completed')]), async () => {
    writeRecord('usage-resumed', { threadId: 'T1', turnId: 'U1', admitted: true, sent: [inputId(TASK)] });
    const result = await afterRestart({ messages: [TASK, NEW_INPUT] }, { sessionId: 'usage-resumed' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.equal(result.message.usage.contextTokens, 90);
    assert.equal(result.message.usage.input, 0);
    assert.equal(result.message.usage.output, 0);
    assert.equal(result.message.usage.totalTokens, 0);
    assert.equal(result.message.usage.reasoningTokens, undefined);
  });
}, TIMEOUT);

test('clear cannot silently abandon a stale unowned native turn and create concurrent workspace work', async () => {
  await withRestart({ staleTurns: true }, restartStore([nativeTurn('U1', 'inProgress')]), async ({ providers, dir }) => {
    const { config } = providerModel(providers);
    writeRecord('clear-stale', { threadId: 'T1', turnId: 'U1', admitted: true, sent: [inputId(TASK)] });
    const original = readFileSync(recordFile('clear-stale'), 'utf8');
    try {
      await assert.rejects(config.streamSimple.clear('clear-stale'));
      assert.equal(readFileSync(recordFile('clear-stale'), 'utf8'), original);
      assert.deepEqual(mutations(dir), []);
    } finally {
      await config.streamSimple.close('clear-stale');
    }
  });
}, TIMEOUT);

for (const [name, field, input] of [
  ['integer minimum', { type: 'integer', minimum: 1, maximum: 10 }, '0'],
  ['integer maximum', { type: 'integer', minimum: 1, maximum: 10 }, '11'],
  ['integer type', { type: 'integer', minimum: 1, maximum: 10 }, '1.5'],
  ['string minimum', { type: 'string', minLength: 2, maxLength: 3 }, 'a'],
  ['string maximum', { type: 'string', minLength: 2, maxLength: 3 }, 'four'],
  ['array minimum', { type: 'array', items: { enum: ['a', 'b'] }, minItems: 1, maxItems: 2 }, '[]'],
  ['array maximum', { type: 'array', items: { enum: ['a', 'b'] }, minItems: 1, maxItems: 2 }, '["a","b","a"]'],
]) {
  test(`MCP form ${name} uses maintained whole-schema validation and declines invalid input`, async () => {
    const elicitationSchema = { type: 'object', properties: { value: field }, required: ['value'] };
    await withHost({ elicitationSchema, turns: ['elicitation'] }, undefined, async ({ providers, ctx, dir }) => {
      ctx.hasUI = true;
      let submitPrompts = 0;
      let inputPrompts = 0;
      ctx.ui.input = async () => { inputPrompts++; return input; };
      ctx.ui.select = async title => { if (title.includes('Submit these answers?')) submitPrompts++; return 'Submit answers'; };
      const result = await stream(providers, { messages: [at(`invalid ${name}`, 44000)] }, { sessionId: `form-${name}` });
      assert.equal(result.final.type, 'done', result.message.errorMessage);
      const answer = trace(dir).find(({ message }) => message?.id === 902 && !message.method)?.message;
      assert.deepEqual(answer.result, { action: 'decline' });
      assert.equal(submitPrompts, 0, 'invalid content never reaches explicit submit');
      assert.equal(inputPrompts, 1, 'rendering succeeded and whole-form validation checked the supplied value');
    });
  }, TIMEOUT);
}

test('MCP required fields cannot disappear from the original schema during UI rendering', async () => {
  const elicitationSchema = { type: 'object', properties: {}, required: ['notRendered'] };
  await withHost({ elicitationSchema, turns: ['elicitation'] }, undefined, async ({ providers, ctx, dir }) => {
    ctx.hasUI = true;
    let submissions = 0;
    ctx.ui.select = async () => { submissions++; return 'Submit answers'; };
    const result = await stream(providers, { messages: [at('required field', 45000)] }, { sessionId: 'required-form' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    const answer = trace(dir).find(({ message }) => message?.id === 902 && !message.method)?.message;
    assert.deepEqual(answer.result, { action: 'decline' });
    assert.equal(submissions, 0);
  });
}, TIMEOUT);

for (const format of ['email', 'uri', 'date', 'date-time']) {
  test(`MCP ${format} format declines before UI when the installed validator cannot enforce it`, async () => {
    const elicitationSchema = { type: 'object', properties: { value: { type: 'string', format } }, required: ['value'] };
    await withHost({ elicitationSchema, turns: ['elicitation'] }, undefined, async ({ providers, ctx, dir }) => {
      ctx.hasUI = true;
      let asked = 0;
      const notices = [];
      ctx.ui.input = async () => { asked++; return 'not-a-valid-format'; };
      ctx.ui.select = async () => { asked++; return 'Submit answers'; };
      ctx.ui.notify = message => notices.push(message);
      const result = await stream(providers, { messages: [at(`format ${format}`, 46000)] }, { sessionId: `format-${format}` });
      assert.equal(result.final.type, 'done', result.message.errorMessage);
      const answer = trace(dir).find(({ message }) => message?.id === 902 && !message.method)?.message;
      assert.deepEqual(answer.result, { action: 'decline' });
      assert.equal(asked, 0);
      assert.ok(notices.some(message => /format validation is unsupported/.test(message)));
    });
  }, TIMEOUT);
}

const ASYNC_QUESTIONS = [
  { title: 'Which environment?', options: ['Staging', 'Production'] },
  { title: 'Which region?', options: ['West', 'East'] },
];

for (const omitted of [true, false]) {
  test(`async askDialog keeps one answer when the other question is ${omitted ? 'omitted' : 'empty'}`, async () => {
    await withHost({ asyncQuestions: ASYNC_QUESTIONS, turns: ['async-question'] }, undefined, async ({ providers, ctx, dir }) => {
      ctx.hasUI = true;
      let asked = 0;
      let answeredId;
      ctx.ui.askDialog = async questions => {
        asked++;
        assert.equal(questions.length, 2);
        answeredId = questions[0].id;
        return {
          kind: 'submit',
          results: [
            { id: questions[0].id, selectedOptions: ['Staging'], customInput: '', timedOut: false },
            ...(omitted ? [] : [{ id: questions[1].id, selectedOptions: [], customInput: '', timedOut: false }]),
          ],
        };
      };
      const result = await stream(providers, { messages: [at('async dialog subset', 47000)] }, { sessionId: `async-dialog-${omitted}` });
      assert.equal(result.final.type, 'done', result.message.errorMessage);
      assert.equal(asked, 1, 'duplicate item delivery cannot reopen the dialog');
      const [steer] = sentParams(dir, 'turn/steer');
      assert.equal(sentParams(dir, 'turn/steer').length, 1);
      assert.equal(steer.input[0].text,
        `<send_user_message_question_reply>\n${JSON.stringify([{ answer: 'Staging', question: 'Which environment?', questionItemId: answeredId }])}\n</send_user_message_question_reply>`);
      assert.equal(sentParams(dir, 'turn/start').length, 1);
    });
  }, TIMEOUT);
}

test('async RPC select fallback explicitly skips one question while preserving another answer', async () => {
  await withHost({ asyncQuestions: ASYNC_QUESTIONS, turns: ['async-question'] }, undefined, async ({ providers, ctx, dir }) => {
    ctx.hasUI = true;
    ctx.mode = 'rpc';
    const asked = [];
    ctx.ui.select = async (title, options) => {
      asked.push({ title, options });
      assert.ok(options.some(option => option.label === 'Skip this question'));
      return title.includes('Which environment?') ? 'Staging' : 'Skip this question';
    };
    const result = await stream(providers, { messages: [at('async RPC subset', 48000)] }, { sessionId: 'async-rpc-subset' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.equal(asked.length, 2);
    const [steer] = sentParams(dir, 'turn/steer');
    assert.equal(sentParams(dir, 'turn/steer').length, 1);
    const prefix = '<send_user_message_question_reply>\n';
    const suffix = '\n</send_user_message_question_reply>';
    assert.ok(steer.input[0].text.startsWith(prefix) && steer.input[0].text.endsWith(suffix));
    const replies = JSON.parse(steer.input[0].text.slice(prefix.length, -suffix.length));
    assert.deepEqual(replies.map(({ answer, question }) => ({ answer, question })), [{ answer: 'Staging', question: 'Which environment?' }]);
    assert.equal(sentParams(dir, 'turn/start').length, 1);
  });
}, TIMEOUT);

test('native Other-enabled option questions use rich root askDialog and preserve an allowed custom answer', async () => {
  await withHost({ questionIsOther: true, turns: ['question'] }, undefined, async ({ providers, ctx, dir }) => {
    ctx.hasUI = true;
    let richDialogs = 0;
    let selections = 0;
    ctx.ui.select = async () => { selections++; return undefined; };
    ctx.ui.askDialog = async questions => {
      richDialogs++;
      assert.equal(questions.length, 1);
      assert.equal(questions[0].id, 'environment');
      return {
        kind: 'submit',
        results: [{ id: 'environment', selectedOptions: [], customInput: 'Preview workspace', timedOut: false }],
      };
    };
    const result = await stream(providers, { messages: [at('rich native Other', 49000)] }, { sessionId: 'rich-native-other' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.equal(richDialogs, 1);
    assert.equal(selections, 0);
    const answer = trace(dir).find(({ message }) => message?.id === 901 && !message.method)?.message;
    assert.deepEqual(answer.result, { answers: { environment: { answers: ['Preview workspace'] } } });
    assert.equal(sentParams(dir, 'turn/start').length, 1);
  });
}, TIMEOUT);

test('static default advertises image and effort support before background native discovery', async () => {
  assert.equal(CODEX_BRIDGE_MODELS[0].reasoning, true);
  assert.deepEqual(CODEX_BRIDGE_MODELS[0].input, ['text', 'image']);
  await withHost({}, undefined, async ({ providers, dir }) => {
    const [registered] = providers.get(PROVIDER).models;
    assert.equal(registered.reasoning, true);
    assert.deepEqual(registered.input, ['text', 'image']);
    assert.equal(sentParams(dir, 'model/list').length, 0, 'first-prompt capabilities require no background catalog barrier');
  });
}, TIMEOUT);

test('discovered model restrictions remain authoritative for default and explicit native profiles', async () => {
  const { fetchCodexModels } = await import('../src/omp/provider.mjs');
  const models = await fetchCodexModels({ createClient: () => ({
    listModels: async () => [{
      model: 'text-only-native', isDefault: true, inputModalities: ['text'], supportedReasoningEfforts: [],
    }],
    close: async () => {},
  }) });
  assert.deepEqual(models.map(model => ({ id: model.id, reasoning: model.reasoning, input: model.input })), [
    { id: 'default', reasoning: false, input: ['text'] },
    { id: 'text-only-native', reasoning: false, input: ['text'] },
  ]);
});

test('native output schema preserves nested caller closure removed from the yield wire schema', async () => {
  const declared = {
    type: 'object', additionalProperties: false, required: ['ok'],
    properties: {
      ok: { type: 'boolean' },
      metadata: { type: 'object', properties: { label: { type: 'string' } }, additionalProperties: false },
    },
  };
  const data = {
    description: `Structured output matching the schema:\n${JSON.stringify(declared)}`,
    anyOf: [{
      type: 'object', required: ['ok'], properties: {
        ok: { type: 'boolean' }, metadata: { type: 'object', properties: { label: { type: 'string' } } },
      },
    }, { type: 'boolean' }, { type: 'object', properties: { label: { type: 'string' } } }],
  };
  await withHost({ turns: ['rich-output'] }, undefined, async ({ providers, dir }) => {
    const tool = { ...structuredYield, parameters: { ...structuredYield.parameters, properties: { ...structuredYield.parameters.properties, data } } };
    const result = await stream(providers, { messages: [at('nested closed output', 50000)], tools: [tool], outputSchema: declared }, { sessionId: 'nested-closed' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.deepEqual(sentParams(dir, 'turn/start')[0].outputSchema, declared);
    assert.deepEqual(result.message.content.find(block => block.type === 'toolCall').arguments.data, { ok: true });
  });
}, TIMEOUT);

for (const mode of ['unphased-json', 'nullphase-json']) {
  test(`${mode} validates only the last unphased answer, without concatenating partial prose`, async () => {
    await withHost({ turns: [mode] }, undefined, async ({ providers, dir }) => {
      const result = await stream(providers, {
        messages: [at(mode, 51000)], tools: [structuredYield], outputSchema: RESULT_SCHEMA,
      }, { sessionId: mode });
      assert.equal(result.final.type, 'done', result.message.errorMessage);
      assert.deepEqual(result.message.content.find(block => block.type === 'toolCall').arguments, { data: { ok: true } });
      assert.match(textOf(result.message), /partial/);
      assert.equal(sentParams(dir, 'turn/start').length, 1);
    });
  }, TIMEOUT);
}

test('tree rewind followed immediately by compact forks at A and never compacts abandoned B', async () => {
  await withHost({ turns: ['finish-later', 'finish-later'] }, undefined, async ({ providers, dir }) => {
    const { config, model } = providerModel(providers);
    const taskA = at('checkpoint A', 52000);
    const first = await stream(providers, { messages: [taskA] }, { sessionId: 'compact-rewind' });
    const taskB = at('abandoned B', 53000);
    const second = await stream(providers, { messages: [taskA, first.message, taskB] }, { sessionId: 'compact-rewind' });
    const entries = [
      messageEntry('user-a', null, taskA), messageEntry('answer-a', 'user-a', first.message),
      messageEntry('user-b', 'answer-a', taskB), messageEntry('answer-b', 'user-b', second.message),
    ];
    const ctx = lifecycleContext('compact-rewind', model, entries);
    assert.equal(await config.streamSimple.beforeTree({
      preparation: { targetId: 'answer-a', userWantsSummary: false }, signal: new AbortController().signal,
    }, ctx), undefined);
    ctx.setEntries(entries.slice(0, 2));
    config.streamSimple.afterTree({ newLeafId: 'answer-a' }, ctx);
    const originalThread = sentParams(dir, 'turn/start')[0].threadId;
    const originalTurns = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')).threads[originalThread].turns;
    const replacement = await config.streamSimple.beforeCompact({
      preparation: { firstKeptEntryId: 'answer-a', tokensBefore: 30000 }, signal: new AbortController().signal,
    }, ctx);
    assert.ok(replacement?.compaction, JSON.stringify(ctx.notices));
    const [fork] = sentParams(dir, 'thread/fork');
    assert.equal(fork.threadId, originalThread);
    assert.equal(fork.lastTurnId, first.message.responseId.split(':').at(-1));
    assert.notEqual(replacement.compaction.preserveData.codexNative.threadId, originalThread);
    assert.equal(sentParams(dir, 'thread/compact/start')[0].threadId, replacement.compaction.preserveData.codexNative.threadId);
    assert.equal(sentParams(dir, 'turn/start').length, 2);
    assert.equal(sentParams(dir, 'turn/steer').length, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')).threads[originalThread].turns, originalTurns);
  });
}, TIMEOUT);

test('reload then compact with no new input attaches metadata only and creates no generation', async () => {
  await withHost({ turns: ['finish-later'] }, undefined, async ({ providers, dir }) => {
    const { config, model } = providerModel(providers);
    const task = at('reload compact checkpoint', 54000);
    const first = await stream(providers, { messages: [task] }, { sessionId: 'compact-reload' });
    const ctx = lifecycleContext('compact-reload', model, [
      messageEntry('user1', null, task), messageEntry('answer1', 'user1', first.message),
    ]);
    const nativeThread = readRecord('compact-reload').threadId;
    await config.streamSimple.close('compact-reload');
    const resumesBefore = sentParams(dir, 'thread/resume').length;
    const replacement = await config.streamSimple.beforeCompact({
      preparation: { firstKeptEntryId: 'answer1', tokensBefore: 30000 }, signal: new AbortController().signal,
    }, ctx);
    assert.ok(replacement?.compaction, JSON.stringify(ctx.notices));
    assert.equal(sentParams(dir, 'thread/resume').length - resumesBefore, 1);
    assert.equal(sentParams(dir, 'thread/compact/start')[0].threadId, nativeThread);
    assert.equal(sentParams(dir, 'turn/start').length, 1);
    assert.equal(sentParams(dir, 'turn/steer').length, 0);
    assert.equal(sentParams(dir, 'thread/fork').length, 0);
    await config.streamSimple.close('compact-reload');
  });
}, TIMEOUT);

test('compact preserves authoritative occupied context with zero last-request billing buckets', async () => {
  await withHost({ compactUsage: true, turns: ['rich-output'] }, undefined, async ({ providers }) => {
    const { config, model } = providerModel(providers);
    const first = await stream(providers, { messages: [at('compact usage', 55000)] }, { sessionId: 'compact-usage' });
    const ctx = lifecycleContext('compact-usage', model, [messageEntry('answer1', null, first.message)]);
    const replacement = await config.streamSimple.beforeCompact({
      preparation: { firstKeptEntryId: 'answer1', tokensBefore: 30000 }, signal: new AbortController().signal,
    }, ctx);
    assert.ok(replacement?.compaction, JSON.stringify(ctx.notices));
    const usage = replacement.compaction.details.nativeUsage;
    assert.equal(usage.total.totalTokens, 150);
    assert.equal(usage.last.totalTokens, 25863);
    assert.deepEqual([
      usage.last.inputTokens, usage.last.cachedInputTokens, usage.last.outputTokens, usage.last.reasoningOutputTokens,
    ], [0, 0, 0, 0]);
    assert.equal(replacement.compaction.tokensAfter, undefined, 'no inferred reduction from incompatible counter meanings');
  });
}, TIMEOUT);

test('journal JSON Schema stays authoritative when the tool wire schema and description disagree', async () => {
  const open = { ...RESULT_SCHEMA, additionalProperties: true };
  await withHost({ turns: ['invalid-extra'] }, undefined, async ({ providers, dir }) => {
    const result = await stream(providers, {
      messages: [at('journal open schema', 56000)], tools: [structuredYield], outputSchema: open,
    }, { sessionId: 'journal-open' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.deepEqual(sentParams(dir, 'turn/start')[0].outputSchema, open);
    assert.deepEqual(result.message.content.find(block => block.type === 'toolCall').arguments.data, { ok: true, extra: 1 });
  });
}, TIMEOUT);

test('JSON string output schema is parsed from session_init, never from tool descriptions', async () => {
  await withHost({ turns: ['rich-output'] }, undefined, async ({ providers, dir }) => {
    const tool = { ...structuredYield, parameters: { ...structuredYield.parameters, properties: {
      ...structuredYield.parameters.properties, data: { description: 'not machine-readable schema metadata' },
    } } };
    const result = await stream(providers, {
      messages: [at('journal string schema', 57000)], tools: [tool], outputSchema: JSON.stringify(RESULT_SCHEMA),
    }, { sessionId: 'journal-string' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.deepEqual(sentParams(dir, 'turn/start')[0].outputSchema, RESULT_SCHEMA);
  });
}, TIMEOUT);

test('missing current session_init never trusts inert source_session_init or tool description metadata', async () => {
  await withHost({}, undefined, async ({ providers, dir }) => {
    const { model } = providerModel(providers);
    lifecycleContext('inert-schema', model, [{
      id: 'inert', type: 'custom', customType: 'source_session_init', data: { outputSchema: RESULT_SCHEMA },
    }]);
    const result = await stream(providers, {
      messages: [at('inert schema', 58000)], tools: [structuredYield], outputSchema: RESULT_SCHEMA,
    }, { sessionId: 'inert-schema' });
    assert.equal(result.final.type, 'error');
    assert.match(result.message.errorMessage, /authoritative session_init/);
    assert.deepEqual(mutations(dir), []);
  });
}, TIMEOUT);

test('unsupported non-object and JTD output declarations fail before native effects', async () => {
  await withHost({}, undefined, async ({ providers, dir }) => {
    for (const [index, outputSchema] of [
      false, true, [], '{bad json', { elements: { type: 'string' } },
      { type: 'object', properties: { nested: { optionalProperties: { note: { type: 'string' } } } } },
      { type: 'int32' },
    ].entries()) {
      const result = await stream(providers, {
        messages: [at('unsupported schema', 59000)], tools: [structuredYield], outputSchema,
      }, { sessionId: `unsupported-schema-${index}` });
      assert.equal(result.final.type, 'error', JSON.stringify(outputSchema));
    }
    assert.deepEqual(mutations(dir), []);
    assert.equal(spawns(dir), 0);
  });
}, TIMEOUT);

test('direct boolean outputSchema is rejected before starting a native process', async () => {
  await withHost({}, undefined, async ({ call, dir }) => {
    const result = await call({ action: 'run', prompt: 'boolean schema forbidden', outputSchema: false, cwd });
    assert.equal(result.isError, true);
    assert.match(result.json.error, /JSON Schema object/);
    assert.equal(spawns(dir), 0);
    assert.deepEqual(mutations(dir), []);
  });
}, TIMEOUT);

test('provider request hooks bind journal schema to a different provider UUID and preserve reset boundaries', async () => {
  await withHost({ turns: ['rich-output', 'rich-output'] }, undefined, async ({ providers, dir }) => {
    const { config, model } = providerModel(providers);
    const setup = { id: 'setup', parentId: null, type: 'session_init', outputSchema: RESULT_SCHEMA };
    const ctx = lifecycleContext('journal-owner', model, [setup]);
    sessionContexts.set('provider-before-clear', ctx);
    const oldInput = at('old native context', 60000);
    const first = await stream(providers, {
      messages: [oldInput], tools: [structuredYield],
    }, { sessionId: 'provider-before-clear' });
    assert.equal(first.final.type, 'done', first.message.errorMessage);
    const oldEntries = [
      setup, messageEntry('user1', 'setup', oldInput), messageEntry('answer1', 'user1', first.message),
    ];
    ctx.setEntries(oldEntries);
    const compact = await config.streamSimple.beforeCompact({
      preparation: { firstKeptEntryId: 'answer1', tokensBefore: 30000 }, signal: new AbortController().signal,
    }, ctx);
    assert.ok(compact?.compaction, JSON.stringify(ctx.notices));
    const compactEntry = { id: 'compact1', parentId: 'answer1', type: 'compaction', ...compact.compaction };
    assert.equal(compact.compaction.preserveData.codexNative.providerSessionId, 'provider-before-clear');
    await config.streamSimple.clear('journal-owner');
    await config.streamSimple.close('journal-owner');
    const reset = { id: 'reset1', parentId: 'compact1', type: 'reset_boundary' };
    const newInput = at('new context after clear', 61000);
    ctx.setEntries([...oldEntries, compactEntry, reset, messageEntry('new-user', 'reset1', newInput)]);
    ctx.model = { ...model, provider: 'other-provider' };
    assert.equal(config.streamSimple.context({ messages: [newInput] }, ctx), undefined);
    assert.equal(ctx.aborted, false, 'old opaque compaction behind reset cannot block a different provider');
    ctx.model = model;
    sessionContexts.set('provider-after-clear', ctx);
    const next = await stream(providers, { messages: [newInput], tools: [structuredYield] }, { sessionId: 'provider-after-clear' });
    assert.equal(next.final.type, 'done', next.message.errorMessage);
    const turns = sentParams(dir, 'turn/start');
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[1].outputSchema, RESULT_SCHEMA, 'session_init settings survive the reset boundary');
    assert.notEqual(turns[1].threadId, turns[0].threadId, 'reset creates a new native exchange');
    assert.doesNotMatch(inputText(turns[1]), /old native context|Codex compacted its native thread/);
    await config.streamSimple.close('journal-owner');
  });
}, TIMEOUT);

test('provider request hooks cannot redirect native work by replacing session identity', async () => {
  await withHost({}, undefined, async ({ providers, dir }) => {
    const { config, model } = providerModel(providers);
    const ctx = lifecycleContext('identity-journal', model, [{ type: 'session_init', outputSchema: RESULT_SCHEMA }]);
    sessionContexts.set('identity-provider', ctx);
    const result = await stream(providers, { messages: [at('identity protected', 62000)], tools: [structuredYield] }, {
      sessionId: 'identity-provider',
      onPayload: payload => {
        payload.sessionId = 'foreign-binding';
        try { config.streamSimple.beforeProviderRequest({ payload }, ctx); } catch { /* host reports hook errors and keeps processing */ }
        return payload;
      },
    });
    assert.equal(result.final.type, 'error');
    assert.match(result.message.errorMessage, /changed native request identity/);
    assert.deepEqual(mutations(dir), []);
    assert.equal(spawns(dir), 0);
    assert.deepEqual(readdirSync(STATE_DIR), []);
  });
}, TIMEOUT);

test('abort during awaited provider request hooks prevents every native side effect', async () => {
  await withHost({}, undefined, async ({ providers, dir }) => {
    const { config, model } = providerModel(providers);
    const controller = new AbortController();
    const ctx = lifecycleContext('hook-abort-journal', model, [{ type: 'session_init', outputSchema: RESULT_SCHEMA }]);
    sessionContexts.set('hook-abort-provider', ctx);
    const result = await stream(providers, { messages: [at('abort at hook', 63000)], tools: [structuredYield] }, {
      sessionId: 'hook-abort-provider', signal: controller.signal,
      onPayload: async payload => {
        config.streamSimple.beforeProviderRequest({ payload }, ctx);
        await Promise.resolve();
        controller.abort();
        return payload;
      },
    });
    assert.equal(result.final.reason, 'aborted');
    assert.deepEqual(mutations(dir), []);
    assert.equal(spawns(dir), 0);
    assert.deepEqual(readdirSync(STATE_DIR), []);
  });
}, TIMEOUT);

test('an empty reset ledger cannot replay native input from a later provider identity', async () => {
  await withRestart({}, undefined, async ({ dir }) => {
    writeRecord('empty-reset-ledger', {
      admitted: false, threadId: undefined, turnId: undefined, threads: ['older-owned-thread'], sent: [],
    });
    const prior = {
      role: 'assistant', provider: PROVIDER, api: DEFAULT_MODEL.api, model: 'default',
      content: [{ type: 'text', text: 'native outcome already observed' }], stopReason: 'error', timestamp: 64000, usage: {},
    };
    const original = readFileSync(recordFile('empty-reset-ledger'), 'utf8');
    const result = await afterRestart({
      messages: [at('already delivered native task', 63500), prior, at('continue without replay', 65000)],
    }, { sessionId: 'empty-reset-ledger' });
    assert.equal(result.final.type, 'error');
    assert.match(result.message.errorMessage, /earlier Codex turns/);
    assert.equal(readFileSync(recordFile('empty-reset-ledger'), 'utf8'), original);
    assert.deepEqual(mutations(dir), []);
  });
}, TIMEOUT);

test('schema metadata comes from the active branch rather than unrelated session_init entries', async () => {
  await withHost({ turns: ['rich-output'] }, undefined, async ({ providers, dir }) => {
    const { model } = providerModel(providers);
    const current = { id: 'current-init', type: 'session_init', outputSchema: RESULT_SCHEMA };
    const other = { id: 'other-init', type: 'session_init', outputSchema: {
      type: 'object', properties: { unrelated: { type: 'string' } }, required: ['unrelated'], additionalProperties: false,
    } };
    const ctx = lifecycleContext('branch-schema', model, [current]);
    ctx.sessionManager.getEntries = () => [current, other];
    const result = await stream(providers, {
      messages: [at('active branch schema', 66000)], tools: [structuredYield],
    }, { sessionId: 'branch-schema' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.deepEqual(sentParams(dir, 'turn/start')[0].outputSchema, RESULT_SCHEMA);
  });
}, TIMEOUT);

test('forceReasoningOff overrides requested effort only when native none is advertised', async () => {
  await withHost({ reasoningEfforts: ['none', 'high'], turns: ['finish-later'] }, undefined, async ({ providers, dir }) => {
    const result = await stream(providers, { messages: [at('forced reasoning off', 67000)] }, {
      sessionId: 'forced-reasoning-off', reasoning: 'high', forceReasoningOff: true,
    });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.equal(sentParams(dir, 'turn/start')[0].effort, 'none');
  });
  await withHost({}, undefined, async ({ providers, dir }) => {
    const result = await stream(providers, { messages: [at('unsupported forced reasoning off', 67001)] }, {
      sessionId: 'unsupported-forced-off', reasoning: 'high', forceReasoningOff: true,
    });
    assert.equal(result.final.type, 'error');
    assert.match(result.message.errorMessage, /reasoning effort none/);
    assert.deepEqual(mutations(dir), []);
  });
}, TIMEOUT);

for (const mode of ['openai/form', 'openaiForm']) {
  test(`native ${mode} elicitation validates flat fields before explicit submission`, async () => {
    const elicitationSchema = {
      type: 'object', properties: { environment: { type: 'string', enum: ['Production'] } }, required: ['environment'],
    };
    await withHost({ elicitationMode: mode, elicitationSchema, turns: ['elicitation'] }, undefined, async ({ providers, ctx, dir }) => {
      ctx.hasUI = true;
      let submissions = 0;
      ctx.ui.select = async title => {
        if (title.includes('Submit these answers?')) { submissions++; return 'Submit answers'; }
        return 'Production';
      };
      const result = await stream(providers, { messages: [at(`native ${mode} flat form`, 68000)] }, { sessionId: `native-form-${mode}` });
      assert.equal(result.final.type, 'done', result.message.errorMessage);
      const answer = trace(dir).find(({ message }) => message?.id === 902 && !message.method)?.message;
      assert.deepEqual(answer.result, { action: 'accept', content: { environment: 'Production' } });
      assert.equal(submissions, 1);
    });
  }, TIMEOUT);

  test(`native ${mode} elicitation declines unrenderable nested schemas before UI`, async () => {
    const elicitationSchema = { type: 'object', properties: { nested: { type: 'object', properties: { value: { type: 'string' } } } } };
    await withHost({ elicitationMode: mode, elicitationSchema, turns: ['elicitation'] }, undefined, async ({ providers, ctx, dir }) => {
      ctx.hasUI = true;
      let dialogs = 0;
      ctx.ui.select = ctx.ui.input = async () => { dialogs++; return 'must not be used'; };
      const result = await stream(providers, { messages: [at(`unsupported ${mode} form`, 69000)] }, { sessionId: `unsupported-form-${mode}` });
      assert.equal(result.final.type, 'done', result.message.errorMessage);
      const answer = trace(dir).find(({ message }) => message?.id === 902 && !message.method)?.message;
      assert.deepEqual(answer.result, { action: 'decline' });
      assert.equal(dialogs, 0);
    });
  }, TIMEOUT);
}

for (const transition of ['branch', 'fork', 'whole-fork']) {
  test(`official ${transition} lifecycle forks native history without replaying source receipts`, async () => {
    await withHost({ turns: Array(3).fill('finish-later') }, undefined, async ({ providers, ctx, handlers, dir }) => {
      const { config, model } = providerModel(providers);
      const setup = { id: 'init', parentId: null, type: 'session_init' };
      const source = Object.assign(lifecycleContext('source-journal', model, [setup]), { agent: ctx.agent });
      sessionContexts.set('source-provider', source);
      const task = at('original branch task', 70000);
      const first = await stream(providers, { messages: [task] }, { sessionId: 'source-provider' });
      const followUp = at('source follow-up', 71000);
      const second = await stream(providers, { messages: [task, first.message, followUp] }, { sessionId: 'source-provider' });
      assert.equal(second.final.type, 'done', second.message.errorMessage);
      const entries = [
        setup, messageEntry('user1', 'init', task), messageEntry('answer1', 'user1', first.message),
        messageEntry('user2', 'answer1', followUp), messageEntry('answer2', 'user2', second.message),
      ];
      source.setEntries(entries);
      const originalRecord = readFileSync(recordFile('source-provider'), 'utf8');
      const before = mutations(dir).length;
      const whole = transition === 'whole-fork';
      const beforeEvent = whole ? 'session_before_switch' : 'session_before_branch';
      const result = await handlers.get(beforeEvent)({
        type: beforeEvent, reason: whole ? 'fork' : transition,
        ...(whole ? {} : { entryId: transition === 'branch' ? 'user2' : 'answer1' }),
      }, source);
      assert.equal(result, undefined);
      assert.equal(mutations(dir).length, before, 'preflight never forks native history');
      const kept = whole ? entries : entries.slice(0, 3);
      const target = Object.assign(lifecycleContext('branch-journal', model, kept), { agent: ctx.agent });
      sessionContexts.set('branch-provider', target);
      const afterEvent = whole ? 'session_switch' : 'session_branch';
      await handlers.get(afterEvent)({ type: afterEvent, reason: whole ? 'fork' : transition }, target);
      assert.equal(mutations(dir).length, before, 'journal adoption only copies durable receipts');
      const history = whole ? [task, first.message, followUp, second.message] : [task, first.message];
      const next = await stream(providers, { messages: [...history, at('new branch input', 72000)] }, { sessionId: 'branch-provider' });
      assert.equal(next.final.type, 'done', next.message.errorMessage);
      const [fork] = sentParams(dir, 'thread/fork');
      assert.ok(fork, 'first new input forks the native checkpoint');
      assert.equal(fork.threadId, readRecord('source-provider').threadId);
      assert.equal(fork.lastTurnId, (whole ? second : first).message.responseId.split(':').at(-1));
      assert.equal(sentParams(dir, 'turn/start').length, 3);
      assert.equal(deliveries(dir, 'original branch task'), 1);
      assert.equal(deliveries(dir, 'source follow-up'), 1);
      assert.equal(deliveries(dir, 'new branch input'), 1);
      assert.equal(readFileSync(recordFile('source-provider'), 'utf8'), originalRecord, 'source ledger remains unchanged');
      const branchRecord = readRecord('branch-provider');
      assert.notEqual(branchRecord.threadId, readRecord('source-provider').threadId);
      assert.ok(branchRecord.sent.includes(inputId(task)), 'inherited input identity remains delivered');
      await config.streamSimple.close('branch-journal');
    });
  }, TIMEOUT);
}

test('official entry fork refuses incomplete native answers before changing history', async () => {
  await withHost({}, undefined, async ({ providers, ctx, handlers, dir }) => {
    const { model } = providerModel(providers);
    const partial = { role: 'assistant', provider: PROVIDER, content: [{ type: 'text', text: 'partial' }], stopReason: 'aborted' };
    const source = Object.assign(lifecycleContext('partial-fork', model, [messageEntry('partial', null, partial)]), { agent: ctx.agent });
    const result = await handlers.get('session_before_branch')({ type: 'session_before_branch', reason: 'fork', entryId: 'partial' }, source);
    assert.deepEqual(result, { cancel: true });
    assert.match(source.notices[0].message, /not a completed native turn/);
    assert.deepEqual(mutations(dir), []);
  });
}, TIMEOUT);

test('invalid live steering rejects its official OMP claim exactly once before native delivery', async () => {
  await withHost({ turns: ['work-then-finish'] }, undefined, async ({ providers, dir }) => {
    let offered = false;
    const settlements = [];
    const invalid = user('', {
      timestamp: 73000, content: [{ type: 'image', mimeType: 'text/plain', data: 'not-an-image' }],
    });
    const liveSteering = {
      wait: signal => offered ? new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) : Promise.resolve(),
      claim: async () => {
        if (offered) return undefined;
        offered = true;
        return { messages: [invalid], accept: () => settlements.push('accept'), reject: () => settlements.push('reject') };
      },
    };
    const result = await stream(providers, { messages: [at('valid active input', 72999)] }, {
      sessionId: 'invalid-live-input', liveSteering,
    });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.deepEqual(settlements, ['reject']);
    assert.equal(sentParams(dir, 'turn/steer').length, 0);
    assert.equal(sentParams(dir, 'turn/start').length, 1);
    assert.ok(!readRecord('invalid-live-input').sent.includes(inputId(invalid)));
  });
}, TIMEOUT);

test('extracted storage retains session filenames, native-config receipts and text input identities', async () => {
  const { loadSession, saveSession, sessionFile } = await import('../src/omp/session-store.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'codex-ledger-compat-'));
  try {
    const sessionId = 'ledger/한글:stable';
    const message = { role: 'user', timestamp: 1234, content: 'legacy text receipt' };
    assert.equal(inputId(message), `1234:${createHash('sha256').update(message.content).digest('hex').slice(0, 32)}`);
    const expectedFile = join(dir, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
    assert.equal(sessionFile(dir, sessionId), expectedFile);
    const opaque = { version: 1, threadId: 'T1', turnId: 'U2', providerSessionId: sessionId, opaqueExtension: { retained: true } };
    const record = {
      policy: 'native-config', config: {}, cwd, model: 'legacy-model', threadId: 'T1', turnId: 'U2',
      admitted: true, sent: [inputId(message)], latestResponseId: 'codex-bridge:T1:U1',
      opaque, rewrite: null, threads: ['T1', 'older-thread'],
    };
    writeFileSync(expectedFile, JSON.stringify(record));
    const loaded = loadSession(dir, sessionId, 'ignored-selection', 'ignored-cwd');
    assert.equal(loaded.model, record.model);
    saveSession(dir, loaded);
    assert.deepEqual(JSON.parse(readFileSync(expectedFile, 'utf8')), record);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Consumer-only double: native projection is tested in client.test.mjs; these snapshots match its public contract.
async function progressConsumer({ initial = {}, updates = [], finalText = '{"ok":true}', onProgress } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-progress-consumer-'));
  const sessionId = 'progress-consumer';
  const state = {
    threadId: 'T-progress', turnId: 'U-progress', status: 'inProgress', events: [],
    model: 'gpt-6.1-sol', cwd, text: `partial answer\n${finalText}`, finalText,
    execution: { model: 'gpt-6.1-sol', cwd, requestedReasoningEffort: null },
    latestActivity: null, latestPlan: null, commandFailure: null, ...initial,
  };
  let request;
  let notifications;
  let scheduled = false;
  const listeners = new Set();
  const provider = createCodexBridgeProvider({
    EventStream: AssistantMessageEventStream, stateDir: dir, onProgress,
    createClient(options) {
      notifications = options.onNotification;
      return {
        snapshot: () => structuredClone(state),
        run: async options => { request = options; options.onThread(state.threadId); return structuredClone(state); },
        subscribe(listener) {
          listeners.add(listener);
          if (!scheduled) {
            scheduled = true;
            setTimeout(() => {
              for (const { method, params, semantic } of updates) {
                Object.assign(state, semantic);
                if (params.turnId === state.turnId && !Object.hasOwn(semantic ?? {}, 'latestActivity')) state.latestActivity = { method, params, at: Date.now() };
                notifications(method, params);
                for (const notify of listeners) notify({ threadId: state.threadId, turnId: state.turnId, status: state.status });
              }
              state.status = 'completed';
              const params = { threadId: state.threadId, turn: { id: state.turnId, status: state.status } };
              notifications('turn/completed', params);
              for (const notify of listeners) notify({ threadId: state.threadId, turnId: state.turnId, status: state.status });
            }, 0);
          }
          return () => listeners.delete(listener);
        },
        close: async () => {},
      };
    },
  });
  provider.context({}, lifecycleContext(sessionId, DEFAULT_MODEL, [
    { id: 'progress-init', parentId: null, type: 'session_init', outputSchema: RESULT_SCHEMA },
  ]));
  try {
    const events = [];
    for await (const event of provider(DEFAULT_MODEL, { messages: [at('progress contract', 42)], tools: [structuredYield] }, { sessionId, cwd })) {
      events.push(event);
      if (event.type === 'done' || event.type === 'error') break;
    }
    const final = events.at(-1);
    return { events, final, message: final.type === 'done' ? final.message : final.error, request };
  } finally {
    await provider.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('provider recovers evicted semantic plan and failed command tail without polluting strict final JSON', async () => {
  const statuses = [];
  const outputTail = `OLD OUTPUT ${'x'.repeat(4000)}\n\u001b[31mDECISIVE FAILURE\u001b[0m\u001b]0;unsafe title\u0007\u0000\u0008\u000d\u0085\n\tuseful detail`;
  const initial = {
    execution: { model: 'gpt-6.1-sol', cwd, requestedReasoningEffort: 'high' },
    latestPlan: { turnId: 'U-progress', explanation: 'Inspect and fix', plan: [
      { step: 'Inspect', status: 'completed' }, { step: 'Fix', status: 'inProgress' },
    ] },
    commandFailure: { itemId: 'failed-command', command: 'check', exitCode: 17, outputTail, outputTruncated: true },
    latestActivity: { method: 'item/completed', params: { turnId: 'U-progress', item: {
      id: 'failed-command', type: 'commandExecution', command: 'check', status: 'failed', exitCode: 17,
    } }, at: 1 },
  };
  const { message, final, request } = await progressConsumer({ initial, onProgress: (_session, status) => statuses.push(structuredClone(status)) });
  assert.equal(final.type, 'done', message.errorMessage);
  assert.deepEqual(request.outputSchema, RESULT_SCHEMA);
  assert.deepEqual(message.content.find(block => block.type === 'toolCall').arguments, { data: { ok: true } });
  assert.equal(textOf(message), 'partial answer\n{"ok":true}');
  const thinking = message.content.find(block => block.type === 'thinking').thinking;
  assert.equal(thinking.match(/native execution:/g).length, 1);
  assert.match(thinking, /turn U-progress completed/);
  assert.match(thinking, /model gpt-6\.1-sol; cwd .*; requested reasoning effort high; effective reasoning effort unknown/);
  assert.match(thinking, /\[completed\] Inspect\n\[inProgress\] Fix/);
  assert.match(thinking, /command output tail \(truncated\); may contain sensitive data:/);
  assert.match(thinking, /DECISIVE FAILURE/);
  assert.match(thinking, /DECISIVE FAILURE\n\tuseful detail/);
  assert.doesNotMatch(thinking, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|unsafe title/);
  assert.doesNotMatch(thinking, /OLD OUTPUT/);
  assert.ok(statuses.some(status => status?.plan?.includes('[inProgress] Fix')));
  assert.ok(statuses.some(status => status?.activity?.includes('DECISIVE FAILURE')));
  assert.ok(statuses.every(status => !status?.activity || !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|unsafe title/.test(status.activity)));
  assert.equal(initial.commandFailure.outputTail, outputTail, 'display cleaning does not rewrite raw native details');
  assert.equal(statuses.at(-1), undefined);
});

test('provider explicitly caps append log while replacing latest activity and plan beyond the cap', async () => {
  const statuses = [];
  const params = item => ({ threadId: 'T-progress', turnId: 'U-progress', item });
  const latestPlan = { turnId: 'U-progress', explanation: 'LATEST PLAN', plan: [
    { step: 'Latest task', status: 'inProgress' },
  ] };
  const updates = [
    ...Array.from({ length: 60 }, (_, id) => ({
      method: 'item/completed', params: params({ id: `noise-${id}`, type: 'reasoning', summary: ['noise '.repeat(500)] }),
    })),
    { method: 'turn/plan/updated', params: { threadId: 'T-progress', ...latestPlan }, semantic: { latestPlan } },
    { method: 'item/started', params: params({ id: 'latest', type: 'commandExecution', command: 'LATEST NATIVE ACTIVITY' }) },
    { method: 'item/started', params: { turnId: 'other-turn', item: { type: 'commandExecution', command: 'FOREIGN ACTIVITY' } } },
    {
      method: 'model/rerouted',
      params: { threadId: 'T-progress', turnId: 'U-progress', fromModel: 'gpt-6.1-sol', toModel: 'gpt-6-astra', reason: 'capacity' },
      // Even a snapshot with older semantic activity must not overwrite this newer live notification.
      semantic: { latestActivity: { method: 'item/started', params: params({
        id: 'latest', type: 'commandExecution', command: 'LATEST NATIVE ACTIVITY',
      }), at: 1 } },
    },
    {
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'T-progress', turnId: 'U-progress', tokenUsage: { last: { totalTokens: 10 }, modelContextWindow: 1000 } },
    },
  ];
  const { events, message, final } = await progressConsumer({ updates, onProgress: (_session, status) => statuses.push(structuredClone(status)) });
  assert.equal(final.type, 'done', message.errorMessage);
  const thinking = message.content.find(block => block.type === 'thinking').thinking;
  assert.ok(thinking.length <= 64 * 1024);
  assert.equal(thinking.match(/64K-character append log limit reached/g).length, 1);
  assert.match(thinking, /requested reasoning effort unknown \(Codex default request\)/);
  assert.doesNotMatch(thinking, /LATEST PLAN|LATEST NATIVE ACTIVITY|FOREIGN ACTIVITY|model rerouted/);
  assert.ok(statuses.some(status => status?.logTruncated && status.activity?.includes('LATEST NATIVE ACTIVITY') && status.plan?.includes('LATEST PLAN')));
  assert.ok(statuses.every(status => !status || (status.activity?.length ?? 0) <= 2000 && (status.plan?.length ?? 0) <= 2000));
  assert.ok(statuses.every(status => !status?.activity?.includes('FOREIGN ACTIVITY')));
  const rerouteIndex = statuses.findIndex(status => status?.logTruncated && status.activity?.includes('model rerouted gpt-6.1-sol → gpt-6-astra (capacity)'));
  assert.ok(rerouteIndex >= 0, 'new reroute replaces older activity after append cap');
  assert.match(statuses[rerouteIndex + 1].activity, /model rerouted gpt-6\.1-sol → gpt-6-astra/);
  assert.ok(statuses.every(status => !status || status.execution.model === 'gpt-6.1-sol'), 'routing display never changes bound model identity');
  assert.equal(events.filter(event => event.type === 'thinking_start').length, 1);
  assert.equal(events.filter(event => event.type === 'thinking_end').length, 1);
  assert.equal(textOf(message), 'partial answer\n{"ok":true}');
  assert.deepEqual(message.content.find(block => block.type === 'toolCall').arguments, { data: { ok: true } });
  assert.equal(statuses.at(-1), undefined);
});

test('progress never relaxes structured final JSON validation', async () => {
  const { final, message } = await progressConsumer({ finalText: '{"ok":true,"unexpected":true}' });
  assert.equal(final.type, 'error');
  assert.match(message.errorMessage, /invalid structured data/);
  assert.ok(message.content.every(block => block.type !== 'toolCall'));
});

test('task metadata names native history and forwards the OMP tier without changing later defaults', async () => {
  await withHost({ turns: ['finish-later', 'finish-later'], ompServiceTier: 'priority' }, undefined, async ({ child, dir }) => {
    const worker = await child('ParserReview');
    let title = 'Parser review';
    worker.ctx.sessionManager.getSessionName = () => title;
    const sessionId = worker.ctx.sessionManager.getSessionId();
    const onPayload = payload => worker.handlers.get('before_provider_request')({ payload }, worker.ctx);
    const firstPrompt = user('inspect parser');
    const first = await stream(worker.providers, { messages: [firstPrompt] }, { sessionId, onPayload });
    assert.equal(first.final.type, 'done', first.message.errorMessage);
    await until(() => trace(dir).some(entry => entry.message?.method === 'thread/name/set'));
    title = 'Parser error paths';
    const second = await stream(worker.providers, { messages: [firstPrompt, first.message, user('inspect errors')] }, { sessionId, onPayload, serviceTier: 'auto' });
    assert.equal(second.final.type, 'done', second.message.errorMessage);
    await until(() => trace(dir).filter(entry => entry.message?.method === 'thread/name/set').length === 2);
    const calls = trace(dir).map(entry => entry.message).filter(Boolean);
    assert.deepEqual(calls.filter(call => call.method === 'thread/name/set').map(call => call.params.name), ['Parser review', 'Parser error paths']);
    const turns = calls.filter(call => call.method === 'turn/start');
    assert.equal(turns[0].params.serviceTierForTurn, 'priority');
    assert.ok(!Object.hasOwn(turns[1].params, 'serviceTierForTurn'));
    assert.ok(turns.every(turn => !Object.hasOwn(turn.params, 'serviceTier')));
    assert.equal(new Set(turns.map(turn => turn.params.threadId)).size, 1);
  });
}, TIMEOUT);

test('native title failure cannot reject or replay a task', async () => {
  await withHost({ turns: ['finish-later'], nameError: 'title refused' }, undefined, async ({ child, dir }) => {
    const worker = await child('Review');
    const result = await stream(worker.providers, { messages: [user('inspect')] }, {
      sessionId: worker.ctx.sessionManager.getSessionId(),
      onPayload: payload => worker.handlers.get('before_provider_request')({ payload }, worker.ctx),
    });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    assert.equal(trace(dir).filter(entry => entry.message?.method === 'turn/start').length, 1);
  });
}, TIMEOUT);

test('Hub and direct-tool quota notifications share one native warning without starting extra work', async () => {
  const event = { rateLimits: { limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 100, resetsAt: 1900000000 } } };
  await withHost({ turns: ['finish-later', 'finish-later'], rateLimitUpdatesOnTurn: [event, event] }, undefined, async ({ child, ctx, call, dir }) => {
    const notices = [];
    ctx.hasUI = true;
    ctx.ui.notify = (message, type) => notices.push({ message, type });
    const worker = await child('QuotaReview');
    const result = await stream(worker.providers, { messages: [user('inspect')] }, { sessionId: 'quota-worker' });
    assert.equal(result.final.type, 'done', result.message.errorMessage);
    const direct = await call({ action: 'run', prompt: 'inspect direct', cwd });
    assert.equal(direct.isError, false);
    await until(() => notices.length > 0);
    assert.equal(notices.filter(notice => notice.type === 'warning').length, 1);
    assert.match(notices[0].message, /limit reached.*100%.*reset/);
    assert.equal(trace(dir).filter(entry => entry.message?.method === 'turn/start').length, 2);
  });
}, TIMEOUT);

test('direct run and fork report optional naming errors without hiding admitted work', async () => {
  await withHost({ turns: ['finish-later'], nameError: 'title refused' }, undefined, async ({ call, followUps, dir }) => {
    const started = await call({ action: 'run', prompt: 'inspect', cwd, name: 'Review' });
    assert.equal(started.isError, false);
    assert.match(started.json.nameWarning, /title refused/);
    await until(() => followUps.length > 0);
    const forked = await call({ action: 'fork', threadId: started.json.threadId, name: 'Follow-up review' });
    assert.equal(forked.isError, false);
    assert.equal(forked.json.forked, true);
    assert.match(forked.json.nameWarning, /title refused/);
    assert.notEqual(forked.json.threadId, started.json.threadId);
    assert.equal(trace(dir).filter(entry => entry.message?.method === 'turn/start').length, 1);
    assert.equal(trace(dir).filter(entry => entry.message?.method === 'thread/fork').length, 1);
  });
}, TIMEOUT);

test('direct history fork preserves its source and continues only the new owned thread', async () => {
  const source = { id: 'saved-one', cwd, name: 'Saved review', turns: [{ id: 'saved-turn', status: 'completed', items: [] }] };
  const store = { nextThread: 10, nextTurn: 10, threads: { 'saved-one': source } };
  await withHost({ turns: ['finish-later', 'finish-later'] }, store, async ({ call, followUps, dir }) => {
    const forked = await call({ action: 'fork', threadId: 'saved-one', name: 'Follow-up review' });
    assert.equal(forked.isError, false);
    assert.equal(forked.json.inferenceStarted, false);
    assert.match(forked.json.scope, /not an Agent Hub worker/);
    assert.notEqual(forked.json.threadId, source.id);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')).threads[source.id], source);
    assert.equal(trace(dir).filter(entry => entry.message?.method === 'turn/start').length, 0);
    const denied = await call({ action: 'run', threadId: source.id, prompt: 'must not run', cwd });
    assert.equal(denied.json.code, 'THREAD_NOT_OWNED');
    const continued = await call({ action: 'run', threadId: forked.json.threadId, prompt: 'continue review', cwd, name: 'Renamed review', serviceTier: 'fast' });
    assert.equal(continued.isError, false);
    await until(() => followUps.length === 1);
    const another = await call({ action: 'run', prompt: 'new review', cwd });
    assert.equal(another.isError, false);
    const turns = trace(dir).filter(entry => entry.message?.method === 'turn/start').map(entry => entry.message.params);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].threadId, forked.json.threadId);
    assert.equal(turns[0].serviceTierForTurn, 'fast');
    assert.ok(!Object.hasOwn(turns[1], 'serviceTierForTurn'));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')).threads[source.id], source);
  });
}, TIMEOUT);
