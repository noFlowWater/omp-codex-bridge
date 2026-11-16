import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient } from '../src/codex/client.mjs';
import { bootstrapHistory, historyEntry, HISTORY_ENTRY } from '../src/omp/history.mjs';
import { loadSession, readSessionRecord, saveSession } from '../src/omp/session-store.mjs';

const cwd = realpathSync(process.cwd());
const fake = fileURLToPath(new URL('./client.test.mjs', import.meta.url));
const mutations = new Set(['thread/start', 'thread/resume', 'thread/fork', 'thread/name/set', 'thread/compact/start', 'turn/start', 'turn/steer', 'turn/interrupt']);

async function withHistory(t, { status = 'completed', options = {}, nativeCwd = cwd } = {}, body) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-history-'));
  const stateDir = join(directory, 'ledger');
  const source = { threadId: 'saved-source', lastTurnId: 'saved-boundary', cwd };
  const original = { id: source.threadId, cwd: nativeCwd, name: 'Original saved history', turns: [{
    id: source.lastTurnId, status, prompt: 'PRIVATE SOURCE QUESTION', error: null,
    items: [{ type: 'agentMessage', id: 'saved-answer', text: 'PRIVATE SOURCE TRANSCRIPT', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null }],
  }] };
  writeFileSync(join(directory, 'options.json'), JSON.stringify(options));
  writeFileSync(join(directory, 'store.json'), JSON.stringify({ nextThread: 0, nextTurn: 100, threads: { [source.threadId]: original } }));
  const clients = [];
  const freshClient = () => {
    const client = new CodexAppServerClient({ command: [process.execPath, fake, '--fake-app-server'], timeoutMs: 1000, env: { CODEX_HOME: directory } });
    clients.push(client);
    return client;
  };
  const trace = () => {
    const file = join(directory, 'trace.jsonl');
    if (!existsSync(file)) return [];
    const text = readFileSync(file, 'utf8');
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  const h = { directory, source, original, client: freshClient(), session: undefined, saves: [],
    requests: method => trace().filter(entry => entry.message?.method === method).map(entry => entry.message.params),
    mutations: () => trace().filter(entry => mutations.has(entry.message?.method)).map(entry => entry.message),
    store: () => JSON.parse(readFileSync(join(directory, 'store.json'), 'utf8')),
    ledger: () => readSessionRecord(h.session.file),
    save(session) {
      saveSession(stateDir, session);
      h.saves.push({ record: readSessionRecord(session.file), trace: trace() });
    },
    async reload() {
      await h.client.close();
      h.client = freshClient();
      h.session = Object.assign(loadSession(stateDir, 'child-session', 'fake-model', cwd), { client: h.client });
    },
    bootstrap: () => bootstrapHistory(h.session, h.source, h.save),
  };
  h.session = Object.assign(loadSession(stateDir, 'child-session', 'fake-model', cwd), { client: h.client });
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    rmSync(directory, { recursive: true, force: true });
  });
  return body(h);
}

for (const status of ['completed', 'failed', 'interrupted']) test(`bootstrap copies ${status} history once, then delivers only the new question`, async t => {
  await withHistory(t, { status }, async h => {
    await h.bootstrap();
    const copy = h.session.threadId;
    assert.notEqual(copy, h.source.threadId);
    assert.deepEqual(h.mutations().map(message => message.method), ['thread/fork']);
    assert.deepEqual(h.requests('thread/fork').map(({ threadId, lastTurnId }) => ({ threadId, lastTurnId })), [
      { threadId: h.source.threadId, lastTurnId: h.source.lastTurnId },
    ]);
    assert.deepEqual([...h.session.threads], [copy]);
    assert.equal(h.client.snapshot(h.source.threadId), undefined);
    assert.deepEqual(h.store().threads[h.source.threadId], h.original);
    assert.equal(h.session.historyFork.completed, true);
    assert.equal(h.session.historyFork.forkedThreadId, copy);
    assert.equal(h.session.historyFork.forkedTurnId, h.source.lastTurnId);
    assert.equal(h.session.turnId, h.source.lastTurnId);
    assert.deepEqual(h.saves.map(save => save.record.historyFork.completed), [false, false, true]);
    const confirmed = h.saves.find(save => save.record.historyFork.completed);
    assert.ok(confirmed.trace.some(entry => entry.message?.method === 'thread/turns/list' && entry.message.params.threadId === copy && entry.message.params.limit === 1));
    assert.ok(h.saves.filter(save => !save.record.historyFork.completed).every(save => !save.trace.some(entry => entry.message?.method === 'thread/turns/list' && entry.message.params.threadId === copy)));

    const question = 'ONLY NEW QUESTION\nKeep this exact text';
    await h.client.run({ threadId: copy, prompt: question, cwd });
    assert.deepEqual(h.requests('turn/start').map(({ threadId, input }) => ({ threadId, input })), [
      { threadId: copy, input: [{ type: 'text', text: question }] },
    ]);
    assert.doesNotMatch(JSON.stringify(h.requests('turn/start')), /PRIVATE SOURCE/);
    assert.deepEqual(h.store().threads[h.source.threadId], h.original);
    h.save(h.session);
    await h.reload();
    await h.bootstrap();
    assert.equal(h.requests('thread/fork').length, 1);
    assert.equal(h.requests('thread/resume').length, 0);
    assert.equal(h.requests('turn/start').length, 1);
    assert.deepEqual([...h.session.threads], [copy]);
  });
});

test('history entry selects the latest custom source and rejects malformed types and relative directories', () => {
  const source = { threadId: 'source', lastTurnId: 'finished', cwd };
  assert.equal(historyEntry([{ type: 'custom', customType: 'unrelated', data: source }]), undefined);
  assert.deepEqual(historyEntry([
    { type: 'custom', customType: HISTORY_ENTRY, data: { ...source, threadId: 'older' } },
    { type: 'message', customType: HISTORY_ENTRY, data: { ...source, threadId: 'ignored' } },
    { type: 'custom', customType: HISTORY_ENTRY, data: { ...source, transcript: 'PRIVATE' } },
  ]), source);
  for (const data of [null, [], 'text', {}, { ...source, threadId: 3 }, { ...source, lastTurnId: '' }, { ...source, cwd: null }, { ...source, cwd: 'relative/path' }]) {
    assert.throws(() => historyEntry([{ type: 'custom', customType: HISTORY_ENTRY, data }]), /Invalid saved-history continuation/);
  }
});

test('missing or unfinished boundaries cause zero native mutation and create no fork receipt', async t => {
  for (const [status, boundary] of [['inProgress', 'saved-boundary'], ['completed', 'missing-boundary']]) {
    await withHistory(t, { status, options: { staleTurns: true } }, async h => {
      h.source.lastTurnId = boundary;
      await assert.rejects(h.bootstrap(), /finished turn|boundary was not found/);
      assert.deepEqual(h.mutations(), []);
      assert.equal(h.session.historyFork, undefined);
      assert.equal(h.ledger(), undefined);
      assert.deepEqual(h.store().threads[h.source.threadId], h.original);
    });
  }
});

test('source workspace mismatch or nonexistent directory refuses before fork', async t => {
  await withHistory(t, { nativeCwd: '/different-native-workspace' }, async h => {
    await assert.rejects(h.bootstrap(), /source directory changed/);
    assert.deepEqual(h.mutations(), []);
    assert.equal(h.session.historyFork, undefined);
  });
  await withHistory(t, {}, async h => {
    h.source.cwd = join(h.directory, 'missing-workspace');
    await assert.rejects(h.bootstrap(), /ENOENT/);
    assert.deepEqual(h.mutations(), []);
    assert.equal(h.requests('thread/read').length, 0);
    assert.equal(h.session.historyFork, undefined);
  });
});

test('an absolute file path cannot become a history working directory or admit a fork', async t => {
  await withHistory(t, {}, async h => {
    const file = join(h.directory, 'options.json');
    h.source.cwd = file;
    h.session.cwd = file;
    const store = h.store();
    store.threads[h.source.threadId].cwd = file;
    writeFileSync(join(h.directory, 'store.json'), JSON.stringify(store));
    await assert.rejects(h.bootstrap(), /existing directory/);
    assert.deepEqual(h.mutations(), []);
    assert.equal(h.ledger().historyFork.completed, false);
  });
});

test('fork refusal and disconnected unknown outcome block replay after loading the ledger', async t => {
  for (const [options, message] of [[{ nativeErrors: { 'thread/fork': { code: -32602, message: 'fork refused' } } }, /fork refused/], [{ exitOnStart: true }, /disconnect/i]]) {
    await withHistory(t, { options }, async h => {
      let failure;
      await assert.rejects(h.bootstrap(), error => { failure = error; return message.test(error.message); });
      if (options.exitOnStart) assert.equal(failure.outcomeUnknown, true);
      assert.equal(h.ledger().historyFork.completed, false);
      assert.match(h.ledger().failure, /not retried/);
      assert.equal(h.requests('thread/fork').length, 1);
      await h.reload();
      await assert.rejects(h.bootstrap(), /not retried/);
      assert.equal(h.requests('thread/fork').length, 1);
      assert.equal(h.requests('turn/start').length, 0);
      assert.equal(h.requests('thread/resume').length, 0);
      assert.deepEqual(h.store().threads[h.source.threadId], h.original);
    });
  }
});

test('fork admission without a confirmed copy boundary never records completion or sends input', async t => {
  await withHistory(t, { options: { nativeResponses: { 'thread/fork': {
    thread: { id: 'unconfirmed-copy', cwd }, cwd, model: 'fake-model',
  } } } }, async h => {
    await assert.rejects(h.bootstrap(), /thread not found/);
    assert.equal(h.session.threadId, 'unconfirmed-copy');
    assert.deepEqual([...h.session.threads], ['unconfirmed-copy']);
    assert.equal(h.ledger().historyFork.completed, false);
    assert.ok(h.saves.every(save => !save.record.historyFork.completed));
    assert.deepEqual(h.mutations().map(message => message.method), ['thread/fork']);
    await h.reload();
    await assert.rejects(h.bootstrap(), /not retried/);
    assert.equal(h.requests('thread/fork').length, 1);
    assert.equal(h.requests('turn/start').length, 0);
  });
});
