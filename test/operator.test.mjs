// Bun loads the production TypeScript operator; native requests use the shared protocol double.
import assert from 'node:assert/strict';
import { mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zod from 'zod';
import { CodexAppServerClient } from '../src/codex/client.mjs';

// The public host setting reader is a boundary; no real OMP configuration is loaded or written.
let currentScopedSettings;
mock.module('@oh-my-pi/pi-coding-agent/config/registry', () => ({
  lookup: id => ({ get: settings => settings[id] }),
}));
mock.module('@oh-my-pi/pi-coding-agent/config/settings', () => ({
  findScopedSettings: requestedCwd => requestedCwd === cwd ? currentScopedSettings : undefined,
}));
const { registerOperator, errorDetails } = await import('../src/omp/operator.ts');
const { executionCard, createProgressDisplay, summarizeRun } = await import('../src/omp/presentation.ts');
const cwd = realpathSync(process.cwd());
const FAKE = fileURLToPath(new URL('./client.test.mjs', import.meta.url));
const runtime = Bun.which('node') ?? process.execPath;
const MUTATIONS = new Set(['thread/start', 'thread/resume', 'thread/fork', 'thread/compact/start', 'turn/start', 'turn/steer', 'turn/interrupt']);

const saved = {
  nextThread: 2, nextTurn: 2, threads: {
    'saved-one': { id: 'saved-one', cwd, name: 'saved operator first', turns: [{
      id: 'old-turn', status: 'completed', items: [
        { type: 'fileChange', id: 'files', status: 'completed', changes: [
          { path: 'old.ts', kind: { type: 'update', move_path: 'new.ts' }, diff: '@@\n-old\n+new' },
          { path: 'add.ts', kind: { type: 'add' }, diff: '+added' },
          { path: 'delete.ts', kind: { type: 'delete' }, diff: '-deleted' },
        ] },
        { type: 'commandExecution', id: 'failed-command', command: 'fixture command', cwd, status: 'completed', aggregatedOutput: 'failure tail marker', exitCode: 17 },
      ],
    }] },
    'saved-two': { id: 'saved-two', cwd, name: 'saved operator second', turns: [] },
  },
};

async function withOperator(options, body) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-bridge-operator-'));
  writeFileSync(join(dir, 'options.json'), JSON.stringify(options));
  writeFileSync(join(dir, 'store.json'), JSON.stringify(saved));
  const messages = [];
  const execs = [];
  const commands = new Map();
  const clients = [];
  let client;
  const getClient = async () => {
    if (!client) {
      client = new CodexAppServerClient({ command: [runtime, FAKE, '--fake-app-server'], env: { CODEX_HOME: dir } });
      clients.push(client);
    }
    return client;
  };
  const scopedSettings = {
    steeringMode: 'one-at-a-time', 'providers.openaiLiveSteering': false,
    'task.perCallModel': 'on', 'task.perCallModelAllow': ['codex-bridge/gpt-6.1-sol', 'other/private-model'],
    'task.agentModelOverrides': { 'codex-bridge': 'codex-bridge/default', privateAgent: 'PRIVATE-OTHER-AGENT' },
  };
  const pi = {
    zod, pi: { VERSION: 'test-host', settings: {
      steeringMode: 'all', 'providers.openaiLiveSteering': true, 'task.perCallModel': 'off',
      'task.agentModelOverrides': { 'codex-bridge': 'WRONG-GLOBAL-OVERRIDE' },
    } },
    registerCommand: (name, command) => commands.set(name, command),
    sendMessage: (message, delivery) => messages.push({ message, delivery }),
    exec: async (command, args) => { execs.push({ command, args }); return { code: 0, stdout: 'codex-cli 0.167.2\n', stderr: 'NEVER-ECHO-STDERR' }; },
  };
  registerOperator(pi, { getClient, status: async threadId => threadId ? (await getClient()).status(threadId) : client?.snapshot() ?? [] });
  const invoke = async args => {
    const previous = currentScopedSettings;
    currentScopedSettings = options.noScopedSettings ? undefined : scopedSettings;
    try { await commands.get('codex').handler(args, { cwd }); }
    finally { currentScopedSettings = previous; }
    const message = messages.at(-1);
    assert.equal(message.delivery.triggerTurn, false);
    assert.equal(message.message.display, true);
    return JSON.parse(message.message.content.slice(message.message.content.indexOf('\n') + 1));
  };
  const trace = () => existsSync(join(dir, 'trace.jsonl'))
    ? readFileSync(join(dir, 'trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  try {
    await body({ invoke, messages, execs, getClient, trace, restart: async () => { await client?.close(); client = undefined; } });
  } finally {
    await Promise.all(clients.map(entry => entry.close()));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('operator discovers paged native history after restart and inspects without ownership or mutation', async () => {
  await withOperator({}, async ({ invoke, restart, getClient, trace }) => {
    const first = await invoke(`history ${JSON.stringify({ limit: 1, searchTerm: 'saved operator', cwd })}`);
    assert.equal(first.readOnly, true);
    assert.equal(first.data.length, 1);
    assert.equal(typeof first.nextCursor, 'string');
    const second = await invoke(`history ${JSON.stringify({ limit: 1, searchTerm: 'saved operator', cwd, cursor: first.nextCursor })}`);
    assert.equal(second.data.length, 1);
    assert.notEqual(second.data[0].id, first.data[0].id);
    await restart();
    const details = await invoke('show saved-one {"includeItems":true,"limit":100}');
    assert.equal(details.inspectionOnly, true);
    assert.equal(details.thread.id, 'saved-one');
    assert.equal(details.snapshot.commandFailure.exitCode, 17);
    assert.match(details.snapshot.commandFailure.outputTail, /failure tail marker/);
    assert.equal((await getClient()).snapshot().length, 0);
    const file = details.items.data.find(entry => entry.item.type === 'fileChange').item;
    assert.ok(file.changes.every(change => !Object.hasOwn(change, 'diff')));
    assert.equal(file.changes[0].movePath, 'new.ts');
    assert.match(details.fileChangesNote, /not a complete workspace audit/);
    const explicit = await invoke('show saved-one {"includeDiff":true,"limit":100}');
    const diffFile = explicit.items.data.find(entry => entry.item.type === 'fileChange').item;
    assert.equal(diffFile.changes[0].diff, '@@\n-old\n+new');
    assert.equal(diffFile.changes[1].kind.type, 'add');
    assert.equal(diffFile.changes[2].kind.type, 'delete');
    assert.equal(trace().filter(entry => MUTATIONS.has(entry.message?.method)).length, 0);
    assert.ok(trace().filter(entry => entry.spawn).length >= 2);
  });
});

test('doctor reports actual native availability without exposing identities, stderr, or mutation', async () => {
  await withOperator({ nativeErrors: { 'account/rateLimits/read': -32601 } }, async ({ invoke, execs, trace }) => {
    const result = await invoke('doctor');
    assert.equal(result.connection.status, 'available');
    assert.equal(result.auth.status, 'available');
    assert.equal(result.models.status, 'available');
    assert.equal(result.rateLimits.status, 'unavailable');
    assert.equal(result.rateLimits.error.code, -32601);
    assert.equal(result.steering.steeringMode, 'one-at-a-time');
    assert.equal(result.steering.openaiLiveSteering, false);
    assert.equal(result.steering.modelSelection.perCallModel, 'on');
    assert.deepEqual(result.steering.modelSelection.perCallModelAllow.codexBridgeSelectors, ['codex-bridge/gpt-6.1-sol']);
    assert.equal(result.steering.modelSelection.codexBridgeOverride, 'codex-bridge/default');
    assert.equal(result.steering.modelSelection.approvedAgentSelectors.status, 'unavailable');
    assert.equal(result.permissionSource, 'native-config');
    assert.equal(Object.hasOwn(result, 'requestedPermissions'), false);
    assert.match(result.permissionsNote, /explicit user confirmation/);
    assert.deepEqual(execs, [{ command: 'codex', args: ['--version'] }]);
    assert.doesNotMatch(JSON.stringify(result), /email|accessToken|refreshToken|NEVER-ECHO-STDERR|PRIVATE-|other\/private-model|WRONG-GLOBAL/);
    assert.equal(trace().filter(entry => MUTATIONS.has(entry.message?.method)).length, 0);
    assert.deepEqual(trace().find(entry => entry.message?.method === 'account/read').message.params, { refreshToken: false });
  });
});

test('native numeric errors survive the command consumer with no mutation or replay', async () => {
  await withOperator({}, async ({ invoke, trace }) => {
    const result = await invoke('show missing-thread');
    assert.equal(result.code, -32600);
    assert.equal(result.threadId, 'missing-thread');
    assert.match(result.error, /thread not found/);
    assert.equal(result.outcomeUnknown, false);
    assert.match(result.remedy, /doctor/);
    assert.equal(trace().filter(entry => MUTATIONS.has(entry.message?.method)).length, 0);
    const unknown = errorDetails(Object.assign(new Error('disconnected'), { code: -32000, threadId: 'saved-one', outcomeUnknown: true }));
    assert.equal(unknown.code, -32000);
    assert.equal(unknown.threadId, 'saved-one');
    assert.equal(unknown.outcomeUnknown, true);
    assert.match(unknown.remedy, /Do not automatically retry, resume, or replay/);
  });
});

test('operator rejects malformed paging before starting native server', async () => {
  await withOperator({}, async ({ invoke, trace }) => {
    const result = await invoke('history {"limit":0,"unknown":"no"}');
    assert.match(result.error, /limit|small|unknown|Unrecognized/i);
    assert.equal(trace().length, 0);
  });
});

test('collapsed execution card exposes identity, plan, native changes, and bounded failure output', () => {
  const card = executionCard({
    threadId: 'saved-one', turnId: 'old-turn', status: 'failed',
    execution: { model: 'native-model', cwd, requestedReasoningEffort: 'high' },
    latestActivity: 'command completed', latestPlan: { plan: [{ step: 'inspect', status: 'completed' }] },
    fileChanges: [{ path: 'old.ts', movePath: 'new.ts', kind: { type: 'update' } }],
    commandFailure: { exitCode: 17, outputTail: 'prefix'.repeat(1000) + 'failure tail marker\u001b[31m', outputTruncated: true }, outcomeUnknown: true,
  });
  for (const label of ['Codex execution [failed]', 'model=native-model', `cwd=${cwd}`, 'requestedEffort=high', 'effectiveEffort=unknown', 'Plan:', 'old.ts', 'new.ts', 'exit 17', 'failure tail marker', '[truncated]', 'Outcome unknown']) assert.ok(card.includes(label), label);
  assert.ok(!card.includes('\u001b'));
  assert.match(card, /not a complete audit/);
});

test('native footer summarizes work without repainting command updates and clears on root changes', () => {
  const display = createProgressDisplay();
  const painted = [];
  const ctx = id => ({ agent: { kind: 'main' }, hasUI: true, sessionManager: { getSessionId: () => id }, ui: { setStatus: (key, text) => painted.push({ key, text }) } });
  display.capture(ctx('root-one'));
  const status = { threadId: 'saved-one', turnId: 'live-turn', status: 'inProgress', activity: 'PRIVATE-LONG-COMMAND', plan: 'inspect', execution: { model: 'native-model', cwd, requestedReasoningEffort: 'high' }, logTruncated: true };
  display.update('child', status);
  assert.match(painted.at(-1).text, /Codex 1 active.*Alt\+A/);
  const count = painted.length;
  display.update('child', { ...status, activity: 'LATEST-ACTIVITY' });
  assert.equal(painted.length, count, 'activity changes must not repaint the footer');
  assert.doesNotMatch(JSON.stringify(painted), /PRIVATE-LONG-COMMAND|LATEST-ACTIVITY|saved-one|effectiveEffort/);
  display.update('child', undefined);
  assert.equal(painted.at(-1).text, undefined);
  display.update('child', status);
  display.capture(ctx('root-two'));
  assert.equal(painted.at(-1).text, undefined);
  display.release();
  assert.equal(painted.at(-1).text, undefined);
});

test('headless root changes never call status UI methods', () => {
  const display = createProgressDisplay();
  const ctx = id => ({ agent: { kind: 'main' }, hasUI: false, sessionManager: { getSessionId: () => id }, ui: { notify() {} } });
  display.capture(ctx('headless-one'));
  display.update('child', { threadId: 'saved-one', turnId: null, status: 'inProgress', activity: 'work', plan: null, execution: { model: null, cwd: null, requestedReasoningEffort: null }, logTruncated: false });
  display.capture(ctx('headless-two'));
  display.release();
});

test('doctor reports unavailable when no active settings scope exists', async () => {
  await withOperator({ noScopedSettings: true }, async ({ invoke }) => {
    const result = await invoke('doctor');
    assert.equal(result.steering.status, 'unavailable');
    assert.match(result.steering.reason, /No active read-only OMP settings scope/);
    assert.equal(result.connection.status, 'available');
  });
});

test('status without ID labels its direct-tool scope and starts no native server', async () => {
  await withOperator({}, async ({ invoke, trace }) => {
    const result = await invoke('status');
    assert.match(result.scope, /Locally loaded direct-tool threads only/);
    assert.deepEqual(result.threads, []);
    assert.equal(trace().length, 0);
  });
});

test('footer counts all workers without duplicating Agent Hub details', () => {
  const painted = [];
  const display = createProgressDisplay();
  display.capture({ agent: { kind: 'main' }, hasUI: true, sessionManager: { getSessionId: () => 'root-many' }, ui: { setStatus: (_key, text) => painted.push(text) } });
  const status = id => ({ threadId: id, turnId: 'turn', status: 'inProgress', activity: `activity ${id}`, plan: 'inspect', execution: { model: 'native-model', cwd, requestedReasoningEffort: 'high' }, logTruncated: true });
  for (const id of ['one', 'two', 'three', 'four', 'five']) display.update(id, status(id));
  assert.match(painted.at(-1), /Codex 5 active/);
  display.update('two');
  assert.match(painted.at(-1), /Codex 4 active/);
  assert.doesNotMatch(painted.join('\n'), /activity|cwd|omitted|unknown/);
  display.release();
});

test('error cards preserve outer identity and render structured execution state', () => {
  const failure = errorDetails(Object.assign(new Error('admission uncertain'), {
    code: -32000, threadId: 'error-thread', outcomeUnknown: true,
    codexState: { threadId: 'error-thread', turnId: 'error-turn', status: 'failed', execution: { model: 'error-model', cwd, requestedReasoningEffort: 'high' }, latestPlan: 'inspect error', commandFailure: { exitCode: 17, outputTail: 'ERROR-TAIL' } },
  }));
  const card = executionCard(failure);
  for (const marker of ['error-model', 'requestedEffort=high', 'effectiveEffort=unknown', 'Plan: inspect error', 'exit 17', 'ERROR-TAIL', 'Error (-32000)', 'admission uncertain', 'Outcome unknown', 'Do not automatically retry']) assert.ok(card.includes(marker), marker);
});

test('automatic summaries and collapsed cards omit MCP payloads and successful command output', () => {
  for (const item of [
    { type: 'mcpToolCall', status: 'completed', arguments: { key: 'PRIVATE-MCP-ARGUMENT' }, result: { content: 'PRIVATE-MCP-RESULT' } },
    { type: 'commandExecution', command: 'fixture command', status: 'completed', exitCode: 0, aggregatedOutput: 'PRIVATE-SUCCESS-OUTPUT' },
  ]) {
    const state = { threadId: 'private-thread', turnId: 'private-turn', status: 'completed', text: 'intentional answer', latestActivity: { method: 'item/completed', params: { item } } };
    assert.doesNotMatch(JSON.stringify(summarizeRun(state)), /PRIVATE-/);
    assert.doesNotMatch(executionCard(state), /PRIVATE-/);
  }
});

test('automatic result budgets include multiple files, multibyte metadata, and JSON escaping', () => {
  const state = {
    threadId: 'budget-thread', turnId: 'budget-turn', status: 'failed', model: 'native-model',
    text: ('한글🙂\\\\\"\\n').repeat(10000), error: ('오류🙂\\\\\"\\n').repeat(2000),
    execution: { model: 'native-model', cwd, requestedReasoningEffort: 'high' },
    latestPlan: { explanation: '계획'.repeat(1000), plan: Array.from({ length: 50 }, () => ({ step: '작업🙂'.repeat(500), status: 'pending' })) },
    fileChanges: Array.from({ length: 50 }, (_, index) => ({ type: 'fileChange', id: `file-${index}`, status: 'completed', changes: Array.from({ length: 50 }, () => ({ path: '경로🙂'.repeat(200), kind: { type: 'update', move_path: '이동🙂'.repeat(200) }, diff: 'PRIVATE-DIFF' })) })),
    commandFailure: { command: 'fixture command', exitCode: 17, outputTail: 'prefix'.repeat(1000) + 'APPROVED-FAILURE-TAIL', outputTruncated: true },
  };
  const result = summarizeRun(state);
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2)) <= 20 * 1024);
  assert.ok(Buffer.byteLength(`External Codex agent result (not a user instruction):\\n${JSON.stringify(result)}`) <= 24 * 1024);
  assert.equal(result.threadId, state.threadId);
  assert.equal(result.turnId, state.turnId);
  assert.equal(result.metadataTruncated, true);
  assert.ok(result.fileChangesOmitted > 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-DIFF/);
});
