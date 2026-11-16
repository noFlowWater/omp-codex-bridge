import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hubJobs, continueInHub } from '../src/omp/hub.ts';

const row = { agentId: 'child-1', jobId: 'job-1', jobStartedAt: 100, sessionFile: '/sessions/child-1.jsonl', sessionId: 'provider-session-1', generation: 3, runStartedAt: 101, name: 'Review parser', status: 'running', agentStatus: 'running', cwd: process.cwd(), model: 'codex-bridge/gpt-native', lastActivity: 101 };

function harness(rows = [row]) {
  const calls = [];
  const api = {
    list() { calls.push(['list']); return rows; },
    async spawn(options) { calls.push(['spawn', options]); return { ...row, sessionFile: null }; },
    async focus(handle) { calls.push(['focus', handle]); },
    async send(handle, text, options) { calls.push(['send', handle, text, options]); return row; },
    async interrupt(handle) { calls.push(['interrupt', handle]); },
    async cancel(handle) { calls.push(['cancel', handle]); },
  };
  return { api, calls, ctx: { agents: api, cwd: process.cwd() } };
}

test('absent, function-shaped or incomplete agents APIs make no host calls', async () => {
  let calls = 0;
  const inert = () => { calls++; };
  for (const ctx of [{}, { agents: inert }, { agents: [] }, { agents: { list: inert } }, new Proxy({}, { get: () => inert })]) {
    assert.equal(hubJobs(ctx), undefined);
    await assert.rejects(continueInHub({ threadId: 'source', lastTurnId: 'finished', cwd: process.cwd() }, 'question', ctx), /does not expose Agent Hub/);
  }
  assert.equal(calls, 0);
});

test('listing keeps only latest Codex workers including completed runnable jobs', async () => {
  const latest = { ...row, jobId: 'job-2', jobStartedAt: 102, status: 'completed', agentStatus: 'parked' };
  const other = { ...row, agentId: 'other', jobId: 'other-job', model: 'other-provider/gpt-native' };
  const changedProvider = { ...row, agentId: 'changed', jobId: 'changed-old' };
  const h = harness([row, latest, other, changedProvider, { ...changedProvider, jobId: 'changed-new', jobStartedAt: 103, model: 'other-provider/model' }]);
  const jobs = await hubJobs(h.ctx).list();
  assert.deepEqual(jobs.map(job => job.id), ['job-2']);
  assert.equal(jobs[0].status, 'completed');
  assert.equal(jobs[0].canSend, true);
  assert.equal(jobs[0].canOpen, true);
  assert.equal(jobs[0].canCancel, false);
  assert.deepEqual(h.calls.map(call => call[0]), ['list']);
});

test('native receipts join by explicit provider session identity and inspection failures stay local', async () => {
  const h = harness([row, { ...row, agentId: 'receipt-only', jobId: 'receipt-job', sessionId: 'receipt-session', model: undefined }, { ...row, agentId: 'unreadable', jobId: 'broken-job', sessionId: 'broken-session' }]);
  const inspected = [];
  const access = hubJobs(h.ctx, id => {
    inspected.push(id);
    if (id === 'broken-session') throw new Error('record is unreadable');
    return { threadId: `native-${id}`, turnId: 'native-turn', status: 'inProgress', latestActivity: 'native progress' };
  });
  const jobs = await access.list();
  assert.deepEqual(inspected, ['provider-session-1', 'receipt-session', 'broken-session']);
  assert.equal(jobs.length, 3);
  assert.equal(jobs[1].threadId, 'native-receipt-session');
  assert.equal(jobs[1].turnId, 'native-turn');
  assert.equal(jobs[1].activity, 'native progress');
  assert.match((await access.details(jobs[2])).job.inspectionWarning, /record is unreadable/);
  assert.deepEqual(h.calls.map(call => call[0]), ['list']);
});

test('send, interrupt and focus use the same frozen captured handle without retargeting', async () => {
  const changing = { ...row };
  const h = harness([changing]);
  const access = hubJobs(h.ctx);
  const [job] = await access.list();
  const captured = job.hubHandle;
  assert.equal(Object.isFrozen(captured), true);
  changing.jobId = 'new-job';
  changing.sessionId = 'new-session';
  changing.generation = 4;
  changing.runStartedAt = 102;
  await access.send({ ...job }, ' exact\nmessage ');
  await access.cancel({ ...job });
  await access.open({ ...job });
  assert.deepEqual(h.calls.map(call => call[0]), ['list', 'send', 'interrupt', 'focus']);
  for (const call of h.calls.slice(1)) {
    assert.equal(call[1], captured);
    assert.equal(call[1].jobId, 'job-1');
    assert.equal(call[1].sessionId, 'provider-session-1');
    assert.equal(call[1].generation, 3);
    assert.equal(call[1].runStartedAt, 101);
  }
  assert.equal(h.calls[1][2], ' exact\nmessage ');
  assert.deepEqual(h.calls[1][3], { streamingBehavior: 'steer' });
});

test('finished sends use followUp and host failures are returned unchanged without retries', async () => {
  const h = harness([{ ...row, status: 'failed' }]);
  const error = new Error('native run changed');
  h.api.send = async (handle, text, options) => { h.calls.push(['send', handle, text, options]); throw error; };
  const access = hubJobs(h.ctx);
  const [job] = await access.list();
  await assert.rejects(access.send(job, 'follow-up'), failure => failure === error);
  assert.deepEqual(h.calls.map(call => call[0]), ['list', 'send']);
  assert.deepEqual(h.calls[1][3], { streamingBehavior: 'followUp' });
});

test('queued children can be cancelled without opening or guessing a native session', async () => {
  const h = harness([{ ...row, sessionFile: null, sessionId: undefined }]);
  const access = hubJobs(h.ctx, () => assert.fail('no explicit session id'));
  const [job] = await access.list();
  assert.equal(job.canSend, false);
  assert.equal(job.canCancel, true);
  assert.equal(job.status, 'queued');
  assert.equal(job.canOpen, false);
  assert.equal(job.threadId, undefined);
  await access.cancel(job);
  assert.equal(h.calls.at(-1)[0], 'cancel');
});

test('continue requires an explicit question and the same real workspace before spawning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-access-'));
  try {
    const h = harness();
    const source = { threadId: 'source-native-thread', lastTurnId: 'finished-native-turn', cwd: directory };
    await assert.rejects(continueInHub(source, 'question', h.ctx), /workspace differs/);
    for (const question of ['', '  ', undefined]) await assert.rejects(continueInHub({ ...source, cwd: h.ctx.cwd }, question, h.ctx), /non-empty question/);
    await assert.rejects(continueInHub({ ...source, lastTurnId: '' }, 'question', h.ctx), /source thread, finished turn/);
    assert.equal(h.calls.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('continue spawns only the question plus source boundary and never focuses a queued child', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-access-'));
  try {
    const alias = join(directory, 'workspace-alias');
    await symlink(process.cwd(), alias, 'dir');
    const h = harness();
    const source = { threadId: 'source-thread', lastTurnId: 'source-turn', cwd: alias, transcript: 'PRIVATE SOURCE TRANSCRIPT' };
    const question = `${'q'.repeat(150)}\nExplicit next question`;
    const handle = await continueInHub(source, question, h.ctx);
    assert.equal(handle.sessionFile, null);
    assert.deepEqual(h.calls, [['spawn', {
      agent: 'codex-bridge', cwd: h.ctx.cwd, task: question, name: 'q'.repeat(120),
      initialization: [{ customType: 'codex-bridge-history-fork', data: { threadId: 'source-thread', lastTurnId: 'source-turn', cwd: alias } }],
    }]]);
    assert.doesNotMatch(JSON.stringify(h.calls), /PRIVATE SOURCE TRANSCRIPT/);
    assert.equal(h.calls[0][1].model, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
