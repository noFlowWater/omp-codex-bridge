import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { pickJobs } from '../src/omp/jobs.ts';

const direct = { id: 'direct-1', kind: 'direct', name: 'Parser review', status: 'inProgress', cwd: '/work', threadId: 'thread-1', turnId: 'turn-1', canSend: true, canCancel: true };
const hub = { ...direct, id: 'hub-1', kind: 'hub', name: 'Hub review', canOpen: true };

function harness(answers = [], overrides = {}) {
  const calls = [];
  const screens = [];
  const access = {
    list: async () => { calls.push(['list']); return [direct, hub]; },
    details: async job => { calls.push(['details', job]); return { detail: job.id }; },
    send: async (job, text) => { calls.push(['send', job, text]); return { sent: true }; },
    cancel: async job => { calls.push(['cancel', job]); return { interrupted: true }; },
    open: async job => { calls.push(['open', job]); return { opened: true }; },
    ...overrides,
  };
  const ctx = { hasUI: true, ui: {
    select: async (title, choices) => {
      screens.push({ title, choices });
      const answer = answers.shift();
      return typeof answer === 'function' ? answer(choices) : typeof answer === 'number' ? choices[answer] : answer;
    },
    input: async title => { screens.push({ title }); return answers.shift(); },
  } };
  return { access, ctx, calls, screens, run: () => pickJobs(access, ctx) };
}

test('jobs enumerate and inspect a selected job without mutation', async () => {
  const h = harness([1, 'View details']);
  const result = await h.run();
  assert.equal(result.action, 'details');
  assert.equal(result.readOnly, true);
  assert.deepEqual(result.value, { detail: 'hub-1' });
  assert.deepEqual(h.calls.map(call => call[0]), ['list', 'details']);
  assert.match(h.screens[0].choices[0], /direct.*Parser review.*inProgress.*\/work/);
  assert.match(h.screens[0].choices[1], /Hub.*Hub review/);
});

test('cancelling enumeration, job actions or message input makes no mutations', async () => {
  for (const answers of [[undefined], ['Cancel'], [0, undefined], [0, 'Cancel'], [0, 'Send message', undefined], [0, 'Send message', '   ']]) {
    const h = harness(answers);
    assert.equal((await h.run()).cancelled, true);
    assert.deepEqual(h.calls.map(call => call[0]), ['list']);
  }
  const h = harness();
  h.ctx.hasUI = false;
  const result = await h.run();
  assert.deepEqual(result.value, [direct, hub]);
  assert.deepEqual(h.calls.map(call => call[0]), ['list']);
  assert.equal(h.screens.length, 0);
});

test('send preserves exact message and the selected turn while backend state changes', async () => {
  const changing = { ...direct };
  let delivered;
  const h = harness([0, () => {
    changing.turnId = 'new-turn';
    changing.threadId = 'new-thread';
    return 'Send message';
  }, '  Please inspect\nexact input  '], {
    list: async () => [changing],
    send: async (job, text) => { delivered = { job, text }; return 'accepted'; },
  });
  const result = await h.run();
  assert.equal(delivered.job.threadId, 'thread-1');
  assert.equal(delivered.job.turnId, 'turn-1');
  assert.equal(delivered.text, '  Please inspect\nexact input  ');
  assert.equal(result.job, delivered.job);
  assert.equal(result.value, 'accepted');
  assert.equal(result.readOnly, false);
});

test('send failures retain error identity and draft without retrying or retargeting', async () => {
  const error = Object.assign(new Error('Selected turn ended'), { code: 'STALE_TURN', outcomeUnknown: true });
  let count = 0;
  const h = harness([0, 'Send message', 'draft to retain'], {
    send: async () => { count++; throw error; },
  });
  const result = await h.run();
  assert.equal(count, 1);
  assert.equal(result.error, error);
  assert.equal(result.draft, 'draft to retain');
  assert.equal(result.job.turnId, 'turn-1');
  assert.equal(result.action, 'send');
});

test('interrupt and open dispatch once with the selected identity', async () => {
  for (const [answers, action] of [[[0, 'Interrupt'], 'cancel'], [[1, 'Open in Agent Hub'], 'open']]) {
    const h = harness(answers);
    const result = await h.run();
    assert.equal(result.action, action);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1][0], action);
    assert.equal(h.calls[1][1], result.job);
    assert.equal(result.job.turnId, 'turn-1');
  }
});

test('refresh and back read the latest list without mutating or keeping a registry', async () => {
  let reads = 0;
  const h = harness(['Refresh', 0, 'Back', 0, 'Refresh', 0, 'View details'], {
    list: async () => [{ ...direct, name: `snapshot ${++reads}` }],
  });
  const result = await h.run();
  assert.equal(reads, 4);
  assert.equal(result.job.name, 'snapshot 4');
  assert.deepEqual(h.calls.map(call => call[0]), ['details']);
});

test('capabilities omit unavailable actions and forged choices cannot call them', async () => {
  for (const [job, open] of [[{ ...direct, canSend: false, canCancel: false, canOpen: true }, true], [{ ...hub, canSend: false, canCancel: false, canOpen: false }, true], [{ ...hub, canSend: false, canCancel: false }, false]]) {
    const h = harness([0, 'Send message'], { list: async () => [job], ...(open ? {} : { open: undefined }) });
    assert.equal((await h.run()).cancelled, true);
    assert.deepEqual(h.screens[1].choices, ['View details', 'Refresh', 'Back', 'Cancel']);
    assert.equal(h.calls.length, 0);
  }
});

test('empty jobs permit refresh or cancellation and list errors are read-only', async () => {
  const h = harness(['Refresh', 'Cancel'], { list: async () => [] });
  assert.equal((await h.run()).cancelled, true);
  assert.deepEqual(h.screens[0].choices, ['Refresh', 'Cancel']);
  assert.match(h.screens[0].title, /no current jobs/);
  const failure = new Error('enumeration unavailable');
  const failed = harness([], { list: async () => { throw failure; } });
  const result = await failed.run();
  assert.equal(result.error, failure);
  assert.equal(result.readOnly, true);
});

test('all job titles and labels escape control and directional characters', async () => {
  const dirty = '\u001b[2J\u009b\u202e\u2066\n';
  const job = { ...direct, name: dirty, status: dirty, cwd: dirty, activity: dirty, threadId: dirty, turnId: dirty };
  const h = harness([0, 'Send message', undefined], { list: async () => [job] });
  await h.run();
  for (const screen of h.screens) {
    assert.doesNotMatch(screen.title, /[\u001b\u009b\u202e\u2066]/);
    if (screen.choices) for (const choice of screen.choices) assert.doesNotMatch(choice, /[\u001b\u009b\u202e\u2066\n]/);
  }
  assert.match(h.screens[0].choices[0], /\\u001b.*\\u202e/);
});
