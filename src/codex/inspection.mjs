import {
  TERMINAL, MODEL_PAGE_SIZE, MODEL_PAGES, MAX_TEXT, MAX_EVENT_TEXT, bounded, nonempty,
} from './protocol.mjs';

const TURN_STATUSES = new Set(['inProgress', ...TERMINAL]);
const ITEM_STATUSES = new Set(['inProgress', 'completed', 'failed', 'declined', 'interrupted']);
const CHANGE_KINDS = new Set(['add', 'delete', 'update']);
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const timestamp = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
// Opaque cursors are never truncated: a truncated cursor would address a different native page.
const validCursor = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');

function pageOptions({ cursor, limit = 25 } = {}) {
  if (cursor != null && !validCursor(cursor)) throw new TypeError('cursor must be a nonempty string of at most 4096 characters without NUL');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be an integer from 1 to 100');
  return { limit, ...(cursor == null ? {} : { cursor }) };
}

function nativePage(result, method, options) {
  if (!Array.isArray(result?.data) || result.data.length > options.limit
    || (result.nextCursor != null && (!validCursor(result.nextCursor) || result.nextCursor === options.cursor))
    || (result.backwardsCursor != null && !validCursor(result.backwardsCursor))) {
    throw new Error(`Codex ${method} returned an invalid page`);
  }
  return { data: result.data, nextCursor: result.nextCursor ?? null,
    ...(result.backwardsCursor === undefined ? {} : { backwardsCursor: result.backwardsCursor }) };
}

function threadMetadata(thread) {
  nonempty(thread?.id, 'thread.id');
  if (thread.id.length > 256) throw new Error('Codex returned an invalid thread ID');
  const result = { id: thread.id };
  for (const key of ['name', 'preview', 'cwd', 'model', 'modelProvider', 'cliVersion', 'reasoningEffort',
    'parentThreadId', 'forkedFromId', 'source', 'createdAt', 'updatedAt', 'status']) {
    if (thread[key] !== undefined) result[key] = bounded(thread[key], { left: 1024 });
  }
  return result;
}

function turnMetadata(turn) {
  nonempty(turn?.id, 'turn.id');
  if (turn.id.length > 256) throw new Error('Codex returned an invalid turn ID');
  return {
    id: turn.id, status: TURN_STATUSES.has(turn.status) ? turn.status : 'unknown',
    error: turn.error == null ? null : bounded(turn.error), items: [], itemsView: 'notLoaded',
    startedAt: timestamp(turn.startedAt), completedAt: timestamp(turn.completedAt), durationMs: timestamp(turn.durationMs),
    ...(typeof turn.rootTurnId === 'string' ? { rootTurnId: turn.rootTurnId.slice(0, 256) } : {}),
  };
}

// Semantic public projection selects valuable fields before generic bounded() limits incidental data.
// Native file events describe reported edits, not a complete filesystem audit. Diff retrieval is explicit.
export function projectItem(item, { includeDiff = false, textLimit = MAX_EVENT_TEXT } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return bounded(item);
  if (item.type === 'agentMessage') {
    const original = typeof item.text === 'string' ? item.text : '';
    const kept = original.slice(0, textLimit);
    return { type: 'agentMessage', id: text(item.id, 256), text: kept,
      textTruncated: item.textTruncated === true || kept.length < original.length,
      ...(item.phase === undefined ? {} : { phase: typeof item.phase === 'string' ? item.phase.slice(0, 64) : null }),
      ...(item.delivery === undefined ? {} : { delivery: typeof item.delivery === 'string' ? item.delivery.slice(0, 64) : null }),
      ...(item.questions === undefined ? {} : { questions: bounded(item.questions, { left: 2048 }) }),
      ...(item.memoryCitation === undefined ? {} : { memoryCitation: bounded(item.memoryCitation, { left: 512 }) }) };
  }
  if (item.type === 'commandExecution') {
    const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
    return {
      type: item.type, id: text(item.id, 256), status: ITEM_STATUSES.has(item.status) ? item.status : 'unknown',
      exitCode: Number.isSafeInteger(item.exitCode) ? item.exitCode : null,
      aggregatedOutput: output.slice(-4096), outputTruncated: item.outputTruncated === true || output.length > 4096,
      command: text(item.command, 1024), cwd: typeof item.cwd === 'string' ? item.cwd.slice(0, 1024) : null,
    };
  }
  if (item.type === 'fileChange') {
    let diffBudget = 4096;
    let metadataBudget = 4096;
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return {
      type: item.type, id: text(item.id, 256), status: ITEM_STATUSES.has(item.status) ? item.status : 'unknown',
      changes: changes.slice(0, 50).map(entry => {
        const change = entry && typeof entry === 'object' ? entry : {};
        const movePath = change.kind?.move_path ?? change.kind?.movePath ?? change.movePath;
        const diff = typeof change.diff === 'string' ? change.diff : '';
        const kept = includeDiff ? diff.slice(0, diffBudget) : '';
        diffBudget -= kept.length;
        const path = typeof change.path === 'string' ? change.path : '';
        const keptPath = path.slice(0, Math.min(512, metadataBudget));
        metadataBudget -= keptPath.length;
        const keptMove = typeof movePath === 'string' ? movePath.slice(0, Math.min(512, metadataBudget)) : undefined;
        metadataBudget -= keptMove?.length ?? 0;
        const kind = typeof change.kind === 'string' ? change.kind : change.kind?.type;
        const type = CHANGE_KINDS.has(kind) ? kind : 'unknown';
        return {
          path: keptPath,
          metadataTruncated: change.metadataTruncated === true || keptPath.length < path.length
            || (typeof movePath === 'string' && keptMove.length < movePath.length),
          kind: typeof change.kind === 'string' ? type : { type,
            ...(keptMove === undefined ? {} : { move_path: keptMove }) },
          ...(keptMove === undefined ? {} : { movePath: keptMove }),
          ...(includeDiff ? { diff: kept, diffTruncated: change.diffTruncated === true || kept.length < diff.length } : {}),
        };
      }),
      changesTruncated: item.changesTruncated === true || changes.length > 50,
    };
  }
  return bounded(item);
}

function recordMessage(state, id, value, phase) {
  if (typeof value !== 'string') return;
  const key = typeof id === 'string' ? id : 'agent-message';
  const old = state.messages.get(key);
  if (!old && state.messages.size >= 128) { state.textTruncated = true; return; }
  const kept = value.slice(0, MAX_TEXT - state.textSize + (old?.text.length ?? 0));
  if (kept.length < value.length) state.textTruncated = true;
  state.textSize += kept.length - (old?.text.length ?? 0);
  state.messages.set(key, { text: kept, phase: phase === undefined ? old?.phase : phase });
}

// Mutates only the supplied value. It has no client, ownership map, request registry or callbacks.
export function recordItem(state, item) {
  if (!item || typeof item !== 'object') return;
  if (item.type === 'agentMessage') {
    recordMessage(state, item.id, item.text ?? '', item.phase);
    if (item.textTruncated) state.textTruncated = true;
  } else if (item.type === 'fileChange') {
    const projected = projectItem(item);
    const index = state.fileChanges.findIndex(entry => entry.id === projected.id);
    if (index >= 0) state.fileChanges[index] = projected;
    else {
      state.fileChanges.push(projected);
      if (state.fileChanges.length > 50) state.fileChanges.shift();
    }
  } else if (item.type === 'commandExecution' && (item.status === 'failed'
    || (Number.isSafeInteger(item.exitCode) && item.exitCode !== 0))) {
    const projected = projectItem(item);
    state.commandFailure = { itemId: projected.id, command: projected.command, exitCode: projected.exitCode,
      outputTail: projected.aggregatedOutput, outputTruncated: projected.outputTruncated };
  }
}

export function threadSnapshot(state) {
  const messages = [...state.messages.values()];
  const answers = messages.filter(message => message.phase == null || message.phase === 'partial_answer' || message.phase === 'final_answer');
  const final = messages.filter(message => message.phase === 'final_answer');
  return {
    threadId: state.threadId, turnId: state.turnId, status: state.status,
    text: (answers.length ? answers : messages).map(message => message.text).join('\n\n').slice(0, MAX_TEXT),
    finalText: final.length ? final.map(message => message.text).join('\n\n').slice(0, MAX_TEXT)
      : messages.findLast(message => message.phase == null)?.text ?? '',
    textTruncated: state.textTruncated, events: structuredClone(state.events),
    error: state.error, outcomeUnknown: state.outcomeUnknown,
    cwd: state.cwd, model: state.model, inspection: state.inspection, attached: state.attached,
    requestedReasoningEffort: state.requestedReasoningEffort,
    execution: { model: state.model, cwd: state.cwd, requestedReasoningEffort: state.requestedReasoningEffort },
    latestActivity: structuredClone(state.latestActivity), latestPlan: structuredClone(state.latestPlan),
    fileChanges: structuredClone(state.fileChanges), commandFailure: structuredClone(state.commandFailure),
    tokenUsage: structuredClone(state.tokenUsage), tokenUsageTurnId: state.tokenUsageTurnId,
    turnUsage: structuredClone(state.turnUsage),
  };
}

function historySnapshot(threadId, thread, turn, items = []) {
  const state = {
    threadId, turnId: turn?.id ?? null,
    status: turn ? (TURN_STATUSES.has(turn.status) ? turn.status : 'unknown')
      : thread.status?.type === 'idle' ? 'idle' : thread.status?.type === 'systemError' ? 'failed' : 'unknown',
    error: turn?.error == null ? null : typeof turn.error.message === 'string'
      ? turn.error.message.slice(0, MAX_EVENT_TEXT) : JSON.stringify(bounded(turn.error)),
    cwd: typeof thread.cwd === 'string' ? thread.cwd : null, model: typeof thread.model === 'string' ? thread.model : null,
    inspection: 'history', attached: false, requestedReasoningEffort: null, outcomeUnknown: false,
    latestActivity: null, latestPlan: null, fileChanges: [], commandFailure: null,
    messages: new Map(), textSize: 0, textTruncated: false, events: [],
    tokenUsage: null, tokenUsageTurnId: null, turnUsage: null,
  };
  for (const item of items) recordItem(state, item);
  return threadSnapshot(state);
}

async function readThreadMetadata(client, threadId) {
  const read = await client._request('thread/read', { threadId, includeTurns: false });
  if (read?.thread?.id !== threadId) throw new Error('Codex thread/read returned an unexpected thread');
  return threadMetadata(read.thread);
}

async function readTurns(client, threadId, options) {
  const page = nativePage(await client._request('thread/turns/list', {
    threadId, ...options, sortDirection: 'desc', itemsView: 'notLoaded',
  }), 'thread/turns/list', options);
  return { ...page, data: page.data.map(turnMetadata) };
}

async function readItems(client, threadId, turnId, options, projection) {
  const page = nativePage(await client._request('thread/items/list', {
    threadId, turnId, ...options, sortDirection: 'asc',
  }), 'thread/items/list', options);
  return { ...page, data: page.data.map(entry => {
    if (entry?.turnId !== turnId || !entry.item || typeof entry.item !== 'object' || Array.isArray(entry.item)) {
      throw new Error('Codex thread/items/list returned an invalid item');
    }
    return { turnId, item: projectItem(entry.item, projection),
      startedAtMs: timestamp(entry.startedAtMs), completedAtMs: timestamp(entry.completedAtMs) };
  }) };
}

export async function listThreads(client, { cursor, limit, searchTerm, cwd } = {}) {
  const options = pageOptions({ cursor, limit });
  if (searchTerm !== undefined) nonempty(searchTerm, 'searchTerm');
  if (cwd !== undefined) nonempty(cwd, 'cwd');
  await client.connect();
  const page = nativePage(await client._request('thread/list', {
    ...options, sortKey: 'updated_at', sortDirection: 'desc',
    ...(searchTerm === undefined ? {} : { searchTerm }), ...(cwd === undefined ? {} : { cwd }),
  }), 'thread/list', options);
  return { ...page, data: page.data.map(threadMetadata) };
}

export async function getThreadDetails(client, threadId, { includeItems = false, turnId, cursor, limit, includeDiff = false } = {}) {
  nonempty(threadId, 'threadId');
  if (turnId !== undefined) nonempty(turnId, 'turnId');
  if (typeof includeItems !== 'boolean' || typeof includeDiff !== 'boolean') throw new TypeError('includeItems and includeDiff must be booleans');
  if (includeDiff) includeItems = true;
  const options = pageOptions({ cursor, limit });
  await client.connect();
  const thread = await readThreadMetadata(client, threadId);
  const turns = await readTurns(client, threadId, includeItems ? { limit: 1 } : options);
  const selected = turns.data[0];
  const selectedId = turnId ?? selected?.id;
  const items = includeItems ? selectedId
    ? await readItems(client, threadId, selectedId, options, { includeDiff }) : { data: [], nextCursor: null } : undefined;
  const snapshot = historySnapshot(threadId, thread, selected,
    selectedId === selected?.id ? items?.data.map(entry => entry.item) : []);
  return { thread, snapshot, turns, ...(items ? { items } : {}) };
}

export async function readLastTurn(client, threadId) {
  const turn = (await readTurns(client, threadId, { limit: 1 })).data[0];
  if (!turn) return undefined;
  const items = [];
  const cursors = new Set();
  let cursor;
  let textBudget = MAX_TEXT;
  for (let page = 0; page < 1000; page++) {
    // One item per page avoids hydrating a whole turn's command output into a single JSONL payload.
    const result = await readItems(client, threadId, turn.id, { limit: 1, ...(cursor === undefined ? {} : { cursor }) }, { textLimit: textBudget });
    for (const { item } of result.data) {
      if (item.type === 'agentMessage') {
        textBudget -= item.text.length;
        items.push(item);
      } else if (item.type === 'fileChange' || (item.type === 'commandExecution'
        && (item.status === 'failed' || (Number.isSafeInteger(item.exitCode) && item.exitCode !== 0)))) items.push(item);
    }
    cursor = result.nextCursor;
    if (cursor == null) return { ...turn, items };
    if (cursors.has(cursor)) throw new Error('Codex thread/items/list returned an invalid or repeated cursor');
    cursors.add(cursor);
  }
  throw new Error('Codex thread/items/list exceeded 1000 pages');
}

export async function inspectThreadStatus(client, threadId) {
  await client.connect();
  const turn = await readLastTurn(client, threadId);
  const thread = await readThreadMetadata(client, threadId);
  return historySnapshot(threadId, thread, turn, turn?.items);
}

function unavailable(error) {
  const code = typeof error?.code === 'number' || typeof error?.code === 'string' ? error.code : 'UNAVAILABLE';
  // Native diagnostic errors can contain provider/config secrets; expose the code, not arbitrary text.
  return { status: 'unavailable', error: { code, message: code === -32601 ? 'Native method is not supported'
    : code === 'INVALID_RESPONSE' ? 'Native response is invalid' : 'Native diagnostic is unavailable' } };
}

async function diagnostic(operation) {
  try { return { status: 'available', value: await operation() }; }
  catch (error) { return unavailable(error); }
}

function requireResponse(condition) {
  if (!condition) throw Object.assign(new Error('Invalid native diagnostic response'), { code: 'INVALID_RESPONSE' });
}

function quotaSnapshot(value) {
  requireResponse(value && typeof value === 'object' && !Array.isArray(value));
  const result = {};
  for (const key of ['limitId', 'limitName', 'normalModelSlug', 'planType', 'rateLimitReachedType', 'spendControlReached']) {
    if (value[key] !== undefined) result[key] = bounded(value[key], { left: 256 });
  }
  for (const key of ['primary', 'secondary']) {
    const window = value[key];
    if (window == null) { result[key] = null; continue; }
    requireResponse(Number.isFinite(window.usedPercent));
    result[key] = { usedPercent: window.usedPercent,
      windowDurationMins: timestamp(window.windowDurationMins), resetsAt: timestamp(window.resetsAt) };
  }
  return result;
}

export async function listModels(client) {
  await client.connect();
  const models = new Map();
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < MODEL_PAGES; page++) {
    const options = { limit: MODEL_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) };
    const result = nativePage(await client._request('model/list', options), 'model/list', options);
    for (const entry of result.data) {
      const model = entry?.model;
      if (typeof model !== 'string' || !model.trim() || model.length > 256 || model.includes('\0') || models.has(model)) continue;
      models.set(model, {
        model, displayName: typeof entry.displayName === 'string' ? entry.displayName.slice(0, 256) : model,
        isDefault: entry.isDefault === true, hidden: entry.hidden === true,
        ...(entry.supportedReasoningEfforts === undefined ? {} : { supportedReasoningEfforts: bounded(entry.supportedReasoningEfforts) }),
        ...(entry.inputModalities === undefined ? {} : { inputModalities: bounded(entry.inputModalities) }),
        ...(entry.contextWindow === undefined ? {} : { contextWindow: timestamp(entry.contextWindow) }),
      });
    }
    cursor = result.nextCursor;
    if (cursor == null) return [...models.values()];
    if (cursors.has(cursor)) throw new Error('Codex model/list returned an invalid or repeated cursor');
    cursors.add(cursor);
  }
  throw new Error(`Codex model/list exceeded ${MODEL_PAGES} pages`);
}

// Read-only diagnostics never refresh authentication, adopt threads or replay a failed request.
export async function inspectConnection(client) {
  try { await client.connect(); }
  catch (error) {
    const report = unavailable(error);
    return { connection: report, auth: report, models: report, rateLimits: report, permissions: report };
  }
  const [auth, models, rateLimits, config, requirements] = await Promise.all([
    diagnostic(async () => {
      const value = await client._request('account/read', { refreshToken: false });
      requireResponse(typeof value?.requiresOpenaiAuth === 'boolean'
        && (value.account == null || typeof value.account?.type === 'string'));
      return { authenticated: value.account != null, mode: value.account?.type?.slice(0, 64) ?? null,
        requiresOpenaiAuth: value.requiresOpenaiAuth };
    }),
    diagnostic(() => listModels(client)),
    diagnostic(async () => {
      const value = await client._request('account/rateLimits/read', {});
      const result = { rateLimits: quotaSnapshot(value?.rateLimits),
        ordinaryUsageAllowed: typeof value.ordinaryUsageAllowed === 'boolean' ? value.ordinaryUsageAllowed : null };
      if (value.rateLimitsByLimitId != null) {
        requireResponse(typeof value.rateLimitsByLimitId === 'object' && !Array.isArray(value.rateLimitsByLimitId));
        const entries = Object.entries(value.rateLimitsByLimitId);
        result.rateLimitsByLimitId = Object.fromEntries(entries.slice(0, 50)
          .map(([key, entry]) => [key.slice(0, 128), quotaSnapshot(entry)]));
        result.bucketsTruncated = entries.length > 50;
      }
      return result;
    }),
    diagnostic(async () => {
      const value = (await client._request('config/read', { includeLayers: false }))?.config;
      requireResponse(value && typeof value === 'object' && !Array.isArray(value));
      return bounded({ sandboxMode: value.sandbox_mode ?? null, approvalPolicy: value.approval_policy ?? null,
        model: value.model ?? null, modelReasoningEffort: value.model_reasoning_effort ?? null });
    }),
    diagnostic(async () => {
      const result = await client._request('configRequirements/read', {});
      requireResponse(result && Object.hasOwn(result, 'requirements'));
      const value = result.requirements;
      requireResponse(value === null || (value && typeof value === 'object' && !Array.isArray(value)));
      return value == null ? null : bounded({ allowedApprovalPolicies: value.allowedApprovalPolicies ?? null,
        allowedSandboxModes: value.allowedSandboxModes ?? null });
    }),
  ]);
  return { connection: { status: 'available', ...client._transport.connectionInfo }, auth, models, rateLimits,
    permissions: { status: 'available', value: { config, requirements } } };
}
