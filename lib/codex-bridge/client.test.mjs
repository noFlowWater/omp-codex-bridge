import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexNativeClient } from './client.mjs';

// `node client.test.mjs --fake-app-server` runs the protocol double below instead of the tests.
// extension.test.mjs starts the same double through a temporary `codex` executable.
const FAKE_FLAG = '--fake-app-server';
const FAKE_MODE = process.argv.includes(FAKE_FLAG);
const it = FAKE_MODE ? () => {} : test;

const cwd = realpathSync(process.cwd());
// 700 KB of UTF-8 (3- and 4-byte characters), 300k UTF-16 units: under the 1 MiB retained-text cap.
const BIG_TEXT = '가🙂'.repeat(100000);
const UTF8_TEXT = '한글 ✓ 🙂 mixed — 끝';
const ENV_NAMES = ['HOME', 'PATH', 'CODEX_HOME', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'KUBECONFIG', 'CODEX_TEST_SECRET'];
const MUTATIONS = new Set(['thread/start', 'thread/resume', 'thread/fork', 'thread/compact/start', 'turn/start', 'turn/steer', 'turn/interrupt']);

// Protocol double of `codex app-server --stdio` using Codex 0.167.2 message shapes; it never starts Codex
// or requests inference. $CODEX_HOME holds options.json (behaviour), store.json (persisted threads that
// survive restarts) and trace.jsonl (one spawn record per process plus every message the client sent).
// Turn behaviour is selected by the prompt text.
function fakeServer() {
  const home = process.env.CODEX_HOME;
  const file = (name) => join(home, name);
  const options = existsSync(file('options.json')) ? JSON.parse(readFileSync(file('options.json'), 'utf8')) : {};
  const store = existsSync(file('store.json'))
    ? JSON.parse(readFileSync(file('store.json'), 'utf8'))
    : { nextThread: 0, nextTurn: 0, threads: {} };
  // A turn left running by a dead process is not running in this one; `staleTurns` keeps its stale record.
  if (!options.staleTurns) {
    for (const thread of Object.values(store.threads)) {
      for (const turn of thread.turns) if (turn.status === 'inProgress') turn.status = 'interrupted';
    }
  }
  const save = () => writeFileSync(file('store.json'), JSON.stringify(store));
  // Several app-server processes may share one CODEX_HOME (one per OMP child client): merge their
  // counters and threads before allocating IDs, so IDs and the `turns` script stay global.
  const sync = () => {
    if (!existsSync(file('store.json'))) return;
    const disk = JSON.parse(readFileSync(file('store.json'), 'utf8'));
    for (const key of ['nextThread', 'nextTurn', 'attempts']) store[key] = Math.max(store[key] ?? 0, disk[key] ?? 0);
    for (const [id, thread] of Object.entries(disk.threads ?? {})) store.threads[id] ??= thread;
  };
  const record = (entry) => appendFileSync(file('trace.jsonl'), `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
  const loaded = new Set();
  const running = new Map();
  const serverRequests = new Map();
  let optOut = new Set();
  let initialized = false;
  process.stdout.on('error', () => {});
  if (options.slowExit) process.on('SIGTERM', () => setTimeout(() => process.exit(0), options.slowExit));
  record({ spawn: true });

  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const reply = (id, result) => send({ id, result });
  const refuse = (id, message, code = -32600) => send({ id, error: { code, message } });
  const notify = (method, params) => { if (!optOut.has(method)) send({ method, params }); };
  const later = (ms, action) => setTimeout(action, ms);

  const threadView = (thread) => ({
    id: thread.id, sessionId: thread.id, forkedFromId: null, parentThreadId: thread.parentThreadId ?? null,
    preview: '', ephemeral: false, modelProvider: 'openai', model: 'fake-model', createdAt: 1, updatedAt: 1,
    status: running.has(thread.id) ? { type: 'active', activeFlags: [] } : { type: 'idle' },
    path: null, cwd: thread.cwd, cliVersion: '0.167.2', source: 'appServer', turns: [],
  });
  // Notifications and admissions carry no items; `thread/turns/list` returns them for itemsView "full".
  const turnView = (turn, itemsView = 'notLoaded') => ({
    id: turn.id, rootTurnId: null, items: itemsView === 'full' ? turn.items : [], itemsView,
    status: turn.status, error: turn.error ?? null, startedAt: 1,
    completedAt: turn.status === 'inProgress' ? null : 2, durationMs: null,
  });
  const agentMessage = (id, text) => ({
    type: 'agentMessage', id, text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null,
  });
  const commandItem = (id, output) => ({
    type: 'commandExecution', id, pluginId: null, scriptPath: null, command: 'ls -la', cwd: home, processId: null,
    source: 'agent', status: 'completed', commandActions: [], aggregatedOutput: output, exitCode: 0, durationMs: 1,
  });

  function item(thread, turn, entry) {
    const started = entry.type === 'agentMessage' ? { ...entry, text: '' } : { ...entry, status: 'inProgress', aggregatedOutput: null };
    notify('item/started', { item: started, threadId: thread.id, turnId: turn.id, startedAtMs: 1 });
    if (entry.type === 'agentMessage') {
      notify('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId: entry.id, delta: entry.text });
    }
    turn.items.push(entry);
    notify('item/completed', { item: entry, threadId: thread.id, turnId: turn.id, completedAtMs: 2 });
  }

  function complete(thread, turn, status = 'completed', text = `done: ${turn.prompt}`, message = 'quota exhausted') {
    if (turn.status !== 'inProgress') return;
    if (text !== null) item(thread, turn, agentMessage(`${turn.id}-answer`, text));
    turn.status = status;
    if (status === 'failed') turn.error = { message, codexErrorInfo: 'usageLimitExceeded', additionalDetails: null };
    running.delete(thread.id);
    save();
    notify('turn/completed', { threadId: thread.id, turn: turnView(turn) });
  }

  function usage(thread, turn) {
    const previous = thread.tokenUsage?.total ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
    const increment = { inputTokens: 120, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 5, totalTokens: 150 };
    const interim = { inputTokens: 50, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 1, totalTokens: 60 };
    notify('thread/tokenUsage/updated', {
      threadId: thread.id, turnId: turn.id,
      tokenUsage: { total: Object.fromEntries(Object.entries(interim).map(([key, value]) => [key, previous[key] + value])),
        last: interim, modelContextWindow: 200000 },
    });
    thread.tokenUsage = {
      total: Object.fromEntries(Object.entries(increment).map(([key, value]) => [key, previous[key] + value])),
      last: { inputTokens: 80, cachedInputTokens: 10, outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 90 },
      modelContextWindow: 200000,
    };
    notify('thread/tokenUsage/updated', { threadId: thread.id, turnId: turn.id, tokenUsage: thread.tokenUsage });
  }

  function question(thread, turn, mode) {
    const form = mode === 'elicitation';
    const id = form ? 902 : 901;
    const params = form ? {
      threadId: thread.id, turnId: turn.id, serverName: 'fixture', mode: 'form', message: 'Which environment?',
      requestedSchema: options.elicitationSchema ?? { type: 'object', properties: { environment: { type: 'string', enum: ['Staging', 'Production'] } }, required: ['environment'] },
    } : {
      threadId: thread.id, turnId: turn.id, itemId: `${turn.id}-question`, isBlocking: true,
      questions: [{
        id: 'environment', header: 'Environment', question: 'Which environment?', isOther: options.questionIsOther ?? false, isSecret: false,
        options: [{ label: 'Staging', description: 'Test environment' }, { label: 'Production', description: 'Live environment' }],
      }],
    };
    serverRequests.set(id, () => complete(thread, turn, 'completed', form ? 'elicitation answered' : 'question answered'));
    send({ id, method: form ? 'mcpServer/elicitation/request' : 'item/tool/requestUserInput', params });
    if (mode === 'question-resolved') later(50, () => {
      serverRequests.delete(id);
      notify('serverRequest/resolved', { threadId: thread.id, requestId: id });
    });
    if (mode === 'question-ended') later(50, () => complete(thread, turn, 'completed', 'ended without answer'));
  }

  function big(thread, turn) {
    for (let index = 0; index < 40; index++) item(thread, turn, commandItem(`command-${index}`, 'o'.repeat(20000)));
    complete(thread, turn, 'completed', BIG_TEXT);
    notify('turn/completed', { threadId: thread.id, turn: turnView(turn) }); // repeated delivery
  }

  function child(parent) {
    const thread = { id: 'child-thread', cwd: parent.cwd, parentThreadId: parent.id };
    const turn = { id: 'child-turn', status: 'inProgress', items: [] };
    notify('thread/started', { thread: threadView(thread) });
    notify('turn/started', { threadId: thread.id, turn: turnView(turn) });
    item(thread, turn, agentMessage('child-answer', 'child secret'));
    turn.status = 'completed';
    notify('turn/completed', { threadId: thread.id, turn: turnView(turn) });
  }

  function utf8(thread, turn) {
    const entry = agentMessage(`${turn.id}-answer`, UTF8_TEXT);
    turn.items.push(entry);
    turn.status = 'completed';
    running.delete(thread.id);
    save();
    const bytes = Buffer.from([
      { method: 'item/completed', params: { item: entry, threadId: thread.id, turnId: turn.id, completedAtMs: 2 } },
      { method: 'turn/completed', params: { threadId: thread.id, turn: turnView(turn) } },
    ].map((message) => `${JSON.stringify(message)}\n`).join(''));
    // Chunks end inside a 3-byte and a 4-byte character; the last carries a line tail plus a whole line.
    const first = bytes.indexOf(Buffer.from('글')) + 1;
    const second = bytes.indexOf(Buffer.from('🙂')) + 2;
    process.stdout.write(bytes.subarray(0, first));
    later(30, () => process.stdout.write(bytes.subarray(first, second)));
    later(60, () => process.stdout.write(bytes.subarray(second)));
  }

  function openThread({ id, method, params }) {
    if (options.exitOnStart) process.exit(23);
    let thread = store.threads[params.threadId];
    if (method === 'thread/resume' && !thread) {
      refuse(id, `no rollout found for thread id ${params.threadId}`);
      return;
    }
    if (method === 'thread/start' || method === 'thread/fork') {
      sync();
      let turns = [];
      if (method === 'thread/fork') {
        if (!thread) { refuse(id, 'source thread not found'); return; }
        const end = params.lastTurnId === undefined ? thread.turns.length : thread.turns.findIndex(turn => turn.id === params.lastTurnId) + 1;
        if ((params.lastTurnId !== undefined && !end) || thread.turns.slice(0, end).some(turn => turn.status === 'inProgress')) {
          refuse(id, 'fork anchor missing or active', -32602);
          return;
        }
        turns = structuredClone(thread.turns.slice(0, end));
      }
      thread = { id: `thread-${++store.nextThread}`, cwd: params.cwd ?? process.cwd(), turns };
      store.threads[thread.id] = thread;
      save();
    }
    // A persisted inProgress record alone is stale; this option models a live native resume.
    if (method === 'thread/resume' && options.liveResume) {
      const active = thread.turns.findLast(turn => turn.status === 'inProgress');
      if (active) running.set(thread.id, active);
    }
    loaded.add(thread.id);
    const mode = params.sandbox ?? 'workspace-write';
    const result = {
      thread: threadView(thread), model: params.model ?? 'fake-model', modelProvider: 'openai', serviceTier: null,
      disabledPluginIds: [], cwd: params.cwd ?? thread.cwd, instructionSources: [],
      approvalPolicy: params.approvalPolicy ?? 'on-request', approvalsReviewer: 'user',
      // Effective policies as reported by a real 0.167.2 server for these modes.
      sandbox: mode === 'read-only' ? { type: 'readOnly', networkAccess: false }
        : mode === 'workspace-write'
          ? { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
          : { type: 'dangerFullAccess' },
      reasoningEffort: null,
      ...(method === 'thread/resume' ? { collaborationMode: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null } : {}),
    };
    // Simulates configuration or requirements changing the effective controls; null removes a field.
    for (const [key, value] of Object.entries(options.permissions ?? {})) {
      if (value === null) delete result[key];
      else result[key] = value;
    }
    const started = () => notify('thread/started', { thread: threadView(thread) });
    if (options.earlyThread) {
      started();
      const foreign = { id: 'foreign-thread', cwd: '/', parentThreadId: thread.id };
      notify('thread/started', { thread: threadView(foreign) });
      notify('turn/completed', { threadId: foreign.id, turn: turnView({ id: 'foreign-turn', status: 'completed', items: [] }) });
    }
    // Delays (and drops, below) apply to the first request of their kind only, so a later retry is answered.
    later(method === 'thread/start' && store.nextThread === 1 ? options.startDelay ?? 0 : 0, () => {
      reply(id, result);
      if (!options.earlyThread) started();
    });
  }

  function startTurn({ id, params }, thread) {
    if (running.has(thread.id)) {
      refuse(id, 'thread already has an active turn');
      return;
    }
    const prompt = (params.input ?? []).filter(entry => entry.type === 'text').map(entry => entry.text).join('\n\n');
    if (params.effort === 'invalid-native-effort' || params.outputSchema?.nativeReject) {
      refuse(id, 'native effort or output schema validation failed', -32602);
      return;
    }
    // `turns` scripts the n-th turn/start of this CODEX_HOME by behaviour name, whatever the prompt text:
    // the provider forwards wrapped OMP prompts, so its tests cannot select behaviour by exact text.
    sync();
    store.attempts = (store.attempts ?? 0) + 1;
    save();
    const mode = options.turns?.[store.attempts - 1] ?? prompt;
    if (mode === 'reject') {
      refuse(id, `turn rejected by native validation: ${'detail '.repeat(20000)}`, -32602);
      return;
    }
    if (mode === 'crash-now') {
      process.stderr.write('STDERR-SECRET crash\n');
      process.exit(17);
    }
    const turn = { id: `turn-${++store.nextTurn}`, prompt, status: 'inProgress', items: [], error: null };
    thread.turns.push(turn);
    running.set(thread.id, turn);
    save();
    // The admission view is taken before any completion, as a racing server would send it.
    const admission = turnView(turn);
    const admit = () => reply(id, { turn: admission });
    notify('turn/started', { threadId: thread.id, turn: turnView(turn) });
    if (mode === 'early') {
      item(thread, turn, commandItem('early-command', 'early output'));
      complete(thread, turn, 'completed', 'early answer');
      admit();
      return;
    }
    if (mode === 'big-early') {
      big(thread, turn);
      admit();
      return;
    }
    if (mode === 'slow-admit') {
      later(800, () => { admit(); later(50, () => complete(thread, turn)); });
      return;
    }
    if (options.dropTurnReply && store.attempts === 1) {
      later(options.dropTurnReply, () => complete(thread, turn));
      return;
    }
    admit();
    switch (mode) {
      case 'hold': return;
      case 'question':
      case 'question-resolved':
      case 'question-ended':
      case 'elicitation': question(thread, turn, mode); return;
      case 'partial-final':
      case 'rich-output':
        later(50, () => {
          item(thread, turn, { ...agentMessage(`${turn.id}-partial`, 'partial answer'), phase: 'partial_answer' });
          usage(thread, turn);
          complete(thread, turn, 'completed', params.outputSchema ? '{"ok":true}' : 'final answer');
        });
        return;
      case 'usage': later(50, () => { usage(thread, turn); complete(thread, turn); }); return;
      case 'invalid-json': complete(thread, turn, 'completed', '{broken'); return;
      case 'invalid-data': complete(thread, turn, 'completed', '{"ok":"wrong"}'); return;
      case 'invalid-extra': complete(thread, turn, 'completed', '{"ok":true,"extra":1}'); return;
      case 'explicit-empty-final':
        item(thread, turn, { ...agentMessage(`${turn.id}-partial`, '{"ok":true}'), phase: 'partial_answer' });
        complete(thread, turn, 'completed', '');
        return;
      case 'unphased-json':
      case 'nullphase-json': {
        item(thread, turn, { ...agentMessage(`${turn.id}-partial`, 'partial answer'), phase: 'partial_answer' });
        const answer = agentMessage(`${turn.id}-answer`, '{"ok":true}');
        if (mode === 'unphased-json') delete answer.phase;
        else answer.phase = null;
        item(thread, turn, answer);
        complete(thread, turn, 'completed', null);
        return;
      }
      case 'async-question':
      case 'async-question-ended': {
        const entry = { ...agentMessage(`${turn.id}-async`, 'Which environment?'), phase: 'commentary',
          delivery: 'async', questions: options.asyncQuestions ?? [{ title: 'Which environment?', options: ['Staging', 'Production'] }] };
        item(thread, turn, entry);
        notify('item/completed', { threadId: thread.id, turnId: turn.id, item: entry });
        if (mode === 'async-question-ended') later(50, () => complete(thread, turn));
        return;
      }
      case 'image-echo':
        item(thread, turn, { type: 'userMessage', id: `${turn.id}-input`, content: params.input });
        notify('turn/diff/updated', { threadId: thread.id, turnId: turn.id, diff: 'd'.repeat(5 * 1024 * 1024) });
        complete(thread, turn, 'completed', 'image received');
        return;
      // Visible native progress (a completed command item), then stays active until steered or interrupted.
      case 'work': later(50, () => item(thread, turn, commandItem(`${turn.id}-command`, 'fixture command output'))); return;
      // Visible native progress, then finishes on its own after 3 s (window for a message queued by OMP).
      case 'work-then-finish':
        later(50, () => item(thread, turn, commandItem(`${turn.id}-command`, 'fixture command output')));
        later(3000, () => complete(thread, turn));
        return;
      case 'progress':
        later(50, () => { item(thread, turn, commandItem(`${turn.id}-command`, 'fixture command output')); later(50, () => complete(thread, turn)); });
        return;
      // Usage-limit wording in the style Codex reports; OMP's error classifier may treat such text as retriable.
      case 'usage-limit':
        later(50, () => complete(thread, turn, 'failed', null, "You've hit your usage limit. Upgrade to Pro or try again later."));
        return;
      case 'fail': complete(thread, turn, 'failed', null); return;
      case 'fail-later': later(100, () => complete(thread, turn, 'failed', null)); return;
      case 'finish-later': later(100, () => complete(thread, turn)); return;
      case 'big': later(100, () => big(thread, turn)); return;
      case 'child': later(50, () => { child(thread); complete(thread, turn); }); return;
      case 'crash-later': later(50, () => process.exit(18)); return;
      case 'garbage':
        later(20, () => process.stdout.write('not json\n'));
        later(250, () => process.stdout.write('still not json\n'));
        return;
      case 'stderr':
        // Synchronous on a Linux pipe: blocks forever unless the client drains stderr.
        process.stderr.write(`STDERR-SECRET ${'e'.repeat(2 * 1024 * 1024)}\n`);
        complete(thread, turn, 'completed', 'stderr drained');
        return;
      case 'utf8': utf8(thread, turn); return;
      case 'ascii-big': complete(thread, turn, 'completed', 'a'.repeat(3_600_000)); return;
      case 'env':
        complete(thread, turn, 'completed', JSON.stringify(Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name] ?? null]))));
        return;
      case 'approval':
        serverRequests.set(900, () => complete(thread, turn));
        send({ id: 900, method: 'item/commandExecution/requestApproval', params: {
          threadId: thread.id, turnId: turn.id, itemId: 'dangerous-command', command: 'touch forbidden',
        } });
        return;
      default: complete(thread, turn);
    }
  }

  function listTurns({ id, params }, thread) {
    const ordered = params.sortDirection === 'asc' ? [...thread.turns] : [...thread.turns].reverse();
    const offset = Number(params.cursor ?? 0);
    const end = offset + (params.limit ?? 25);
    reply(id, {
      data: ordered.slice(offset, end).map((turn) => turnView(turn, params.itemsView ?? 'summary')),
      nextCursor: end < ordered.length ? String(end) : null,
      backwardsCursor: offset < ordered.length ? String(offset) : null,
    });
  }

  // `model/list` (Codex 0.167 shape): options.models lists native slugs, the first is the default; pages are
  // options.modelPageSize long (else the request limit), the cursor is the next offset as a string.
  function listModels({ id, params }) {
    const models = options.models ?? ['fake-model', 'gpt-test-mini'];
    const offset = Number(params.cursor ?? 0);
    const end = offset + (options.modelPageSize ?? params.limit ?? 100);
    reply(id, {
      data: models.slice(offset, end).map((model, index) => ({
        id: model, model, displayName: `Fake ${model}`, description: '', hidden: false, upgrade: null,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: (options.reasoningEfforts ?? ['minimal', 'low', 'medium', 'high', 'xhigh'])
          .map(reasoningEffort => ({ reasoningEffort, description: 'fake' })),
        inputModalities: ['text', 'image'], supportsPersonality: false, isDefault: offset + index === 0,
      })),
      nextCursor: end < models.length ? String(end) : null,
    });
  }

  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    record({ message });
    const { id, method, params = {} } = message;
    if (method === undefined) {
      serverRequests.get(id)?.();
      serverRequests.delete(id);
      return;
    }
    if (method === 'initialize') {
      optOut = new Set(params.capabilities?.optOutNotificationMethods ?? []);
      reply(id, { userAgent: 'fake-codex/0.167.2', codexHome: home, platformFamily: 'unix', platformOs: 'linux' });
      return;
    }
    if (method === 'initialized') {
      initialized = true;
      return;
    }
    if (id === undefined) return;
    if (!initialized) {
      refuse(id, 'Not initialized');
      return;
    }
    if (method === 'model/list') {
      listModels(message);
      return;
    }
    if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork') {
      openThread(message);
      return;
    }
    const thread = store.threads[params.threadId];
    if (!thread) {
      refuse(id, `thread not found: ${params.threadId}`);
      return;
    }
    if (method === 'thread/turns/list') {
      if (options.hangTurnsList) return; // never answered: the client's read times out
      if (options.failTurnsList) {
        refuse(id, 'turn history unavailable');
        return;
      }
      listTurns(message, thread);
      return;
    }
    if (method === 'thread/items/list') {
      const entries = thread.turns.filter(turn => !params.turnId || turn.id === params.turnId)
        .flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item, startedAtMs: 1, completedAtMs: 2 })));
      const offset = Number(params.cursor ?? 0);
      const end = offset + (params.limit ?? 25);
      reply(id, { data: entries.slice(offset, end), nextCursor: end < entries.length ? String(end) : null, backwardsCursor: null });
      return;
    }
    if (method === 'thread/read') {
      // Paginated history: turns are never hydrated here.
      reply(id, { thread: threadView(thread) });
      return;
    }
    if (!loaded.has(thread.id)) {
      refuse(id, `thread not loaded: ${thread.id}`);
      return;
    }
    if (method === 'thread/compact/start') {
      if (options.compactError) { refuse(id, String(options.compactError), -32603); return; }
      if (running.has(thread.id)) { refuse(id, 'thread already has an active turn'); return; }
      const compactTurn = { id: `turn-${++store.nextTurn}`, status: 'inProgress', items: [], error: null };
      thread.turns.push(compactTurn);
      running.set(thread.id, compactTurn);
      save();
      reply(id, {});
      later(options.compactStartDelay ?? 0, () => notify('turn/started', { threadId: thread.id, turn: turnView(compactTurn) }));
      const entry = { type: 'contextCompaction', id: `${compactTurn.id}-compact` };
      later(options.compactStartDelay ?? 0, () => notify('item/started', { threadId: thread.id, turnId: compactTurn.id, item: entry }));
      later((options.compactStartDelay ?? 0) + (options.compactDelay ?? 50), () => {
        if (compactTurn.status !== 'inProgress') return;
        compactTurn.items.push(entry);
        if (options.compactUsage) {
          const total = thread.tokenUsage?.total ?? { inputTokens: 0, cachedInputTokens: 0,
            outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
          thread.tokenUsage = { total, last: { inputTokens: 0, cachedInputTokens: 0,
            outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 25863 }, modelContextWindow: 200000 };
          notify('thread/tokenUsage/updated', { threadId: thread.id, turnId: compactTurn.id, tokenUsage: thread.tokenUsage });
        }
        notify('item/completed', { threadId: thread.id, turnId: compactTurn.id, item: entry });
        complete(thread, compactTurn, 'completed', null);
      });
      return;
    }
    const turn = running.get(thread.id);
    const text = (params.input ?? []).filter(entry => entry.type === 'text').map(entry => entry.text).join('\n\n');
    if (method === 'turn/start') {
      startTurn(message, thread);
    } else if (method === 'turn/steer') {
      if (turn && text === 'late-steer') {
        complete(thread, turn);
        refuse(id, 'no active turn to steer');
      } else if (!turn || params.expectedTurnId !== turn.id) {
        refuse(id, 'expectedTurnId does not match the active turn', -32602);
      } else if (text === 'steer-lost') {
        // Accepted, but the response outlives the client's RPC timeout; the turn stays active meanwhile.
        later(1500, () => { reply(id, { turnId: turn.id }); complete(thread, turn); });
      } else if (options.steerHolds) {
        // Accepted into the active turn, which keeps running (until interrupted).
        reply(id, { turnId: turn.id });
      } else {
        reply(id, { turnId: turn.id });
        complete(thread, turn, 'completed', `done: ${turn.prompt} | steered: ${text}`);
      }
    } else if (method === 'turn/interrupt') {
      if (!turn || params.turnId !== turn.id) {
        refuse(id, 'turnId does not match the active turn', -32602);
      } else if (options.interruptLateQuestions) {
        const remaining = new Set([903, 904]);
        for (const requestId of remaining) serverRequests.set(requestId, () => {
          remaining.delete(requestId);
          if (!remaining.size) { reply(id, {}); complete(thread, turn, 'interrupted', null); }
        });
        send({ id: 903, method: 'item/tool/requestUserInput', params: {
          threadId: thread.id, turnId: turn.id, itemId: 'late-question', isBlocking: true,
          questions: [{ id: 'late', header: 'Late', question: 'Late question?', isOther: true, isSecret: false, options: null }],
        } });
        send({ id: 904, method: 'mcpServer/elicitation/request', params: {
          threadId: thread.id, turnId: turn.id, serverName: 'fixture', mode: 'form',
          message: 'Late form?', requestedSchema: { type: 'object', properties: {} },
        } });
        item(thread, turn, { ...agentMessage(`${turn.id}-late-async`, 'Late async?'),
          phase: 'commentary', delivery: 'async', questions: [{ title: 'Late async?' }] });
      } else if (options.loseInterrupt) {
        later(options.loseInterrupt, () => { reply(id, {}); complete(thread, turn, 'interrupted', null); });
      } else {
        reply(id, {});
        if (options.interruptCompletionDelay) later(options.interruptCompletionDelay, () => complete(thread, turn, 'interrupted', null));
        else complete(thread, turn, 'interrupted', null);
      }
    } else {
      refuse(id, `unexpected method ${method}`, -32601);
    }
  });
}

function makeClient(t, options = {}, clientOptions = {}, store) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-bridge-test-'));
  writeFileSync(join(dir, 'options.json'), JSON.stringify(options));
  if (store) writeFileSync(join(dir, 'store.json'), JSON.stringify(store));
  const client = new CodexNativeClient({
    command: [process.execPath, fileURLToPath(import.meta.url), FAKE_FLAG],
    timeoutMs: 3000,
    ...clientOptions,
    env: { CODEX_HOME: dir, ...clientOptions.env },
  });
  t.after(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { client, dir };
}

function trace(dir) {
  const path = join(dir, 'trace.jsonl');
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  // Only complete lines: a fake process may be appending concurrently.
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
const sent = (dir, method) => trace(dir).filter(({ message }) => message?.method === method).map(({ message }) => message.params);
const prompts = (dir) => sent(dir, 'turn/start').map(({ input }) => input[0].text);
const mutations = (dir) => trace(dir).filter(({ message }) => MUTATIONS.has(message?.method)).map(({ message }) => message);
const spawnedPids = (dir) => trace(dir).filter(({ spawn }) => spawn).map(({ pid }) => pid);

const savedTurn = (id, status, text, error = null) => ({
  id, prompt: '', status, error,
  items: text === undefined ? [] : [{
    type: 'agentMessage', id: `${id}-answer`, text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null,
  }],
});
const savedStore = (threads) => ({
  nextThread: 0, nextTurn: 100, threads: Object.fromEntries(threads.map(([id, turns]) => [id, { id, cwd, turns }])),
});

async function until(probe, describe = () => '') {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`Condition timed out ${describe()}`);
    await delay(5);
  }
}

function untilSnapshot(client, threadId, predicate) {
  return until(() => {
    const snapshot = client.snapshot(threadId);
    return snapshot && predicate(snapshot) ? snapshot : undefined;
  }, () => JSON.stringify(client.snapshot(threadId))?.slice(0, 2000));
}

const completed = ({ status }) => status === 'completed';
const unknownOutcome = (threadId) => (error) => {
  assert.equal(error.outcomeUnknown, true, error.message);
  assert.equal(error.threadId, threadId);
  return true;
};

it('coalesces connection and continues completed turns in the same native thread', async (t) => {
  const { client, dir } = makeClient(t);
  await Promise.all([client.connect(), client.connect(), client.connect()]);
  assert.equal(spawnedPids(dir).length, 1);
  const first = await client.run({ prompt: 'first', cwd });
  await untilSnapshot(client, first.threadId, completed);
  const second = await client.run({ threadId: first.threadId, prompt: 'second', cwd });
  assert.equal(second.threadId, first.threadId);
  const done = await untilSnapshot(client, first.threadId, (value) => completed(value) && value.turnId === second.turnId);
  assert.equal(done.text, 'done: second');
  assert.deepEqual(mutations(dir).map(({ method }) => method), ['thread/start', 'turn/start', 'turn/start']);
  assert.deepEqual(sent(dir, 'turn/start').map(({ threadId, input }) => [threadId, input]), [
    [first.threadId, [{ type: 'text', text: 'first' }]],
    [first.threadId, [{ type: 'text', text: 'second' }]],
  ]);
  const [start] = sent(dir, 'thread/start');
  assert.equal(start.sandbox, 'workspace-write');
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.cwd, cwd);
});

it('resumes a saved thread with explicit restrictive controls and no history', async (t) => {
  const { client, dir } = makeClient(t, {}, {}, savedStore([['persisted-thread', [savedTurn('turn-old', 'completed', 'old answer')]]]));
  const admitted = await client.run({ threadId: 'persisted-thread', prompt: 'resume', cwd });
  const done = await untilSnapshot(client, admitted.threadId, (value) => completed(value) && value.turnId === admitted.turnId);
  assert.equal(done.text, 'done: resume');
  assert.deepEqual(mutations(dir).map(({ method }) => method), ['thread/resume', 'turn/start']);
  const [resume] = sent(dir, 'thread/resume');
  assert.equal(resume.threadId, 'persisted-thread');
  assert.equal(resume.excludeTurns, true);
  assert.equal(resume.approvalPolicy, 'never');
  assert.equal(resume.sandbox, 'workspace-write');
  assert.equal(resume.cwd, cwd);
});

it('lists native models across model/list pages without mutating anything', async (t) => {
  // Case and punctuation are kept exactly as Codex reports them.
  const models = ['fake-model', 'GPT-Test.Mini_2', 'gpt-6-astra', 'o9-pro-2026', 'tiny'];
  const { client, dir } = makeClient(t, { models, modelPageSize: 2 });
  const listed = await client.listModels();
  assert.deepEqual(listed.map(({ model }) => model), models);
  assert.deepEqual(listed.map(({ isDefault }) => isDefault), [true, false, false, false, false]);
  assert.deepEqual(sent(dir, 'model/list').map(({ cursor }) => cursor), [undefined, '2', '4']);
  assert.deepEqual(mutations(dir), []);
});

it('sends an explicit native model on thread/start, thread/resume and turn/start, and omits it for the default', async (t) => {
  const { client, dir } = makeClient(t, {}, {}, savedStore([['persisted-thread', [savedTurn('turn-old', 'completed', 'old answer')]]]));
  const chosen = await client.run({ prompt: 'chosen', cwd, model: 'GPT-Test.Mini_2' });
  await untilSnapshot(client, chosen.threadId, completed);
  assert.equal(client.snapshot(chosen.threadId).model, 'GPT-Test.Mini_2');
  const resumed = await client.run({ threadId: 'persisted-thread', prompt: 'resumed', cwd, model: 'GPT-Test.Mini_2' });
  await untilSnapshot(client, resumed.threadId, completed);
  const fallback = await client.run({ prompt: 'default', cwd });
  await untilSnapshot(client, fallback.threadId, completed);
  const [startChosen, startDefault] = sent(dir, 'thread/start');
  const [resume] = sent(dir, 'thread/resume');
  const [turnChosen, turnResumed, turnDefault] = sent(dir, 'turn/start');
  assert.equal(startChosen.model, 'GPT-Test.Mini_2');
  assert.equal(resume.model, 'GPT-Test.Mini_2');
  assert.equal(resume.sandbox, 'workspace-write');
  assert.equal(turnChosen.model, 'GPT-Test.Mini_2');
  assert.equal(turnResumed.model, 'GPT-Test.Mini_2');
  assert.ok(!('model' in startDefault), 'default model is left to the Codex config');
  assert.ok(!('model' in turnDefault), 'default model is left to the Codex config');
});

it('refuses a thread whose reported native model differs from the requested one, without a turn', async (t) => {
  const { client, dir } = makeClient(t, { permissions: { model: 'rerouted-model' } });
  await assert.rejects(client.run({ prompt: 'must not run', cwd, model: 'gpt-test-mini' }), (error) => {
    assert.equal(error.code, 'MODEL_MISMATCH');
    assert.match(error.message, /Codex reported model/);
    assert.equal(typeof error.threadId, 'string');
    return true;
  });
  assert.deepEqual(prompts(dir), []);
});

it('always sends the fixed no-network workspace-write policy and accepts the native workspace-write default', async (t) => {
  const { client, dir } = makeClient(t);
  // The fake reports the real default for workspace-write: no roots listed and /tmp writable.
  const writable = await client.run({ prompt: 'write', cwd });
  await untilSnapshot(client, writable.threadId, completed);
  assert.deepEqual(sent(dir, 'thread/start').map(({ sandbox, approvalPolicy }) => [sandbox, approvalPolicy]), [['workspace-write', 'never']]);
  const [write] = sent(dir, 'turn/start');
  assert.equal(write.approvalPolicy, 'never');
  assert.deepEqual(write.sandboxPolicy, {
    type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true,
  });
  // The sandbox is not a caller choice: any explicit value, narrower or wider, is refused before a request.
  for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access']) {
    await assert.rejects(client.run({ prompt: `must not run ${sandbox}`, cwd, sandbox }), /sandbox is not configurable/);
  }
  assert.equal(sent(dir, 'thread/start').length, 1);
  assert.equal(prompts(dir).length, 1);
});

it('fails closed when the native thread reports wider or unidentifiable permissions', async (t) => {
  const elsewhere = join(cwd, 'elsewhere');
  const writable = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  const granular = { granular: { sandbox_approval: true, rules: true, skill_approval: true, request_permissions: true, mcp_elicitations: true } };
  const cases = [
    { approvalPolicy: 'on-request' },
    { approvalPolicy: granular },
    { approvalPolicy: null },
    { sandbox: { type: 'dangerFullAccess' } },
    { sandbox: { type: 'externalSandbox', networkAccess: 'enabled' } },
    { sandbox: { type: 'readOnly', networkAccess: true } },
    { sandbox: null },
    { sandbox: { ...writable, networkAccess: true } },
    { sandbox: { ...writable, writableRoots: [cwd, elsewhere] } },
    { sandbox: { ...writable, writableRoots: ['/tmp'] } },
    { cwd: elsewhere },
    { cwd: null },
  ];
  for (const permissions of cases) {
    const label = JSON.stringify(permissions);
    const { client, dir } = makeClient(t, { permissions });
    await assert.rejects(client.run({ prompt: 'must not run', cwd }), (error) => {
      assert.equal(error.code, 'PERMISSION_UNSAFE', label);
      assert.notEqual(error.outcomeUnknown, true, label);
      return true;
    });
    assert.deepEqual(prompts(dir), [], label);
    await client.close();
  }
  // A refused resume is not reused as an attachment: a retry is refused again.
  const { client, dir } = makeClient(t, { permissions: { approvalPolicy: 'on-request' } }, {}, savedStore([['persisted-thread', []]]));
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(client.run({ threadId: 'persisted-thread', prompt: 'must not run', cwd }), (error) => {
      assert.equal(error.code, 'PERMISSION_UNSAFE');
      assert.equal(error.threadId, 'persisted-thread');
      return true;
    });
  }
  assert.deepEqual(prompts(dir), []);
});

it('refuses a stricter native sandbox instead of running under an unrequested policy', async (t) => {
  const { client, dir } = makeClient(t, { permissions: { sandbox: { type: 'readOnly', networkAccess: false } } });
  await assert.rejects(client.run({ prompt: 'must not run', cwd }), (error) => {
    assert.equal(error.code, 'PERMISSION_STRICTER');
    assert.equal(typeof error.threadId, 'string');
    return true;
  });
  assert.deepEqual(prompts(dir), []);
});

it('reads the saved last turn of an unloaded thread without mutating or owning it', async (t) => {
  const { client, dir } = makeClient(t, {}, {}, savedStore([
    ['saved-thread', [
      savedTurn('turn-a', 'completed', 'oldest answer'),
      savedTurn('turn-b', 'completed', 'older answer'),
      savedTurn('turn-c', 'completed', 'latest answer'),
    ]],
    ['failed-thread', [savedTurn('turn-f', 'failed', undefined, {
      message: 'usage limit reached', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null,
    })]],
  ]));
  const saved = await client.status('saved-thread');
  assert.equal(saved.threadId, 'saved-thread');
  assert.equal(saved.turnId, 'turn-c');
  assert.equal(saved.status, 'completed');
  assert.equal(saved.text, 'latest answer');
  const failed = await client.status('failed-thread');
  assert.equal(failed.status, 'failed');
  assert.match(String(failed.error), /usage limit reached/);
  await assert.rejects(client.status('missing-thread'), /not found/);
  const reads = sent(dir, 'thread/turns/list');
  assert.deepEqual(reads.map(({ threadId }) => threadId), ['saved-thread', 'failed-thread', 'missing-thread']);
  for (const read of reads) {
    assert.equal(read.limit, 1);
    assert.equal(read.sortDirection, 'desc');
    assert.equal(read.itemsView, 'notLoaded');
  }
  assert.deepEqual(mutations(dir), []);
  assert.equal(client.snapshot('saved-thread'), undefined);
  assert.deepEqual(await client.status(), []);
  // The read did not attach the thread: continuing it still resumes first.
  await client.run({ threadId: 'saved-thread', prompt: 'continue', cwd });
  assert.deepEqual(mutations(dir).map(({ method }) => method), ['thread/resume', 'turn/start']);
});

it('steers an active turn with its expected turn ID', async (t) => {
  const { client, dir } = makeClient(t);
  const first = await client.run({ prompt: 'hold', cwd });
  assert.equal(first.status, 'inProgress');
  await client.run({ threadId: first.threadId, prompt: 'follow-up', cwd });
  await untilSnapshot(client, first.threadId, completed);
  assert.deepEqual(mutations(dir).map(({ method }) => method), ['thread/start', 'turn/start', 'turn/steer']);
  const [steer] = sent(dir, 'turn/steer');
  assert.equal(steer.expectedTurnId, first.turnId);
  assert.deepEqual(steer.input, [{ type: 'text', text: 'follow-up' }]);
});

it('keeps a successful completion when a late steer is rejected', async (t) => {
  const { client } = makeClient(t);
  const active = await client.run({ prompt: 'hold', cwd });
  await assert.rejects(client.run({ threadId: active.threadId, prompt: 'late-steer', cwd }), (error) => {
    assert.match(error.message, /no active turn/);
    assert.equal(error.threadId, active.threadId);
    return true;
  });
  const after = client.snapshot(active.threadId);
  assert.equal(after.status, 'completed');
  assert.equal(after.text, 'done: hold');
  assert.equal(after.error, null);
  assert.equal(after.outcomeUnknown, false);
});

it('keeps a timed-out steer unknown while native history shows the same turn active', async (t) => {
  const { client, dir } = makeClient(t, {}, { timeoutMs: 600 });
  const active = await client.run({ prompt: 'hold', cwd });
  await assert.rejects(client.run({ threadId: active.threadId, prompt: 'steer-lost', cwd }), (error) => {
    assert.equal(error.code, 'RPC_TIMEOUT');
    return unknownOutcome(active.threadId)(error);
  });
  const inspected = await client.status(active.threadId);
  assert.equal(inspected.status, 'inProgress');
  assert.equal(inspected.outcomeUnknown, true);
  await assert.rejects(client.run({ threadId: active.threadId, prompt: 'second steer', cwd }), unknownOutcome(active.threadId));
  await assert.rejects(client.cancel(active.threadId), unknownOutcome(active.threadId));
  assert.equal(sent(dir, 'turn/steer').length, 1);
  assert.equal(sent(dir, 'turn/interrupt').length, 0);
  // Only the matching late response or the turn's end settles it.
  const done = await untilSnapshot(client, active.threadId, (value) => completed(value) && !value.outcomeUnknown);
  assert.equal(done.error, null);
  assert.deepEqual(prompts(dir), ['hold']);
});

it('keeps a timed-out interrupt unknown while native history shows the same turn active', async (t) => {
  const { client, dir } = makeClient(t, { loseInterrupt: 1500 }, { timeoutMs: 600 });
  const active = await client.run({ prompt: 'hold', cwd });
  await assert.rejects(client.cancel(active.threadId), (error) => {
    assert.equal(error.code, 'RPC_TIMEOUT');
    return unknownOutcome(active.threadId)(error);
  });
  const inspected = await client.status(active.threadId);
  assert.equal(inspected.status, 'inProgress');
  assert.equal(inspected.outcomeUnknown, true);
  await assert.rejects(client.cancel(active.threadId), unknownOutcome(active.threadId));
  await assert.rejects(client.run({ threadId: active.threadId, prompt: 'steer after lost interrupt', cwd }), unknownOutcome(active.threadId));
  assert.equal(sent(dir, 'turn/interrupt').length, 1);
  assert.equal(sent(dir, 'turn/steer').length, 0);
  await untilSnapshot(client, active.threadId, ({ status, outcomeUnknown }) => status === 'interrupted' && !outcomeUnknown);
});

it('leaves no stuck turn after a rejected admission and allows an explicit retry', async (t) => {
  const { client, dir } = makeClient(t);
  const events = [];
  client.subscribe((event) => events.push(event));
  let threadId;
  await assert.rejects(client.run({ prompt: 'reject', cwd }), (error) => {
    assert.match(error.message, /turn rejected/);
    assert.notEqual(error.outcomeUnknown, true);
    threadId = error.threadId;
    return true;
  });
  assert.equal(typeof threadId, 'string');
  const state = client.snapshot(threadId);
  assert.notEqual(state.status, 'inProgress');
  assert.equal(state.outcomeUnknown, false);
  // The rejection itself is the report; no terminal notification repeats it.
  assert.ok(!events.some(({ status }) => status === 'failed'), JSON.stringify(events));
  const retry = await client.run({ threadId, prompt: 'retry', cwd });
  const done = await untilSnapshot(client, threadId, (value) => completed(value) && value.turnId === retry.turnId);
  assert.equal(done.text, 'done: retry');
  assert.deepEqual(prompts(dir), ['reject', 'retry']);
});

it('retains events that arrive before resume and turn admission responses', async (t) => {
  const { client } = makeClient(t, { earlyThread: true }, {}, savedStore([['persisted-thread', []]]));
  const resumed = await client.run({ threadId: 'persisted-thread', prompt: 'early', cwd });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.text, 'early answer');
  const methods = client.snapshot('persisted-thread').events.map(({ method }) => method);
  for (const method of ['thread/started', 'turn/started', 'item/started', 'item/completed', 'turn/completed']) {
    assert.ok(methods.includes(method), `${method} missing from ${methods}`);
  }
  const fresh = await client.run({ prompt: 'early', cwd });
  assert.equal(fresh.status, 'completed');
  assert.equal(fresh.text, 'early answer');
  // Foreign threads announced while start/resume were pending are never adopted.
  assert.equal(client.snapshot('foreign-thread'), undefined);
  assert.deepEqual(client.snapshot().map(({ threadId }) => threadId).sort(), [fresh.threadId, 'persisted-thread'].sort());
});

it('ignores notifications for threads this client does not own', async (t) => {
  const { client } = makeClient(t);
  const events = [];
  client.subscribe((event) => events.push(event));
  const admitted = await client.run({ prompt: 'child', cwd });
  const done = await untilSnapshot(client, admitted.threadId, completed);
  assert.equal(done.text, 'done: child');
  assert.equal(client.snapshot('child-thread'), undefined);
  assert.deepEqual((await client.status()).map(({ threadId }) => threadId), [admitted.threadId]);
  assert.ok(events.length > 0);
  assert.ok(events.every(({ threadId }) => threadId === admitted.threadId), JSON.stringify(events));
});

it('notifies subscribers with lightweight state changes only', async (t) => {
  const { client } = makeClient(t);
  const events = [];
  client.subscribe(() => { throw new Error('listener failure'); });
  client.subscribe(async () => { throw new Error('async listener failure'); });
  const unsubscribe = client.subscribe((event) => events.push(event));
  // 80 item notifications and a repeated turn/completed are not state changes.
  const admitted = await client.run({ prompt: 'big', cwd });
  await untilSnapshot(client, admitted.threadId, completed);
  assert.ok(events.length > 0);
  for (const event of events) assert.deepEqual(Object.keys(event).sort(), ['status', 'threadId', 'turnId']);
  assert.equal(new Set(events.map((event) => JSON.stringify(event))).size, events.length, JSON.stringify(events));
  assert.deepEqual(events.at(-1), { threadId: admitted.threadId, turnId: admitted.turnId, status: 'completed' });
  const count = events.length;
  unsubscribe();
  const next = await client.run({ threadId: admitted.threadId, prompt: 'after unsubscribe', cwd });
  await untilSnapshot(client, admitted.threadId, (value) => completed(value) && value.turnId === next.turnId);
  assert.equal(events.length, count);
});

it('opts out of message deltas and keeps the final message with bounded meaningful events', async (t) => {
  const { client, dir } = makeClient(t);
  const admitted = await client.run({ prompt: 'big', cwd });
  const done = await untilSnapshot(client, admitted.threadId, completed);
  const [initialize] = sent(dir, 'initialize');
  assert.equal(initialize.clientInfo.name, 'omp_codex_bridge');
  assert.ok(initialize.capabilities.optOutNotificationMethods.includes('item/agentMessage/delta'));
  assert.equal(done.text, BIG_TEXT);
  assert.equal(done.textTruncated, false);
  assert.ok(done.events.length > 0 && done.events.length <= 50);
  const methods = done.events.map(({ method }) => method);
  assert.ok(!methods.includes('item/agentMessage/delta'));
  assert.ok(methods.includes('turn/completed'));
  assert.ok(done.events.some(({ method, params }) => method === 'item/completed' && params.item?.type === 'agentMessage'));
  for (const event of done.events) assert.ok(JSON.stringify(event).length < 20000, 'event payload was not bounded');
  done.text = 'changed by caller';
  done.events[0].params.callerMutation = true;
  done.events.length = 0;
  const all = client.snapshot();
  all[0].text = 'changed through list';
  all[0].events[0].params.callerMutation = true;
  all.length = 0;
  const untouched = client.snapshot(admitted.threadId);
  assert.equal(untouched.text, BIG_TEXT);
  assert.ok(untouched.events.length > 0);
  assert.equal(untouched.events[0].params.callerMutation, undefined);
  assert.equal(client.snapshot().length, 1);
});

it('interrupts the native active turn', async (t) => {
  const { client, dir } = makeClient(t);
  const active = await client.run({ prompt: 'hold', cwd });
  await client.cancel(active.threadId);
  await untilSnapshot(client, active.threadId, ({ status }) => status === 'interrupted');
  const [interrupt] = sent(dir, 'turn/interrupt');
  assert.equal(interrupt.threadId, active.threadId);
  assert.equal(interrupt.turnId, active.turnId);
});

it('surfaces native turn failures and their error', async (t) => {
  const { client } = makeClient(t);
  const admitted = await client.run({ prompt: 'fail', cwd });
  const failed = await untilSnapshot(client, admitted.threadId, ({ status }) => status === 'failed');
  assert.match(String(failed.error), /quota exhausted/);
});

it('does not duplicate a mutation after its admission response times out', async (t) => {
  const timeoutMs = 500;
  const { client, dir } = makeClient(t, { dropTurnReply: timeoutMs * 3 }, { timeoutMs });
  await client.connect();
  let threadId;
  await assert.rejects(client.run({ prompt: 'hold', cwd }), (error) => {
    assert.equal(error.code, 'RPC_TIMEOUT');
    assert.equal(error.outcomeUnknown, true);
    assert.match(error.message, /outcome unknown/i);
    threadId = error.threadId;
    return true;
  });
  assert.equal(typeof threadId, 'string');
  assert.equal(client.snapshot(threadId).status, 'inProgress');
  assert.equal(client.snapshot(threadId).outcomeUnknown, true);
  // A caller retry must be blocked or steer the known active turn, never start another.
  try {
    await client.run({ threadId, prompt: 'caller retry', cwd });
  } catch (error) {
    assert.match(error.message, /unknown|progress|active|reconcil|timeout/i);
  }
  const done = await untilSnapshot(client, threadId, completed);
  assert.deepEqual(prompts(dir), ['hold']);
  assert.equal(done.outcomeUnknown, false);
  assert.equal(done.error, null);
});

it('lists a late thread/start response as an orphan without starting a turn', async (t) => {
  const { client, dir } = makeClient(t, { startDelay: 1500 }, { timeoutMs: 500 });
  await client.connect();
  await assert.rejects(client.run({ prompt: 'orphan', cwd }), (error) => {
    assert.equal(error.code, 'RPC_TIMEOUT');
    assert.equal(error.outcomeUnknown, true);
    return true;
  });
  const [orphan, ...others] = await until(async () => {
    const listed = await client.status();
    return listed.length ? listed : undefined;
  });
  assert.deepEqual(others, []);
  assert.equal(orphan.threadId, 'thread-1');
  // The late response confirms the thread exists; its explanation marks it as never used.
  assert.equal(orphan.outcomeUnknown, false);
  assert.equal(orphan.turnId, null);
  assert.match(String(orphan.error), /timeout/i);
  await delay(200);
  assert.equal(sent(dir, 'thread/start').length, 1);
  assert.deepEqual(prompts(dir), []);
});

it('rejects all pending RPCs when the native process exits', async (t) => {
  const { client } = makeClient(t, { exitOnStart: true }, { timeoutMs: 10000 });
  await client.connect();
  const results = await Promise.race([
    Promise.allSettled([client.run({ prompt: 'one', cwd }), client.run({ prompt: 'two', cwd })]),
    delay(2000, 'unresolved', { ref: false }),
  ]);
  assert.notEqual(results, 'unresolved', 'process exit left pending RPCs unresolved');
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /exit|closed|disconnect|terminated/i);
  }
});

it('reconnects once after a crash and continues only on explicit calls', async (t) => {
  const { client, dir } = makeClient(t);
  const first = await client.run({ prompt: 'first', cwd });
  await untilSnapshot(client, first.threadId, completed);
  const crashed = await client.run({ prompt: 'crash-later', cwd });
  await untilSnapshot(client, crashed.threadId, ({ status }) => status === 'disconnected');
  await delay(100);
  assert.equal(spawnedPids(dir).length, 1, 'a crash alone must not respawn or re-run work');
  await Promise.all([client.connect(), client.connect(), client.connect()]);
  const pids = spawnedPids(dir);
  assert.equal(pids.length, 2);
  assert.notEqual((await client.status(crashed.threadId)).status, 'completed');
  const continued = await client.run({ threadId: first.threadId, prompt: 'second', cwd });
  const done = await untilSnapshot(client, first.threadId, (value) => completed(value) && value.turnId === continued.turnId);
  assert.equal(done.text, 'done: second');
  assert.equal(spawnedPids(dir).length, 2);
  assert.deepEqual(prompts(dir), ['first', 'crash-later', 'second']);
  const replayed = trace(dir).filter(({ pid, message }) => pid === pids[1] && MUTATIONS.has(message?.method));
  assert.deepEqual(replayed.map(({ message }) => [message.method, message.params.threadId]), [
    ['thread/resume', first.threadId], ['turn/start', first.threadId],
  ]);
  await client.close();
  await assert.rejects(client.connect(), /closed/);
});

it('does not take a restarted server as proof that interrupted work finished', async (t) => {
  // The restarted server still has the dead process's turn recorded as in progress.
  const { client, dir } = makeClient(t, { staleTurns: true });
  const crashed = await client.run({ prompt: 'crash-later', cwd });
  await untilSnapshot(client, crashed.threadId, ({ status }) => status === 'disconnected');
  const inspected = await client.status(crashed.threadId);
  assert.equal(inspected.status, 'disconnected');
  assert.equal(inspected.outcomeUnknown, true);
  await assert.rejects(client.run({ threadId: crashed.threadId, prompt: 'explicit retry', cwd }), unknownOutcome(crashed.threadId));
  await assert.rejects(client.cancel(crashed.threadId), unknownOutcome(crashed.threadId));
  assert.deepEqual(prompts(dir), ['crash-later']);
  assert.deepEqual(mutations(dir).map(({ method }) => method), ['thread/start', 'turn/start']);
  assert.equal(spawnedPids(dir).length, 2);
});

it('keeps an uncertain mutation blocked across reconnection', async (t) => {
  const { client, dir } = makeClient(t);
  const first = await client.run({ prompt: 'first', cwd });
  await untilSnapshot(client, first.threadId, completed);
  // The process dies after receiving turn/start and before answering it.
  await assert.rejects(client.run({ threadId: first.threadId, prompt: 'crash-now', cwd }), (error) => {
    assert.doesNotMatch(error.message, /STDERR-SECRET/);
    return unknownOutcome(first.threadId)(error);
  });
  const lost = client.snapshot(first.threadId);
  assert.equal(lost.outcomeUnknown, true);
  assert.notEqual(lost.status, 'completed');
  // The restarted server only knows the earlier completed turn; that does not settle the lost turn/start.
  const inspected = await client.status(first.threadId);
  assert.equal(inspected.outcomeUnknown, true);
  assert.notEqual(inspected.status, 'completed');
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(client.run({ threadId: first.threadId, prompt: 'explicit retry', cwd }), unknownOutcome(first.threadId));
  }
  assert.deepEqual(prompts(dir), ['first', 'crash-now']);
  assert.deepEqual(mutations(dir).map(({ method }) => method), ['thread/start', 'turn/start', 'turn/start']);
  assert.equal(spawnedPids(dir).length, 2);
  assert.equal(client.snapshot(first.threadId).outcomeUnknown, true);
});

it('ignores output and exit of a replaced app-server process', async (t) => {
  // The broken process writes invalid JSONL at 20 ms and again at 250 ms, and exits 600 ms after SIGTERM.
  const { client, dir } = makeClient(t, { slowExit: 600 });
  const broken = await client.run({ prompt: 'garbage', cwd });
  await untilSnapshot(client, broken.threadId, ({ status }) => status === 'disconnected');
  await client.connect();
  const active = await client.run({ prompt: 'hold', cwd });
  assert.equal(active.status, 'inProgress');
  await delay(900);
  assert.equal(client.snapshot(active.threadId).status, 'inProgress');
  await client.cancel(active.threadId);
  await untilSnapshot(client, active.threadId, ({ status }) => status === 'interrupted');
  assert.equal(spawnedPids(dir).length, 2);
});

it('decodes UTF-8 split across chunks and several JSONL lines in one chunk', async (t) => {
  const { client } = makeClient(t);
  const admitted = await client.run({ prompt: 'utf8', cwd });
  const done = await untilSnapshot(client, admitted.threadId, completed);
  assert.equal(done.text, UTF8_TEXT);
});

it('bounds JSONL messages at 64 MiB using UTF-8 bytes', async (t) => {
  const { client } = makeClient(t);
  const ascii = await client.run({ prompt: 'ascii-big', cwd });
  const accepted = await untilSnapshot(client, ascii.threadId, completed);
  assert.equal(accepted.textTruncated, true);
  assert.ok(accepted.text.length > 0 && /^a+$/.test(accepted.text));
  const active = await client.run({ prompt: 'hold', cwd });
  // 23 million Hangul characters: under 64 Mi UTF-16 units, above 64 MiB of UTF-8.
  client._consume('가'.repeat(23_000_000));
  const failed = await untilSnapshot(client, active.threadId, ({ status }) => status === 'disconnected');
  assert.match(String(failed.error), /64 MiB/);
});

it('drains app-server stderr without exposing it', async (t) => {
  const { client } = makeClient(t);
  const admitted = await client.run({ prompt: 'stderr', cwd });
  const done = await untilSnapshot(client, admitted.threadId, completed);
  assert.equal(done.text, 'stderr drained');
  assert.doesNotMatch(JSON.stringify(await client.status()), /STDERR-SECRET/);
});

it('does not inherit or forward credential environment variables', async (t) => {
  const previous = process.env.CODEX_TEST_SECRET;
  process.env.CODEX_TEST_SECRET = 'inherited-test-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_TEST_SECRET;
    else process.env.CODEX_TEST_SECRET = previous;
  });
  const { client, dir } = makeClient(t, {}, { env: {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    OPENAI_API_KEY: 'explicit-test-secret',
    AWS_SECRET_ACCESS_KEY: 'explicit-cloud-secret',
    KUBECONFIG: '/tmp/cluster-secret',
  } });
  const admitted = await client.run({ prompt: 'env', cwd });
  const done = await untilSnapshot(client, admitted.threadId, completed);
  const environment = JSON.parse(done.text);
  assert.equal(environment.HOME, process.env.HOME);
  assert.equal(environment.PATH, process.env.PATH);
  assert.equal(environment.CODEX_HOME, dir);
  for (const name of ['OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'KUBECONFIG', 'CODEX_TEST_SECRET']) {
    assert.equal(environment[name], null, `${name} leaked to native process`);
  }
});

it('rejects server approval requests without authorizing execution', async (t) => {
  const { client, dir } = makeClient(t);
  const admitted = await client.run({ prompt: 'approval', cwd });
  await untilSnapshot(client, admitted.threadId, completed);
  const response = trace(dir).find(({ message }) => message?.id === 900 && message.method === undefined)?.message;
  assert.deepEqual(response?.result, { decision: 'decline' });
  assert.equal(response.error, undefined);
});

it('keeps partial/final answers and separates cumulative, last-request and turn usage', async (t) => {
  const { client, dir } = makeClient(t);
  const first = await client.run({ prompt: 'rich-output', cwd });
  const done = await untilSnapshot(client, first.threadId, completed);
  assert.equal(done.text, 'partial answer\n\nfinal answer');
  assert.equal(done.finalText, 'final answer');
  assert.equal(done.tokenUsage.total.totalTokens, 150);
  assert.equal(done.tokenUsage.last.totalTokens, 90);
  assert.equal(done.tokenUsage.modelContextWindow, 200000);
  assert.equal(done.turnUsage.totalTokens, 150);
  const second = await client.run({ threadId: first.threadId, prompt: 'usage', cwd });
  const again = await untilSnapshot(client, first.threadId, value => completed(value) && value.turnId === second.turnId);
  assert.equal(again.tokenUsage.total.totalTokens, 300);
  assert.equal(again.turnUsage.totalTokens, 150);
  assert.equal(again.tokenUsageTurnId, second.turnId);
  again.tokenUsage.last.inputTokens = -1;
  assert.equal(client.snapshot(first.threadId).tokenUsage.last.inputTokens, 80);
  const methods = sent(dir, 'initialize')[0].capabilities.optOutNotificationMethods;
  assert.ok(methods.includes('item/commandExecution/outputDelta'));
  assert.ok(!methods.includes('thread/tokenUsage/updated'));
  assert.ok(!methods.includes('item/completed'));
});

it('does not equate last model request with current-turn usage on a fresh resume', async (t) => {
  const { client } = makeClient(t, {}, {}, savedStore([['saved', [savedTurn('before', 'completed', 'old')]]]));
  const admitted = await client.run({ threadId: 'saved', prompt: 'usage', cwd });
  const done = await untilSnapshot(client, admitted.threadId, completed);
  assert.equal(done.tokenUsage.last.totalTokens, 90);
  assert.equal(done.turnUsage, null);
});

it('passes native images, effort, output schema and developer instructions without fallback', async (t) => {
  const { client, dir } = makeClient(t);
  const input = [
    { type: 'text', text: 'rich-output' },
    { type: 'image', url: 'data:image/png;base64,aGVsbG8=', detail: 'low' },
    { type: 'image', fileId: 'file-example', detail: 'auto' },
    { type: 'localImage', path: join(cwd, 'image.png'), detail: 'original' },
  ];
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const first = await client.run({ input, cwd, effort: 'xhigh', outputSchema: schema, developerInstructions: 'Trusted delegation rules' });
  const done = await untilSnapshot(client, first.threadId, completed);
  assert.equal(done.text, 'partial answer\n\n{"ok":true}');
  assert.equal(done.finalText, '{"ok":true}');
  assert.deepEqual(sent(dir, 'turn/start')[0].input, input);
  assert.equal(sent(dir, 'turn/start')[0].effort, 'xhigh');
  assert.deepEqual(sent(dir, 'turn/start')[0].outputSchema, schema);
  assert.equal(sent(dir, 'thread/start')[0].developerInstructions, 'Trusted delegation rules');
  await assert.rejects(client.run({ threadId: first.threadId, prompt: 'x', developerInstructions: 'changed', cwd }), /immutable developerInstructions/);
  await assert.rejects(client.run({ prompt: 'x', input, cwd }), /prompt or input/);
  await assert.rejects(client.run({ input: [{ type: 'image' }], cwd }), /exactly one/);
  await assert.rejects(client.run({ input: [{ type: 'audio', url: 'x' }], cwd }), /Unsupported native input/);
  await assert.rejects(client.run({ prompt: 'x', outputSchema: { invalid: undefined }, cwd }), /JSON values/);
  await assert.rejects(client.run({ prompt: 'x', effort: 'invalid-native-effort', cwd }), /native effort or output schema validation failed/);
  assert.equal(sent(dir, 'turn/start').length, 2, 'native rejection is not retried with reduced options');
});

it('rejects turn-only settings on a resumed active turn instead of discarding them', async (t) => {
  const { client, dir } = makeClient(t, { staleTurns: true, liveResume: true, earlyThread: true }, {}, savedStore([
    ['active', [savedTurn('running', 'inProgress')]],
  ]));
  for (const settings of [{ effort: 'high' }, { outputSchema: { type: 'object' } }]) {
    await assert.rejects(client.run({ threadId: 'active', prompt: 'x', cwd, ...settings }), /cannot change an active turn/);
  }
  assert.equal(client.snapshot('active').status, 'inProgress');
  assert.equal(sent(dir, 'thread/resume')[0].excludeTurns, true);
  assert.equal(sent(dir, 'turn/start').length, 0);
  assert.equal(sent(dir, 'turn/steer').length, 0);
});

it('forwards async questions without blocking other RPCs and returns native answers', async (t) => {
  let answer;
  let request;
  const { client, dir } = makeClient(t, {}, { onRequest: value => {
    request = value;
    return new Promise(resolve => { answer = resolve; });
  } });
  const admitted = await client.run({ prompt: 'question', cwd });
  await until(() => request);
  assert.equal(request.params.questions[0].id, 'environment');
  assert.equal(request.threadId, admitted.threadId);
  assert.equal(request.turnId, admitted.turnId);
  assert.ok((await client.listModels()).length > 0);
  answer({ answers: { environment: { answers: ['Staging'] } } });
  const done = await untilSnapshot(client, admitted.threadId, completed);
  assert.equal(done.text, 'question answered');
  assert.deepEqual(trace(dir).find(({ message }) => message?.id === 901 && message.result).message.result,
    { answers: { environment: { answers: ['Staging'] } } });
});

it('forwards MCP forms and cancels forms without a host callback', async (t) => {
  for (const withHost of [false, true]) {
    const { client, dir } = makeClient(t, {}, withHost ? { onRequest: async request => {
      assert.equal(request.params.mode, 'form');
      return { action: 'accept', content: { environment: 'Staging' } };
    } } : {});
    const admitted = await client.run({ prompt: 'elicitation', cwd });
    await untilSnapshot(client, admitted.threadId, completed);
    const response = trace(dir).find(({ message }) => message?.id === 902 && message.method === undefined).message;
    assert.deepEqual(response.result, withHost ? { action: 'accept', content: { environment: 'Staging' } } : { action: 'cancel' });
  }
});

it('aborts pending questions on native resolution, turn end, cancel and close without late replies', async (t) => {
  for (const mode of ['question-resolved', 'question-ended', 'cancel', 'close']) {
    let answer;
    let signal;
    const { client, dir } = makeClient(t, {}, { onRequest: request => {
      signal = request.signal;
      return new Promise(resolve => { answer = resolve; });
    } });
    const admitted = await client.run({ prompt: mode.startsWith('question-') ? mode : 'question', cwd });
    await until(() => signal);
    if (mode === 'cancel') await client.cancel(admitted.threadId);
    if (mode === 'close') await client.close();
    await until(() => signal.aborted);
    answer({ answers: { environment: { answers: ['late'] } } });
    await delay(20);
    assert.equal(trace(dir).filter(({ message }) => message?.id === 901 && message.method === undefined).length, 0, mode);
  }
});

it('declines every approval variant with exact schemas and refuses unsupported auth refresh', async (t) => {
  const { client, dir } = makeClient(t);
  const state = await client.run({ prompt: 'hold', cwd });
  const methods = ['item/fileChange/requestApproval', 'item/permissions/requestApproval', 'execCommandApproval',
    'applyPatchApproval', 'account/chatgptAuthTokens/refresh'];
  methods.forEach((method, index) => client._receive({ id: 950 + index, method,
    params: { threadId: state.threadId, turnId: state.turnId } }));
  await until(() => trace(dir).filter(({ message }) => message?.id >= 950 && message.method === undefined).length === methods.length);
  const replies = trace(dir).filter(({ message }) => message?.id >= 950 && message.method === undefined).map(({ message }) => message);
  assert.deepEqual(replies[0].result, { decision: 'decline' });
  assert.deepEqual(replies[1].result, { permissions: {}, scope: 'turn' });
  assert.ok(replies[2].result.decision.denied.rejection);
  assert.ok(replies[3].result.decision.denied.rejection);
  assert.equal(replies[4].error.code, -32601);
});

it('forks through the selected completed native turn with fixed guards and no input replay', async (t) => {
  const { client, dir } = makeClient(t);
  const first = await client.run({ prompt: 'first', cwd, model: 'fake-model' });
  await untilSnapshot(client, first.threadId, completed);
  const second = await client.run({ threadId: first.threadId, prompt: 'second', cwd, model: 'fake-model' });
  await untilSnapshot(client, first.threadId, value => completed(value) && value.turnId === second.turnId);
  const fork = await client.fork({ threadId: first.threadId, lastTurnId: first.turnId, cwd, model: 'fake-model' });
  assert.notEqual(fork.threadId, first.threadId);
  assert.equal(fork.cwd, cwd);
  assert.equal(sent(dir, 'turn/start').length, 2);
  const request = sent(dir, 'thread/fork')[0];
  assert.equal(request.lastTurnId, first.turnId);
  assert.equal(request.excludeTurns, true);
  assert.equal(request.sandbox, 'workspace-write');
  assert.equal(request.approvalPolicy, 'never');
  assert.equal((await client._lastTurn(fork.threadId)).id, first.turnId);
  await client.run({ threadId: fork.threadId, prompt: 'branch only', cwd });
  assert.equal(sent(dir, 'thread/resume').length, 0);
});

it('refuses unsafe effective fork settings before a child turn', async (t) => {
  const { client, dir } = makeClient(t, { permissions: { approvalPolicy: 'on-request' } }, {},
    savedStore([['source', [savedTurn('old', 'completed', 'old')]]]));
  await assert.rejects(client.fork({ threadId: 'source', lastTurnId: 'old', cwd }), error => error.code === 'PERMISSION_UNSAFE');
  assert.equal(sent(dir, 'turn/start').length, 0);
  assert.equal(client.snapshot('source'), undefined);
});

it('waits for compaction lifecycle without a fabricated summary or prompt', async (t) => {
  const { client, dir } = makeClient(t, { compactStartDelay: 50, compactDelay: 100 });
  const first = await client.run({ prompt: 'first', cwd });
  await untilSnapshot(client, first.threadId, completed);
  const done = await client.compact(first.threadId);
  assert.equal(done.status, 'completed');
  assert.notEqual(done.turnId, first.turnId);
  assert.equal(done.text, '');
  assert.equal(done.summary, undefined);
  assert.ok(done.events.some(event => event.method === 'item/completed' && event.params.item.type === 'contextCompaction'));
  assert.equal(sent(dir, 'thread/compact/start').length, 1);
  assert.equal(sent(dir, 'turn/start').length, 1);
  const controller = new AbortController();
  const compacting = client.compact({ threadId: first.threadId, signal: controller.signal });
  await until(() => sent(dir, 'thread/compact/start').length === 2);
  controller.abort();
  await assert.rejects(compacting, error => error.name === 'AbortError');
  await untilSnapshot(client, first.threadId, value => value.status === 'interrupted');
});

it('loads individual history pages without hydrating a complete turn', async (t) => {
  const turn = savedTurn('large-turn', 'completed', 'retained answer');
  turn.items.unshift(...['one', 'two'].map(id => ({ type: 'commandExecution', id, aggregatedOutput: 'x'.repeat(2_500_000) })));
  const { client, dir } = makeClient(t, {}, {}, savedStore([['large-history', [turn]]]));
  const result = await client.status('large-history');
  assert.equal(result.text, 'retained answer');
  assert.equal(sent(dir, 'thread/turns/list')[0].itemsView, 'notLoaded');
  assert.deepEqual(sent(dir, 'thread/items/list').map(({ cursor }) => cursor), [undefined, '1', '2']);
  assert.ok(sent(dir, 'thread/items/list').every(({ limit }) => limit === 1));
});

it('accepts a normal image echo above 4 MiB and suppresses unused large diff notifications', async (t) => {
  const observed = [];
  const { client, dir } = makeClient(t, {}, { onNotification: method => observed.push(method) });
  const url = `data:image/png;base64,${'a'.repeat(5 * 1024 * 1024)}`;
  const input = [{ type: 'text', text: 'image-echo' }, { type: 'image', url }];
  const admitted = await client.run({ input, cwd });
  const done = await untilSnapshot(client, admitted.threadId, completed);
  assert.equal(done.text, 'image received');
  assert.equal(sent(dir, 'turn/start')[0].input[1].url, url);
  assert.ok(!observed.includes('turn/diff/updated'));
  assert.ok(sent(dir, 'initialize')[0].capabilities.optOutNotificationMethods.includes('turn/diff/updated'));
  assert.ok(JSON.stringify(done.events).length < 100000, 'image echo must not persist a giant event');
});

it('steers accepted live async questions with official reply envelope and never re-asks history', async (t) => {
  let asked = 0;
  let questionId;
  const { client, dir } = makeClient(t, {}, { onRequest: async request => {
    asked++;
    assert.equal(request.params.delivery, 'async');
    assert.equal(request.params.isBlocking, false);
    questionId = request.params.questions[0].id;
    return { answers: { [questionId]: { answers: ['Staging'] } } };
  } });
  const admitted = await client.run({ prompt: 'async-question', cwd });
  await untilSnapshot(client, admitted.threadId, completed);
  assert.equal(asked, 1, 'duplicate live item completion must not re-open UI');
  assert.equal(questionId, JSON.stringify(['request_user_input_async', `${admitted.turnId}-async`, 0]));
  const steer = sent(dir, 'turn/steer')[0];
  assert.equal(steer.expectedTurnId, admitted.turnId);
  assert.equal(steer.input[0].text,
    `<send_user_message_question_reply>\n${JSON.stringify([{ answer: 'Staging', question: 'Which environment?', questionItemId: questionId }])}\n</send_user_message_question_reply>`);
  await client._lastTurn(admitted.threadId);
  assert.equal(asked, 1);
  assert.equal(trace(dir).filter(({ message }) => typeof message?.id === 'string' && message.id.startsWith('async:')).length, 0);
});

it('drops declined and late async question answers without adding native input', async (t) => {
  for (const late of [false, true]) {
    let answer;
    let request;
    const { client, dir } = makeClient(t, {}, { onRequest: value => {
      request = value;
      return new Promise(resolve => { answer = resolve; });
    } });
    const admitted = await client.run({ prompt: late ? 'async-question-ended' : 'async-question', cwd });
    await until(() => request);
    if (late) await until(() => request.signal.aborted);
    answer({ answers: late ? { [request.params.questions[0].id]: { answers: ['too late'] } } : {} });
    await delay(20);
    assert.equal(sent(dir, 'turn/steer').length, 0);
    if (!late) await client.cancel(admitted.threadId);
  }
});

it('allows owned standalone MCP forms without requiring an active native turn', async (t) => {
  let seen;
  const { client, dir } = makeClient(t, {}, { onRequest: async request => {
    seen = request;
    return { action: 'cancel' };
  } });
  const admitted = await client.run({ prompt: 'done', cwd });
  await untilSnapshot(client, admitted.threadId, completed);
  client._receive({ id: 990, method: 'mcpServer/elicitation/request',
    params: { threadId: admitted.threadId, turnId: null, serverName: 'fixture', mode: 'form',
      message: 'Standalone form', requestedSchema: { type: 'object', properties: {} } } });
  await until(() => seen);
  assert.equal(seen.turnId, null);
  await until(() => trace(dir).some(({ message }) => message?.id === 990 && message.result?.action === 'cancel'));
});

it('attaches metadata after readonly reload status and compacts without submitting user input', async (t) => {
  const { client, dir } = makeClient(t, {}, {}, savedStore([['saved', [savedTurn('before', 'completed', 'old answer')]]]));
  assert.equal((await client.status('saved')).status, 'completed');
  assert.equal(client.snapshot('saved'), undefined, 'readonly status must not acquire ownership');
  let attached;
  const options = { threadId: 'saved', cwd, model: 'fake-model', developerInstructions: 'trusted rules',
    onThread: id => { attached = id; } };
  const state = await client.resume(options);
  assert.equal(attached, 'saved');
  assert.equal(state.cwd, cwd);
  assert.equal(state.model, 'fake-model');
  assert.equal(state.status, 'idle');
  assert.equal(state.turnId, null);
  assert.equal(state.text, '', 'metadata resume must not replay history');
  assert.deepEqual(mutations(dir).map(({ method }) => method), ['thread/resume']);
  const request = sent(dir, 'thread/resume')[0];
  assert.equal(request.excludeTurns, true);
  assert.equal(request.approvalPolicy, 'never');
  assert.equal(request.sandbox, 'workspace-write');
  assert.equal(request.model, 'fake-model');
  assert.equal(request.developerInstructions, 'trusted rules');
  await client.resume(options);
  assert.equal(sent(dir, 'thread/resume').length, 1, 'an attached thread is not resumed twice');
  await assert.rejects(client.resume({ ...options, prompt: 'must not be sent' }), /metadata only/);
  const compacted = await client.compact('saved');
  assert.equal(compacted.status, 'completed');
  assert.deepEqual(mutations(dir).map(({ method }) => method), ['thread/resume', 'thread/compact/start']);
});

it('blocks new native questions while an interrupt is pending and allows questions in the next turn', async (t) => {
  const asked = [];
  const { client, dir } = makeClient(t, { interruptLateQuestions: true }, { onRequest: async request => {
    asked.push(request);
    return request.method === 'item/tool/requestUserInput' ? { answers: {} } : { action: 'cancel' };
  } });
  const active = await client.run({ prompt: 'hold', cwd });
  // Fixture admits the interrupt only after both late RPC questions receive their rejection.
  await client.cancel(active.threadId);
  await untilSnapshot(client, active.threadId, value => value.status === 'interrupted');
  assert.deepEqual(asked, [], 'blocking, MCP and async questions must not reopen UI during cancellation');
  for (const id of [903, 904]) {
    const response = trace(dir).find(({ message }) => message?.id === id && message.method === undefined)?.message;
    assert.equal(response?.error?.code, -32600);
    assert.match(response.error.message, /interruption is pending/);
  }
  assert.equal(sent(dir, 'turn/steer').length, 0);
  const next = await client.run({ threadId: active.threadId, prompt: 'question', cwd });
  await untilSnapshot(client, active.threadId, value => completed(value) && value.turnId === next.turnId);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].turnId, next.turnId, 'the previous turn interruption must not suppress new-turn UI');
});

it('separates omitted and null phase final JSON from partial-answer prose', async (t) => {
  for (const prompt of ['unphased-json', 'nullphase-json']) {
    const { client } = makeClient(t);
    const admitted = await client.run({ prompt, cwd });
    const done = await untilSnapshot(client, admitted.threadId, completed);
    assert.equal(done.text, 'partial answer\n\n{"ok":true}');
    assert.equal(done.finalText, '{"ok":true}');
    assert.deepEqual(JSON.parse(done.finalText), { ok: true });
  }
});

it('preserves native compaction context total when last-request token buckets are zero', async (t) => {
  const { client } = makeClient(t, { compactUsage: true });
  const active = await client.run({ prompt: 'usage', cwd });
  const before = await untilSnapshot(client, active.threadId, completed);
  const after = await client.compact(active.threadId);
  assert.deepEqual(after.tokenUsage.total, before.tokenUsage.total);
  assert.equal(after.tokenUsage.last.totalTokens, 25863);
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens']) {
    assert.equal(after.tokenUsage.last[key], 0);
  }
  assert.equal(after.turnUsage.totalTokens, 0, 'context usage must not be counted as new turn usage');
  assert.equal(after.tokenUsage.modelContextWindow, 200000);
});

it('keeps an explicit empty final answer instead of accepting valid partial JSON', async (t) => {
  const { client } = makeClient(t);
  const admitted = await client.run({ prompt: 'explicit-empty-final', cwd });
  const done = await untilSnapshot(client, admitted.threadId, completed);
  assert.equal(done.text.trim(), '{"ok":true}', 'partial output deliberately looks like valid structured output');
  assert.equal(done.finalText, '');
  assert.throws(() => JSON.parse(done.finalText), SyntaxError);
});

it('coalesces concurrent and admitted interrupts until the same native turn ends', async (t) => {
  const { client, dir } = makeClient(t, { interruptCompletionDelay: 100 });
  const active = await client.run({ prompt: 'hold', cwd });
  const [first, second] = await Promise.all([client.cancel(active.threadId), client.cancel(active.threadId)]);
  assert.equal(first.turnId, active.turnId);
  assert.equal(second.turnId, active.turnId);
  await client.cancel(active.threadId);
  assert.equal(sent(dir, 'turn/interrupt').length, 1, 'admission must not permit a duplicate interrupt before turn completion');
  await untilSnapshot(client, active.threadId, value => value.status === 'interrupted');
  const next = await client.run({ threadId: active.threadId, prompt: 'hold', cwd });
  await client.cancel(active.threadId);
  assert.deepEqual(sent(dir, 'turn/interrupt').map(({ turnId }) => turnId), [active.turnId, next.turnId]);
  await untilSnapshot(client, active.threadId, value => value.status === 'interrupted' && value.turnId === next.turnId);
});

if (FAKE_MODE) fakeServer();
