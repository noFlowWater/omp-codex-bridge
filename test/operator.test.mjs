// Bun loads the production TypeScript operator; native requests use the shared protocol double.
import assert from 'node:assert/strict';
import { mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zod from 'zod';
import { CodexAppServerClient } from '../src/codex/client.mjs';

mock.module('@oh-my-pi/pi-tui/chat/custom-message', () => ({
  CustomMessageComponent: class { constructor(message) { this.message = message; this.text = `${message.customType}\n${message.content}`; } },
}));

// The public host setting reader is a boundary; no real OMP configuration is loaded or written.
let currentScopedSettings;
mock.module('@oh-my-pi/pi-coding-agent/config/registry', () => ({
  lookup: id => ({ get: settings => settings[id] }),
}));
mock.module('@oh-my-pi/pi-coding-agent/config/settings', () => ({
  findScopedSettings: requestedCwd => requestedCwd === cwd ? currentScopedSettings : undefined,
}));
const { registerOperator, errorDetails } = await import('../src/omp/operator.ts');
const { createProgressDisplay, summarizeRun, operatorCard, operatorContent } = await import('../src/omp/presentation.ts');
const cwd = realpathSync(process.cwd());
const FAKE = fileURLToPath(new URL('./client.test.mjs', import.meta.url));
const runtime = Bun.which('node') ?? process.execPath;
const MUTATIONS = new Set(['thread/start', 'thread/resume', 'thread/fork', 'thread/compact/start', 'turn/start', 'turn/steer', 'turn/interrupt']);

test('operator summary preserves diagnostic failures, quota warnings and terminal safety', () => {
  const card = operatorCard('doctor', {
    auth: { status: 'available', value: { authenticated: false, mode: 'chatgpt' } },
    connection: { status: 'unavailable', error: { error: 'server offline' }, remedy: 'Check PATH' },
    rateLimits: { status: 'available', value: { ordinaryUsageAllowed: false,
      rateLimits: { primary: { usedPercent: 58, resetsAt: 1795112176 }, spendControlReached: true } } },
    executable: { status: 'available', version: 'codex\u001b[2J' },
  });
  for (const text of ['Not signed in', 'unavailable', 'server offline', 'Check PATH', '58% used', 'resets', 'spend control reached', 'ordinary usage is not allowed']) assert.ok(card.includes(text), text);
  assert.doesNotMatch(card, /\u001b/);
  assert.doesNotMatch(operatorCard('doctor', {}), /undefined|NaN|Invalid Date/);
});

test('operator renderer summarizes doctor and empty status while expanded and JSON views keep native data', async () => {
  await withOperator({}, async ({ invoke, messages, renderers, trace }) => {
    const render = expanded => renderers.get('codex-bridge-operator')(messages.at(-1).message, { expanded }, { fg: (_color, text) => text });
    const result = await invoke('doctor');
    const card = render(false).text;
    assert.match(card, /Codex doctor \(read-only\):/);
    assert.match(card, /Signed in/);
    assert.match(card, /workspace-write/);
    assert.doesNotMatch(card, /"supportedReasoningEfforts"|"authenticated"\s*:/);
    assert.equal(render(true), undefined);
    assert.ok(messages.at(-1).message.content.includes('"supportedReasoningEfforts"'));
    assert.deepEqual(await invoke('doctor --json'), result);
    assert.equal(render(false), undefined);
    await invoke('status');
    assert.match(render(false).text, /No locally loaded direct-tool threads/);
    assert.match(render(false).text, /Saved \/ Hub threads/);
    await invoke('status --json');
    assert.equal(render(false), undefined);
    assert.equal(trace().filter(entry => MUTATIONS.has(entry.message?.method)).length, 0);
  });
});

test('interactive operator content carries a short model summary while expansion and explicit JSON retain all data', async () => {
  await withOperator({ ui: {} }, async ({ invoke, messages, renderers, trace }) => {
    const result = await invoke('doctor');
    const message = messages.at(-1).message;
    assert.deepEqual(message.details.result, result);
    assert.match(message.content, /Signed in/);
    assert.doesNotMatch(message.content, /supportedReasoningEfforts|perCallModelAllow|omp_codex_bridge/);
    assert.ok(message.content.length < JSON.stringify(result).length / 2, 'catalog and routing data stay out of default model context');
    const render = expanded => renderers.get('codex-bridge-operator')(message, { expanded }, {});
    assert.match(render(false).text, /Signed in/);
    assert.match(render(true).text, /supportedReasoningEfforts/);
    await invoke('doctor --json');
    assert.deepEqual(JSON.parse(messages.at(-1).message.content.split('\n').slice(1).join('\n')), result);
    assert.equal(messages.at(-1).message.details.result, undefined);
    await invoke('unknown-command');
    assert.match(messages.at(-1).message.content, /Use \/codex for help/);
    assert.doesNotMatch(messages.at(-1).message.content, /"error"\s*:/);
    assert.deepEqual(trace().filter(entry => MUTATIONS.has(entry.message?.method)), []);
  });
});

test('operator help preserves line breaks and remaining commands render summaries without JSON', async () => {
  await withOperator({}, async ({ invoke, messages, renderers }) => {
    const render = () => renderers.get('codex-bridge-operator')(messages.at(-1).message, { expanded: false }, { fg: (_color, text) => text }).text;
    await invoke('help');
    const help = render();
    assert.match(help, /Command \| Purpose/);
    assert.match(help, /\| \/codex history \| Browse saved threads \|/);
    await invoke('show saved-one {"includeItems":true}');
    assert.match(render(), /Thread \| saved-one/);
    assert.match(render(), /Command failed \| exit 17/);
    assert.doesNotMatch(render(), /[{}]|"readOnly"|latestPlan|effectiveEffort/);
    await invoke('tier');
    assert.match(render(), /Service tier \| inherit/);
    assert.doesNotMatch(render(), /[{}]/);
    await invoke('show missing-thread');
    assert.match(render(), /Code \| -32600/);
    assert.match(render(), /thread not found/);
    assert.doesNotMatch(render(), /[{}]|errorTruncated|outcomeUnknown/);
    await invoke('wrong-command');
    assert.match(render(), /Use \/codex for help/);
    assert.doesNotMatch(render(), /Usage:|Fork options/);
    await invoke('show --json saved-one');
    assert.equal(renderers.get('codex-bridge-operator')(messages.at(-1).message, { expanded: false }, {}), undefined);
  });
});

test('native table text preserves untrusted Markdown as literal cell contents', () => {
  const markdown = operatorCard('error', { error: '[fake](https://evil) | <script> **bold** `code`', remedy: 'Check login' });
  assert.ok(markdown.includes('\\[fake\\](https://evil) \\| \\<script\\> \\*\\*bold\\*\\* \\`code\\`'));
  assert.ok(markdown.includes('| Error |'));
});

test('human results retain multiline answers, logs, requested diffs and truncation notices', () => {
  const content = operatorContent('details', {
    snapshot: { threadId: 'saved', status: 'failed', text: 'first answer\n```\nsecond answer', textTruncated: true,
      latestActivity: { method: 'item/completed', summary: 'latest summarized command' },
      commandFailure: { exitCode: 17, outputTail: 'first failure\nsecond failure', outputTruncated: true } },
    items: { data: [{ item: { type: 'fileChange', changes: [{ path: 'a.ts', diff: '@@\n-old\n+new', diffTruncated: true }] } }], nextCursor: 'next' },
  });
  assert.ok(content.includes('first answer\n```\nsecond answer'));
  assert.ok(content.includes('first failure\nsecond failure'));
  assert.ok(content.includes('latest summarized command'));
  assert.ok(content.includes('```diff\n@@\n-old\n+new\n```'));
  assert.match(content, /Output truncated/);
  assert.match(content, /continuation cursor/);
  const plain = operatorContent('details', { snapshot: { threadId: 'saved', text: 'complete answer' } });
  assert.doesNotMatch(plain, /Output truncated|```diff/);
});

test('quota windows identify the measured period and show a local reset time', () => {
  const card = operatorCard('doctor', { rateLimits: { status: 'available', value: { rateLimits: {
    primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1795112176 },
    secondary: { usedPercent: 58, windowDurationMins: 10080 },
  } } } });
  assert.match(card, /5-hour usage/);
  assert.match(card, /7-day usage/);
  assert.match(card, /20% used · resets/);
  assert.doesNotMatch(card, /primary|secondary|T\d\d:\d\d/);
});

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
  writeFileSync(join(dir, 'store.json'), JSON.stringify(options.savedState ?? saved));
  const messages = [];
  const execs = [];
  const commands = new Map();
  const renderers = new Map();
  const clients = [];
  const tierChanges = [];
  let serviceTier = options.initialTier;
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
    zod, pi: { Text: class { constructor(text) { this.text = text; } }, VERSION: 'test-host', settings: {
      steeringMode: 'all', 'providers.openaiLiveSteering': true, 'task.perCallModel': 'off',
      'task.agentModelOverrides': { 'codex-bridge': 'WRONG-GLOBAL-OVERRIDE' },
    } },
    registerCommand: (name, command) => commands.set(name, command),
    registerMessageRenderer: (name, renderer) => renderers.set(name, renderer),
    sendMessage: (message, delivery) => messages.push({ message, delivery }),
    exec: async (command, args) => { execs.push({ command, args }); return { code: 0, stdout: 'codex-cli 0.167.2\n', stderr: 'NEVER-ECHO-STDERR' }; },
    getServiceTiers: () => ({ openai: serviceTier }),
    setServiceTier: (family, value) => { tierChanges.push({ family, value }); serviceTier = value; },
  };
  registerOperator(pi, {
    getClient,
    status: async threadId => threadId ? (await getClient()).status(threadId) : client?.snapshot() ?? [],
    fork: options.fork ?? (async params => {
      const result = await (await getClient()).fork({ threadId: params.threadId, lastTurnId: params.lastTurnId, cwd });
      return { forked: true, threadId: result.threadId, cwd: result.cwd };
    }),
  });
  const invoke = async args => {
    const previous = currentScopedSettings;
    currentScopedSettings = options.noScopedSettings ? undefined : scopedSettings;
    try { await commands.get('codex').handler(args, { cwd, hasUI: Boolean(options.ui), ui: options.ui }); }
    finally { currentScopedSettings = previous; }
    const message = messages.at(-1);
    assert.equal(message.delivery.triggerTurn, false);
    assert.equal(message.message.display, true);
    if (message.message.details?.label === 'help') return message.message.content;
    return message.message.details?.result ?? JSON.parse(message.message.content.slice(message.message.content.indexOf('\n') + 1));
  };
  const trace = () => existsSync(join(dir, 'trace.jsonl'))
    ? readFileSync(join(dir, 'trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  try {
    await body({ invoke, messages, execs, getClient, trace, tierChanges, renderers, restart: async () => { await client?.close(); client = undefined; } });
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
  const card = operatorContent('status', {
    threadId: 'saved-one', turnId: 'old-turn', status: 'failed',
    execution: { model: 'native-model', cwd, requestedReasoningEffort: 'high' },
    latestActivity: 'command completed', latestPlan: { plan: [{ step: 'inspect', status: 'completed' }] },
    fileChanges: [{ path: 'old.ts', movePath: 'new.ts', kind: { type: 'update' } }],
    commandFailure: { exitCode: 17, outputTail: 'prefix'.repeat(1000) + 'failure tail marker\u001b[31m', outputTruncated: true }, outcomeUnknown: true,
  });
  for (const label of ['failed', 'native-model', cwd, 'Requested effort', 'high', '**Plan**', 'old.ts', 'new.ts', 'exit 17', 'failure tail marker', 'Output truncated', 'Outcome unknown']) assert.ok(card.includes(label), label);
  assert.ok(card.includes('| Requested effort | high |'));
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
  const card = operatorContent('error', failure);
  for (const marker of ['error-model', 'Requested effort', 'high', 'inspect error', 'exit 17', 'ERROR-TAIL', '-32000', 'admission uncertain', 'Outcome unknown', 'Do not automatically retry']) assert.ok(card.includes(marker), marker);
});

test('automatic summaries and collapsed cards omit MCP payloads and successful command output', () => {
  for (const item of [
    { type: 'mcpToolCall', status: 'completed', arguments: { key: 'PRIVATE-MCP-ARGUMENT' }, result: { content: 'PRIVATE-MCP-RESULT' } },
    { type: 'commandExecution', command: 'fixture command', status: 'completed', exitCode: 0, aggregatedOutput: 'PRIVATE-SUCCESS-OUTPUT' },
  ]) {
    const state = { threadId: 'private-thread', turnId: 'private-turn', status: 'completed', text: 'intentional answer', latestActivity: { method: 'item/completed', params: { item } } };
    assert.doesNotMatch(JSON.stringify(summarizeRun(state)), /PRIVATE-/);
    assert.doesNotMatch(operatorContent('status', state), /PRIVATE-/);
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

test('interactive history pages with filters, views details, and cancels without mutation', async () => {
  const screens = [];
  const answers = ['Next page', 'Previous page', 0, 'View details'];
  const ui = { select: async (title, choices) => {
    screens.push({ title, choices });
    const answer = answers.shift();
    return typeof answer === 'number' ? choices[answer] : answer;
  } };
  await withOperator({ ui }, async ({ invoke, trace, getClient }) => {
    const result = await invoke(`history ${JSON.stringify({ limit: 1, searchTerm: 'saved operator', cwd })}`);
    assert.equal(result.inspectionOnly, true);
    assert.equal(result.thread.id, 'saved-one');
    assert.match(screens[0].choices[0], /saved operator first/);
    assert.ok(screens[0].choices[0].endsWith('· .'));
    assert.ok(!screens[0].choices[0].includes('saved-one'));
    assert.ok(screens.some(screen => screen.title.includes('Source saved-one') && screen.title.includes(cwd)));
    assert.ok(screens[1].choices.includes('Previous page'));
    for (const entry of trace().filter(entry => entry.message?.method === 'thread/list')) {
      assert.equal(entry.message.params.searchTerm, 'saved operator');
      assert.equal(entry.message.params.cwd, cwd);
      assert.equal(entry.message.params.limit, 1);
    }
    assert.equal((await getClient()).snapshot().length, 0);
    assert.equal(trace().filter(entry => MUTATIONS.has(entry.message?.method)).length, 0);
  });
  for (const answers of [[undefined], [0, undefined], [0, 'Fork as new direct thread', undefined]]) {
    await withOperator({ ui: { select: async (_title, choices) => {
      const answer = answers.shift();
      return typeof answer === 'number' ? choices[answer] : answer;
    } } }, async ({ invoke, trace }) => {
      assert.equal((await invoke('history')).cancelled, true);
      assert.equal(trace().filter(entry => MUTATIONS.has(entry.message?.method)).length, 0);
    });
  }
});

test('interactive fork requires confirmation and freezes completed boundary without source mutation or inference', async () => {
  const answers = [0, 'Fork as new direct thread', 'Confirm fork'];
  let selected;
  await withOperator({
    ui: { select: async (_title, choices) => {
      const answer = answers.shift();
      return typeof answer === 'number' ? choices[answer] : answer;
    } },
    fork: async params => { selected = params; return { forked: true, threadId: 'new-direct', cwd }; },
  }, async ({ invoke, trace }) => {
    const result = await invoke('history');
    assert.deepEqual(selected, { threadId: 'saved-one', lastTurnId: 'old-turn' });
    assert.equal(result.threadId, 'new-direct');
    assert.equal(trace().filter(entry => MUTATIONS.has(entry.message?.method)).length, 0);
    const source = await invoke('show saved-one');
    assert.equal(source.thread.name, 'saved operator first');
    assert.equal(source.turns.data[0].id, 'old-turn');
  });
});

test('explicit fork parses only native boundary and optional name', async () => {
  const calls = [];
  await withOperator({ fork: async params => { calls.push(params); return { forked: true, threadId: 'new-direct', cwd }; } },
    async ({ invoke, trace }) => {
      await invoke('fork saved-one {"lastTurnId":"old-turn","name":"new name"}');
      assert.deepEqual(calls, [{ threadId: 'saved-one', lastTurnId: 'old-turn', name: 'new name' }]);
      await invoke('fork saved-one {"prompt":"must not infer"}');
      assert.equal(calls.length, 1);
      assert.equal(trace().length, 0);
    });
});


test('history picker safely renders source name and cwd controls', async () => {
  const state = structuredClone(saved);
  state.threads['saved-one'].name = 'name\u001b[31m\u009b\u202e\ninjected';
  state.threads['saved-one'].cwd = '/source/\u001b[2J\u2066';
  let choices;
  await withOperator({ savedState: state, ui: { select: async (_title, options) => { choices = options; } } },
    async ({ invoke, trace }) => {
      assert.equal((await invoke('history')).cancelled, true);
      assert.doesNotMatch(choices[0], /[\u001b\u009b\u202e\u2066\n]/);
      assert.match(choices[0], /\\u001b/);
      assert.match(choices[0], /\\u202e/);
      assert.match(choices[0], /source/);
      assert.equal(trace().filter(entry => MUTATIONS.has(entry.message?.method)).length, 0);
    });
});

test('tier command uses existing session OpenAI-family setting without native admission', async () => {
  await withOperator({ initialTier: 'priority' }, async ({ invoke, tierChanges, trace }) => {
    const current = await invoke('tier');
    assert.equal(current.serviceTier, 'priority');
    assert.equal(current.readOnly, true);
    assert.match(current.scope, /OpenAI-family setting for this OMP session/);
    assert.equal(tierChanges.length, 0);
    await invoke('tier flex');
    await invoke('tier inherit');
    assert.deepEqual(tierChanges, [{ family: 'openai', value: 'flex' }, { family: 'openai', value: undefined }]);
    await invoke('tier fast');
    assert.equal(tierChanges.length, 2);
    assert.equal(trace().length, 0);
  });
  for (const choice of ['ultrafast', undefined]) {
    await withOperator({ ui: { select: async () => choice } }, async ({ invoke, tierChanges, trace }) => {
      const result = await invoke('tier');
      if (choice) assert.deepEqual(tierChanges, [{ family: 'openai', value: choice }]);
      else {
        assert.equal(result.cancelled, true);
        assert.equal(tierChanges.length, 0);
      }
      assert.equal(trace().length, 0);
    });
  }
});

test('interactive history can explicitly return JSON without opening a picker', async () => {
  await withOperator({ ui: { select: async () => assert.fail('JSON history must not open a picker') } }, async ({ invoke, trace }) => {
    const result = await invoke('history --json {"limit":1}');
    assert.equal(result.data[0].id, 'saved-one');
    assert.equal(typeof result.nextCursor, 'string');
    assert.equal(trace().filter(entry => MUTATIONS.has(entry.message?.method)).length, 0);
  });
});

test('quota notices merge sparse windows, deduplicate clients, and require observed recovery', () => {
  const display = createProgressDisplay();
  const notices = [];
  display.capture({ agent: { kind: 'main' }, hasUI: true, sessionManager: { getSessionId: () => 'quota-root' },
    ui: { setStatus() {}, notify: (message, type) => notices.push({ message, type }) } });
  const send = rateLimits => display.rateLimits({ rateLimits });
  send({ limitId: 'codex', primary: { usedPercent: 80 } });
  assert.equal(notices.length, 0);
  const reached = { limitId: 'codex', primary: { usedPercent: 100, resetsAt: 1900000000 }, secondary: { usedPercent: 20 } };
  send(reached);
  send(reached);
  send({ limitId: 'codex', primary: null, secondary: { usedPercent: 10 }, accountId: 'PRIVATE-ACCOUNT' });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, 'warning');
  assert.match(notices[0].message, /Usage window 1: 100%.*reset/);
  assert.doesNotMatch(notices[0].message, /PRIVATE-ACCOUNT/);
  send({ limitId: 'codex', primary: { usedPercent: 30 } });
  assert.equal(notices[1].type, 'info');
  assert.match(notices[1].message, /usage window recovered/);
  send({ limitId: 'codex', spendControlReached: true });
  send({ limitId: 'codex', primary: { usedPercent: 0 }, spendControlReached: null });
  assert.equal(notices.length, 3);
  send({ limitId: 'codex', spendControlReached: false });
  assert.equal(notices.length, 4);
  display.release();
  send(reached);
  assert.equal(notices.length, 4, 'headless/released roots cannot notify');
});

test('execution card separates requested tier from an unreported effective tier', () => {
  const card = operatorContent('status', { threadId: 'thread', name: 'Parser review', status: 'inProgress',
    execution: { requestedServiceTier: 'priority', serviceTier: null } });
  assert.match(card, /Name \| Parser review/);
  assert.match(card, /Requested tier \| priority/);
  assert.doesNotMatch(card, /Effective tier/);
});

test('history picker forks the latest failed or interrupted turn rather than an older success', async () => {
  for (const status of ['failed', 'interrupted']) {
    const state = structuredClone(saved);
    state.threads['saved-one'].turns.push({ id: 'latest', status, items: [] });
    const answers = [0, 'Fork as new direct thread', 'Confirm fork'];
    let chosen;
    await withOperator({
      savedState: state,
      ui: { select: async (_title, choices) => {
        const answer = answers.shift();
        return typeof answer === 'number' ? choices[answer] : answer;
      } },
      fork: async params => { chosen = params; return { forked: true, threadId: 'new-thread', cwd }; },
    }, async ({ invoke }) => {
      const result = await invoke('history');
      assert.equal(result.forked, true);
      assert.equal(chosen.lastTurnId, 'latest');
    });
  }
});

test('footer reflects observed models and keeps mixed workers distinct without exposing task data', () => {
  const painted = [];
  const display = createProgressDisplay();
  display.capture({ agent: { kind: 'main' }, hasUI: true, sessionManager: { getSessionId: () => 'model-root' }, ui: { setStatus: (_key, text) => painted.push(text) } });
  const status = model => ({ threadId: 'private-id', turnId: 'turn', status: 'inProgress', activity: 'private-command', plan: null, execution: { model, cwd, requestedReasoningEffort: null }, logTruncated: false });
  display.update('a', status(null));
  assert.doesNotMatch(painted.at(-1), /unknown|default|private/);
  display.update('a', status('observed-one'));
  assert.ok(painted.at(-1).includes('observed-one'));
  display.update('b', status('observed-two'));
  assert.match(painted.at(-1), /2 active.*2 models/);
  display.update('a');
  assert.ok(painted.at(-1).includes('observed-two'));
  display.update('b');
  assert.equal(painted.at(-1), undefined);
});

test('result usage retains native tokens and distinguishes unavailable billing from free execution', () => {
  const usage = { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 250, totalTokens: 1250 };
  const summary = summarizeRun({ threadId: 'usage-thread', turnId: 'turn', status: 'completed', turnUsage: usage });
  assert.deepEqual(summary.usage, usage);
  assert.equal(summary.cost, null);
  const card = operatorContent('status', summary);
  assert.match(card, /1,250/);
  assert.doesNotMatch(card, /\$0|free/i);
  const missing = summarizeRun({ threadId: 'no-usage', turnId: 'turn', status: 'completed' });
  assert.equal(missing.usage, null);
  assert.equal(missing.cost, null);
  assert.doesNotMatch(operatorContent('status', missing), /Tokens \|/);
});
