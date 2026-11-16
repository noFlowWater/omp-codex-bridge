import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';

const ENV_KEYS = ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'CODEX_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
// Refusals of one thread's effective settings; the transport stays usable.
const REFUSED_CODES = new Set(['PERMISSION_UNSAFE', 'PERMISSION_STRICTER', 'MODEL_MISMATCH']);
const MODEL_PAGE_SIZE = 100;
const MODEL_PAGES = 20;
// Native userMessage items can echo attached data URLs. Bound each JSONL message, including those echoes.
const MAX_LINE = 64 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const MAX_EVENT_TEXT = 8192;
const LINE_TOO_LONG = 'Codex stdout JSONL line exceeded 64 MiB';
const USAGE_KEYS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
const OPT_OUT = [
  'item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated', 'turn/diff/updated',
];


function bounded(value, budget = { left: MAX_EVENT_TEXT }, depth = 0) {
  if (typeof value === 'string') {
    const text = value.slice(0, Math.max(0, budget.left));
    budget.left -= text.length;
    return text.length < value.length ? `${text}…` : text;
  }
  if (value === null || typeof value !== 'object') {
    budget.left -= 8;
    return budget.left >= 0 ? value : '[truncated]';
  }
  if (depth >= 6 || budget.left <= 0) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map(entry => bounded(entry, budget, depth + 1));
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 50)) {
    if (budget.left <= 0) break;
    budget.left -= Math.min(key.length, 128) + 4;
    Object.defineProperty(result, key.slice(0, 128), {
      value: bounded(entry, budget, depth + 1), enumerable: true, configurable: true, writable: true,
    });
  }
  return result;
}

function nonempty(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError(`${name} must be a nonempty string without NUL characters`);
  }
  return value;
}
function jsonValue(value, name) {
  const text = JSON.stringify(value, (_key, entry) => {
    if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol'
      || (typeof entry === 'number' && !Number.isFinite(entry))) throw new TypeError(`${name} must contain only JSON values`);
    return entry;
  });
  if (text === undefined) throw new TypeError(`${name} must be a JSON value`);
  return JSON.parse(text);
}

function userInput(prompt, input) {
  if (input === undefined) return [{ type: 'text', text: nonempty(prompt, 'prompt') }];
  if (prompt !== undefined) throw new TypeError('Supply prompt or input, not both');
  if (!Array.isArray(input) || !input.length) throw new TypeError('input must be a nonempty native UserInput array');
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('input entries must be native UserInput objects');
    if (entry.type === 'text') {
      if (typeof entry.text !== 'string' || entry.text.includes('\0')) throw new TypeError('input text must be a string without NUL characters');
      if (entry.text_elements !== undefined) {
        if (!Array.isArray(entry.text_elements)) throw new TypeError('text_elements must be an array');
        for (const element of entry.text_elements) {
          const range = element?.byteRange;
          if (!Number.isSafeInteger(range?.start) || !Number.isSafeInteger(range?.end)
            || range.start < 0 || range.end < range.start || range.end > Buffer.byteLength(entry.text)
            || (element.placeholder != null && typeof element.placeholder !== 'string')) {
            throw new TypeError('text_elements require valid UTF-8 byte ranges and optional string placeholders');
          }
        }
      }
    } else if (entry.type === 'image') {
      if ((entry.url === undefined) === (entry.fileId === undefined)) throw new TypeError('image requires exactly one url or fileId');
      nonempty(entry.url ?? entry.fileId, 'image source');
    } else if (entry.type === 'localImage') nonempty(entry.path, 'localImage.path');
    else throw new TypeError(`Unsupported native input type: ${entry.type}`);
    if (entry.detail != null && !['auto', 'low', 'high', 'original'].includes(entry.detail)) {
      throw new TypeError('image detail must be auto, low, high or original');
    }
  }
  return jsonValue(input, 'input');
}

function usageBreakdown(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid native token usage');
  for (const key of USAGE_KEYS) {
    if (key === 'cacheWriteInputTokens' && value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new TypeError(`Invalid native token usage ${key}`);
  }
  return { ...value };
}

function aborted() {
  return Object.assign(new Error('Codex operation aborted'), { name: 'AbortError' });
}

function checkSignal(signal) {
  if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
    throw new TypeError('signal must be an AbortSignal');
  }
  if (signal?.aborted) throw aborted();
}


function validateThreadOptions({ threadId, cwd, model, onThread, sandbox, developerInstructions }) {
  if (threadId !== undefined) nonempty(threadId, 'threadId');
  if (cwd !== undefined) nonempty(cwd, 'cwd');
  if (model !== undefined) nonempty(model, 'model');
  if (developerInstructions !== undefined && typeof developerInstructions !== 'string') throw new TypeError('developerInstructions must be a string');
  if (onThread !== undefined && typeof onThread !== 'function') throw new TypeError('onThread must be a function');
  if (sandbox !== undefined) throw new TypeError('sandbox is not configurable; every Codex thread runs workspace-write in its cwd');
}

function rpcError(payload) {
  const error = new Error(typeof payload?.message === 'string' ? payload.message.slice(0, MAX_EVENT_TEXT) : 'Codex RPC failed');
  error.code = payload?.code;
  if (payload?.data !== undefined) error.data = bounded(payload.data);
  return error;
}

// Names the thread without mutating an error object shared by coalesced callers.
function withThread(error, threadId) {
  if (error?.threadId === threadId) return error;
  return Object.assign(new Error(error?.message ?? String(error), { cause: error }), {
    code: error?.code, outcomeUnknown: error?.outcomeUnknown, threadId,
  });
}

// Every thread requests workspace-write at cwd, networkAccess:false and approvals never. The guard
// checks native effective settings; it does not override Codex trusted rules, MCP servers or hooks.
// thread/start, resume and fork accept a sandbox mode; turn/start also excludes temporary roots.
// Effective read-only is refused rather than silently accepting fewer rights than requested.
const SANDBOX = 'workspace-write';
function permissionError(result, cwd) {
  const policy = result?.sandbox;
  const roots = policy?.writableRoots;
  const base = result?.approvalPolicy === 'never' && typeof result.cwd === 'string' && resolve(result.cwd) === cwd
    && policy?.networkAccess === false;
  if (base && policy.type === 'workspaceWrite' && Array.isArray(roots)
    && roots.every(root => typeof root === 'string' && resolve(root) === cwd)) return null;
  const stricter = base && policy.type === 'readOnly';
  const error = new Error(stricter
    ? 'Codex enforces a read-only sandbox for this workspace-write request; no turn started'
    : 'Codex reported an effective cwd, approval policy or sandbox wider than requested or unclear; no turn started');
  error.code = stricter ? 'PERMISSION_STRICTER' : 'PERMISSION_UNSAFE';
  return error;
}

function blankState(threadId) {
  return {
    threadId, turnId: null, status: 'idle', error: null, outcomeUnknown: false,
    cwd: null, model: null, developerInstructions: undefined,
    tokenUsage: null, tokenUsageTurnId: null, usageBaseline: null, turnUsage: null,
    events: [], messages: new Map(), textSize: 0, textTruncated: false,
    asyncQuestions: new Set(),
    retired: new Set(), uncertain: null, interruptRequested: null, attached: false, published: null,
  };
}

export class CodexNativeClient {
  // onNotification(method, boundedParams) observes owned-thread notifications (item progress for
  // provider streaming); the default subscriber API stays the lightweight {threadId, turnId, status}.
  constructor({ command = ['codex', 'app-server', '--stdio'], timeoutMs = 30000, env, onNotification, onRequest } = {}) {
    if (onNotification !== undefined && typeof onNotification !== 'function') throw new TypeError('onNotification must be a function');
    if (onRequest !== undefined && typeof onRequest !== 'function') throw new TypeError('onRequest must be a function');
    if (!Array.isArray(command) || !command.length) throw new TypeError('command must be a nonempty string array');
    command.forEach((part, index) => nonempty(part, `command[${index}]`));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
      throw new TypeError('timeoutMs must be positive and at most 2147483647');
    }
    if (env !== undefined && (env === null || typeof env !== 'object' || Array.isArray(env))) {
      throw new TypeError('env must be an object');
    }
    this.command = [...command];
    this.timeoutMs = timeoutMs;
    this.env = {};
    for (const key of ENV_KEYS) {
      const value = env && Object.hasOwn(env, key) ? env[key] : process.env[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || value.includes('\0')) throw new TypeError(`env.${key} must be a string without NUL characters`);
      this.env[key] = value;
    }
    this._process = null;
    this._connectPromise = null;
    this._closePromise = null;
    this._closed = false;
    this._failure = null;
    this._nextId = 1;
    this._pending = new Map();
    this._threads = new Map();
    this._queues = new Map();
    this._listeners = new Set();
    this._stdout = '';
    this._stdoutBytes = 0;
    this._onNotification = onNotification;
    this._onRequest = onRequest;
    this._serverRequests = new Map();
    this._compactions = new Map();
  }

  connect() {
    if (this._closed) return Promise.reject(new Error('Codex client is closed'));
    // A failed transport is replaced once per call, coalesced across callers. Thread ownership and
    // uncertain outcomes survive the replacement; nothing is resubmitted.
    if (!this._connectPromise || this._failure) this._connectPromise = this._initialize();
    return this._connectPromise;
  }

  async _initialize() {
    let child;
    try {
      child = spawn(this.command[0], this.command.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'], env: this.env, windowsHide: true,
      });
      Object.assign(this, { _process: child, _failure: null, _stdout: '', _stdoutBytes: 0 });
      // Late events from a replaced process must never fail its successor.
      const fail = error => { if (this._process === child) this._fail(error); };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { if (this._process === child) this._consume(chunk); });
      // Drained, never retained or echoed: stderr may contain credentials.
      child.stderr.resume();
      child.stdin.on('error', error => fail(new Error(`Codex stdin failed: ${error.message}`)));
      child.stdout.on('error', error => fail(new Error(`Codex stdout failed: ${error.message}`)));
      child.stderr.on('error', error => fail(new Error(`Codex stderr failed: ${error.message}`)));
      child.on('error', error => fail(new Error(`Codex app-server failed: ${error.message}`)));
      child.on('close', (code, signal) => {
        if (this._process !== child) return;
        if (this._stdout.trim()) this._consume('\n');
        this._fail(new Error(`Codex app-server disconnected (code ${code}, signal ${signal ?? 'none'})`));
      });
      await this._rpc('initialize', {
        clientInfo: { name: 'omp_codex_bridge', version: '1.0.0' },
        // Final agent text arrives with item/completed; partial text is not streamed.
        capabilities: { optOutNotificationMethods: OPT_OUT },
      });
      this._send({ method: 'initialized', params: {} });
    } catch (error) {
      if (!child || this._process === child) this._fail(error);
      throw error;
    }
  }

  // Listeners receive { threadId, turnId, status } whenever that pair changes; read snapshot() for details.
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  // Read-only native model/list catalog (default picker list), every page; never touches a thread.
  async listModels() {
    await this.connect();
    const models = new Map();
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < MODEL_PAGES; page++) {
      const result = await this._rpc('model/list', { limit: MODEL_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) });
      if (!Array.isArray(result?.data)) throw new Error('Codex model/list returned no model list');
      for (const entry of result.data) {
        const model = entry?.model;
        if (typeof model !== 'string' || !model.trim() || model.includes('\0') || models.has(model)) continue;
        models.set(model, {
          model, displayName: typeof entry.displayName === 'string' ? entry.displayName : model,
          isDefault: entry.isDefault === true, hidden: entry.hidden === true,
          ...(entry.supportedReasoningEfforts === undefined ? {} : { supportedReasoningEfforts: structuredClone(entry.supportedReasoningEfforts) }),
          ...(entry.inputModalities === undefined ? {} : { inputModalities: structuredClone(entry.inputModalities) }),
          ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
        });
      }
      cursor = result.nextCursor;
      if (cursor === undefined || cursor === null) return [...models.values()];
      if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error('Codex model/list returned an invalid or repeated cursor');
      cursors.add(cursor);
    }
    throw new Error(`Codex model/list exceeded ${MODEL_PAGES} pages`);
  }

  snapshot(threadId) {
    if (threadId !== undefined) {
      const state = this._threads.get(threadId);
      return state ? this._snapshot(state) : undefined;
    }
    return [...this._threads.values()].map(state => this._snapshot(state));
  }

  // Read-only: never resumes, starts, steers or interrupts.
  async status(threadId) {
    if (threadId === undefined) return this.snapshot();
    nonempty(threadId, 'threadId');
    const state = this._threads.get(threadId);
    if (state) {
      if (state.outcomeUnknown || (state.status === 'inProgress' && !state.turnId)) {
        try {
          await this.connect();
          await this._reconcile(state);
        } catch { /* The snapshot keeps reporting the unconfirmed outcome. */ }
      }
      return this._snapshot(state);
    }
    await this.connect();
    // Persisted last turn of a thread this client does not own; it is neither resumed nor registered.
    const view = blankState(threadId);
    const turn = await this._lastTurn(threadId);
    if (turn) this._turn(view, turn);
    return this._snapshot(view);
  }

  _snapshot(state) {
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
      cwd: state.cwd, model: state.model,
      tokenUsage: structuredClone(state.tokenUsage), tokenUsageTurnId: state.tokenUsageTurnId,
      turnUsage: structuredClone(state.turnUsage),
    };
  }

  _publish(state, quiet = false) {
    const key = `${state.turnId}\0${state.status}`;
    if (state.published === key) return;
    state.published = key;
    if (quiet) return;
    for (const listener of this._listeners) {
      try {
        const result = listener({ threadId: state.threadId, turnId: state.turnId, status: state.status });
        if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
      } catch { /* A host listener must never break the transport. */ }
    }
  }

  _state(threadId) {
    let state = this._threads.get(threadId);
    if (!state) this._threads.set(threadId, state = blankState(threadId));
    return state;
  }

  _serialize(key, operation) {
    const task = (this._queues.get(key) ?? Promise.resolve()).then(operation);
    const tail = task.catch(() => {});
    this._queues.set(key, tail);
    tail.then(() => { if (this._queues.get(key) === tail) this._queues.delete(key); });
    return task;
  }
  // Shared native metadata admission. Starting/resuming a thread never submits user input.
  async _load({ threadId, cwd, model, developerInstructions }) {
    let state = threadId ? this._threads.get(threadId) : undefined;
    try {
      if (cwd !== undefined && !isAbsolute(cwd)) throw new TypeError('cwd must be an absolute existing directory');
      const directory = await realpath(cwd ?? state?.cwd ?? process.cwd());
      if (!(await stat(directory)).isDirectory()) throw new TypeError('cwd must be an absolute existing directory');
      if (state?.attached && (directory !== state.cwd || (model !== undefined && model !== state.model))) {
        throw new Error('A loaded thread has immutable cwd and model; start a new thread to change them');
      }
      if (state?.attached && developerInstructions !== undefined && developerInstructions !== state.developerInstructions) {
        throw new Error('A loaded thread has immutable developerInstructions; start a new thread to change them');
      }
      await this.connect();
      if (state?.outcomeUnknown) await this._reconcile(state);
      if (!state?.attached) {
        const created = threadId !== undefined && !state;
        // A resumed thread is owned before the request, so no early notification is lost.
        if (threadId) state = this._state(threadId);
        try {
          await this._rpc(threadId ? 'thread/resume' : 'thread/start', {
            cwd: directory, sandbox: SANDBOX, approvalPolicy: 'never', ...(model === undefined ? {} : { model }),
            ...(developerInstructions === undefined ? {} : { developerInstructions }),
            ...(threadId ? { threadId, excludeTurns: true } : {}),
          }, {
            state, mutation: true,
            onResult: (result, request) => {
              const id = nonempty(result?.thread?.id, 'response.thread.id');
              if (threadId && id !== threadId) throw new Error('Codex resumed an unexpected thread');
              state = this._state(id);
              const denied = permissionError(result, directory)
                // An explicit model is the thread's model; Codex silently using another one gets no turn.
                ?? (model !== undefined && typeof result.model === 'string' && result.model !== model
                  ? Object.assign(new Error(`Codex reported model ${result.model} for requested model ${model}; no turn started`), { code: 'MODEL_MISMATCH' })
                  : null);
              if (denied) {
                denied.threadId = id;
                state.error = denied.message;
                throw denied;
              }
              Object.assign(state, { cwd: directory, model: model ?? result.model ?? null, developerInstructions, attached: true });
              if (!threadId) state.usageBaseline = Object.fromEntries(USAGE_KEYS.map(key => [key, 0]));
              this._known(state, request.id);
              this._threadState(state, result.thread);
              // Nobody awaits a timed-out start; mark the orphan so status listings identify it.
              if (request.timedOut && !threadId) state.error = 'Codex thread/start response arrived after its timeout; no turn was started';
              this._publish(state);
            },
          });
        } catch (error) {
          // A definitely rejected resume leaves no local owner for an ID this client never held.
          if (created && !state.attached && error.outcomeUnknown !== true && !REFUSED_CODES.has(error.code)) {
            this._threads.delete(threadId);
          }
          throw error;
        }
      }
      if (!state.attached) throw new Error(`Thread ${state.threadId} was detached before a turn could start; no turn started`);
      return state;
    } catch (error) {
      throw state ? withThread(error, state.threadId) : error;
    }
  }

  // Metadata-only attachment for native lifecycle operations after reload. No turn, steer or history replay.
  async resume({ threadId, cwd, model, developerInstructions, onThread, sandbox, ...unsupported } = {}) {
    nonempty(threadId, 'threadId');
    if (Object.keys(unsupported).length) throw new TypeError('resume accepts thread metadata only');
    validateThreadOptions({ threadId, cwd, model, developerInstructions, onThread, sandbox });
    return this._serialize(threadId, async () => {
      const state = await this._load({ threadId, cwd, model, developerInstructions });
      try {
        if (onThread) await onThread(state.threadId);
        return this._snapshot(state);
      } catch (error) {
        throw withThread(error, state.threadId);
      }
    });
  }


  // onThread(threadId) runs once the thread ID is confirmed and before any turn request, so a
  // caller can record the authoritative native ID first; if it throws, no turn is requested.
  // The sandbox is always workspace-write (see permissionError); a caller-chosen sandbox is refused.
  async run({ threadId, prompt, input, cwd, model, onThread, sandbox, effort, outputSchema, developerInstructions } = {}) {
    input = userInput(prompt, input);
    if (effort !== undefined) nonempty(effort, 'effort');
    if (outputSchema !== undefined) {
      if (!outputSchema || typeof outputSchema !== 'object' || Array.isArray(outputSchema)) throw new TypeError('outputSchema must be a JSON Schema object');
      outputSchema = jsonValue(outputSchema, 'outputSchema');
    }
    validateThreadOptions({ threadId, cwd, model, developerInstructions, onThread, sandbox });
    return this._serialize(threadId ?? Symbol('new thread'), async () => {
      let state = threadId ? this._threads.get(threadId) : undefined;
      if (threadId && this._compactions.has(threadId)) throw new Error('Native compaction is still in progress; no input sent');
      try {
        state = await this._load({ threadId, cwd, model, developerInstructions });
        const directory = state.cwd;
        if (onThread) await onThread(state.threadId);
        if (state.status === 'inProgress' && (effort !== undefined || outputSchema !== undefined)) {
          throw new Error('effort and outputSchema cannot change an active turn through turn/steer');
        }
        if (state.status === 'inProgress' && !state.turnId) await this._reconcile(state);
        if (state.status === 'inProgress') {
          await this._steer(state, input);
        } else {
          this._resetTurn(state);
          state.status = 'inProgress';
          this._publish(state);
          try {
            await this._rpc('turn/start', {
              threadId: state.threadId, input, cwd: directory, approvalPolicy: 'never',
              sandboxPolicy: {
                type: 'workspaceWrite', writableRoots: [directory], networkAccess: false,
                excludeTmpdirEnvVar: true, excludeSlashTmp: true,
              },
              ...(model === undefined ? {} : { model }),
              ...(effort === undefined ? {} : { effort }),
              ...(outputSchema === undefined ? {} : { outputSchema }),
            }, {
              state, mutation: true,
              onResult: (result, request) => {
                if (!result?.turn?.id) throw new Error('Codex turn/start response has no turn ID');
                this._turn(state, result.turn);
                this._known(state, request.id);
                this._publish(state);
              },
            });
          } catch (error) {
            if (!error.outcomeUnknown && state.status === 'inProgress' && !state.turnId) {
              state.status = 'failed';
              state.error = error.message;
              // The caller's rejection reports this unadmitted turn; no terminal notification duplicates it.
              this._publish(state, true);
            }
            throw error;
          }
        }
        return this._snapshot(state);
      } catch (error) {
        throw state ? withThread(error, state.threadId) : error;
      }
    });
  }
  // Forks native history through lastTurnId (inclusive), never submits input or adopts the source.
  async fork({ threadId, lastTurnId, cwd, model, developerInstructions, onThread, sandbox } = {}) {
    nonempty(threadId, 'threadId');
    if (lastTurnId !== undefined) nonempty(lastTurnId, 'lastTurnId');
    if (cwd !== undefined) nonempty(cwd, 'cwd');
    if (model !== undefined) nonempty(model, 'model');
    if (developerInstructions !== undefined && typeof developerInstructions !== 'string') throw new TypeError('developerInstructions must be a string');
    if (onThread !== undefined && typeof onThread !== 'function') throw new TypeError('onThread must be a function');
    if (sandbox !== undefined) throw new TypeError('sandbox is not configurable');
    return this._serialize(threadId, async () => {
      const source = this._threads.get(threadId);
      if (source?.outcomeUnknown) throw new Error('Cannot fork a thread with an unconfirmed mutation');
      if (cwd !== undefined && !isAbsolute(cwd)) throw new TypeError('cwd must be an absolute existing directory');
      const directory = await realpath(cwd ?? source?.cwd ?? process.cwd());
      if (!(await stat(directory)).isDirectory()) throw new TypeError('cwd must be an absolute existing directory');
      if (source?.cwd && source.cwd !== directory) throw new Error('A fork must preserve its source cwd');
      model ??= source?.model ?? undefined;
      developerInstructions ??= source?.developerInstructions;
      await this.connect();
      let forked;
      try {
        await this._rpc('thread/fork', {
          threadId, ...(lastTurnId === undefined ? {} : { lastTurnId }),
          cwd: directory, sandbox: SANDBOX, approvalPolicy: 'never', excludeTurns: true,
          ...(model === undefined ? {} : { model }),
          ...(developerInstructions === undefined ? {} : { developerInstructions }),
        }, {
          mutation: true,
          onResult: (result, request) => {
            const id = nonempty(result?.thread?.id, 'response.thread.id');
            if (id === threadId || this._threads.has(id)) throw new Error('Codex fork returned an existing thread ID');
            forked = this._state(id);
            const denied = permissionError(result, directory)
              ?? (model !== undefined && typeof result.model === 'string' && result.model !== model
                ? Object.assign(new Error('Codex fork reported a different model; no turn started'), { code: 'MODEL_MISMATCH' }) : null);
            if (denied) {
              forked.error = denied.message;
              throw withThread(denied, id);
            }
            Object.assign(forked, { cwd: directory, model: model ?? result.model ?? null, developerInstructions, attached: true });
            this._threadState(forked, result.thread);
            if (request.timedOut) forked.error = 'Codex thread/fork response arrived after its timeout; no turn was started';
            this._publish(forked);
          },
        });
        if (onThread) await onThread(forked.threadId);
        return this._snapshot(forked);
      } catch (error) {
        throw forked ? withThread(error, forked.threadId) : error;
      }
    });
  }

  // Native admission is immediate; completion comes only from the new compaction turn's lifecycle.
  async compact(threadId, { signal } = {}) {
    if (threadId && typeof threadId === 'object') ({ threadId, signal } = threadId);
    nonempty(threadId, 'threadId');
    checkSignal(signal);
    let operation;
    await this._serialize(threadId, async () => {
      checkSignal(signal);
      const state = this._threads.get(threadId);
      if (!state?.attached) throw new Error(`Thread ${threadId} is not loaded locally; not compacted`);
      if (state.outcomeUnknown || state.status === 'inProgress' || this._compactions.has(threadId)) {
        throw new Error(`Thread ${threadId} is active or unconfirmed; not compacted`);
      }
      await this.connect();
      checkSignal(signal);
      operation = { previousTurnId: state.turnId };
      operation.done = new Promise((resolveDone, reject) => Object.assign(operation, { resolve: resolveDone, reject }));
      operation.done.catch(() => {});
      this._compactions.set(threadId, operation);
      this._resetTurn(state);
      state.status = 'inProgress';
      this._publish(state);
      operation.admission = this._rpc('thread/compact/start', { threadId }, { state, mutation: true,
        onResult: (_result, request) => this._known(state, request.id) }).catch(error => {
        if (this._compactions.get(threadId) === operation) this._compactions.delete(threadId);
        if (!error.outcomeUnknown && !state.turnId) {
          state.status = 'failed';
          state.error = error.message;
          this._publish(state);
        }
        operation.reject(withThread(error, threadId));
      });
    });
    const abort = () => {
      if (this._compactions.get(threadId) !== operation) return;
      operation.cancelled = true;
      operation.reject(aborted());
      // An admitted compaction is never replayed. Interrupt only its confirmed new native turn.
      const state = this._threads.get(threadId);
      if (state?.status === 'inProgress' && state.turnId && state.turnId !== operation.previousTurnId) {
        operation.interruptSent = true;
        this.cancel(threadId).catch(() => {});
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try { return (await Promise.all([operation.done, operation.admission]))[0]; }
    finally { signal?.removeEventListener('abort', abort); }
  }


  async cancel(threadId) {
    nonempty(threadId, 'threadId');
    const interrupted = this._threads.get(threadId);
    let requested;
    if (interrupted && (interrupted.status === 'inProgress' || interrupted.outcomeUnknown)) {
      requested = interrupted.interruptRequested ??= { turnId: interrupted.turnId };
    }
    if (requested?.promise) return requested.promise;
    this._abortRequests(threadId);
    const task = this._serialize(threadId, async () => {
      const state = this._threads.get(threadId);
      if (!state) throw new Error(`Unknown local thread: ${threadId}`);
      await this.connect();
      if (state.outcomeUnknown || (state.status === 'inProgress' && !state.turnId)) await this._reconcile(state);
      if (requested?.turnId && state.turnId !== requested.turnId) return this._snapshot(state);
      if (state.status !== 'inProgress') return this._snapshot(state);
      const request = state.interruptRequested ??= { turnId: state.turnId };
      try {
        await this._rpc('turn/interrupt', { threadId, turnId: state.turnId }, {
          state, mutation: true, onResult: (_result, pending) => this._known(state, pending.id),
        });
      } catch (error) {
        if (error.outcomeUnknown !== true && state.interruptRequested === request) state.interruptRequested = null;
        throw error;
      }
      // Admission is not completion; only turn/completed confirms interruption.
      return this._snapshot(state);
    });
    if (requested) requested.promise = task;
    return task;
  }

  // Steers only the named active turn; a finished or different turn is refused (no new turn starts).
  async steer({ threadId, turnId, prompt, input } = {}) {
    nonempty(threadId, 'threadId');
    nonempty(turnId, 'turnId');
    input = userInput(prompt, input);
    return this._serialize(threadId, async () => {
      const state = this._threads.get(threadId);
      if (!state) throw new Error(`Unknown local thread: ${threadId}`);
      if (state.outcomeUnknown || !state.attached || state.status !== 'inProgress' || state.turnId !== turnId) {
        throw new Error(`Turn ${turnId} is not the active turn of thread ${threadId}; not steered`);
      }
      await this._steer(state, input);
      return this._snapshot(state);
    });
  }

  _steer(state, input) {
    if (state.interruptRequested) return Promise.reject(new Error('Native turn interruption is pending; no input sent'));
    const expectedTurnId = state.turnId;
    return this._rpc('turn/steer', { threadId: state.threadId, expectedTurnId, input }, {
      state, mutation: true,
      onResult: (result, request) => {
        if (result?.turnId !== expectedTurnId) throw new Error('Codex steered an unexpected turn');
        this._known(state, request.id);
      },
    });
  }

  _known(state, requestId) {
    if (requestId !== undefined && state.uncertain && state.uncertain.id !== requestId) return;
    state.outcomeUnknown = false;
    state.uncertain = null;
    if (!TERMINAL.has(state.status)) state.error = null;
  }

  async _lastTurn(threadId) {
    const result = await this._rpc('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    if (!Array.isArray(result?.data)) throw new Error('Codex thread/turns/list returned no turn list');
    const turn = result.data[0];
    if (!turn) return undefined;
    nonempty(turn.id, 'turn.id');
    const items = [];
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < 1000; page++) {
      // One item per page prevents unrelated command output from making a whole-turn JSONL payload.
      const result = await this._rpc('thread/items/list', {
        threadId, turnId: turn.id, limit: 1, sortDirection: 'asc', ...(cursor === undefined ? {} : { cursor }),
      });
      if (!Array.isArray(result?.data)) throw new Error('Codex thread/items/list returned no item list');
      for (const entry of result.data) {
        if (entry?.turnId !== turn.id || !entry.item) throw new Error('Codex thread/items/list returned an invalid item');
        if (entry.item.type === 'agentMessage') items.push(entry.item);
      }
      cursor = result.nextCursor;
      if (cursor == null) return { ...turn, items };
      if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error('Codex thread/items/list returned an invalid or repeated cursor');
      cursors.add(cursor);
    }
    throw new Error('Codex thread/items/list exceeded 1000 pages');
  }

  async _reconcile(state) {
    const turn = await this._lastTurn(state.threadId);
    if (!state.outcomeUnknown && !(state.status === 'inProgress' && !state.turnId)) return;
    // Only a native turn this client has not retired settles the outcome. A read cannot prove a timed-out
    // resume applied its permission overrides, and an in-progress turn proves nothing about a timed-out
    // steer/interrupt of that same turn or about work left by a dead server.
    const unproven = turn?.status === 'inProgress' && (state.status === 'disconnected'
      || (turn.id === state.turnId && ['turn/steer', 'turn/interrupt'].includes(state.uncertain?.method)));
    if (turn && !state.retired.has(turn.id) && state.uncertain?.method !== 'thread/resume' && !unproven) {
      this._turn(state, turn);
      this._known(state);
      this._publish(state);
      return;
    }
    const error = new Error(`Thread ${state.threadId}: outcome of the previous ${state.uncertain?.method ?? 'turn'} is unknown; no mutation retried`);
    error.outcomeUnknown = true;
    error.threadId = state.threadId;
    throw error;
  }

  _threadState(state, thread) {
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const turn = turns.findLast(entry => entry.status === 'inProgress') ?? turns.at(-1);
    if (turn) this._turn(state, turn);
    else if (thread.status?.type === 'active' && !TERMINAL.has(state.status)) state.status = 'inProgress';
    else if (thread.status?.type === 'systemError') {
      state.status = 'failed';
      state.error = 'Codex thread reported a system error';
    }
  }

  _resetTurn(state, id = null) {
    if (state.turnId && state.turnId !== id) {
      state.retired.add(state.turnId);
      if (state.retired.size > 100) state.retired.delete(state.retired.values().next().value);
    }
    if (state.turnId !== id) {
      if (state.interruptRequested?.turnId === null && id !== null) state.interruptRequested.turnId = id;
      else state.interruptRequested = null;
      this._abortRequests(state.threadId, state.turnId);
      state.usageBaseline = state.tokenUsage?.total ?? state.usageBaseline;
      state.turnUsage = null;
      state.asyncQuestions.clear();
    }
    state.turnId = id;
    state.status = 'idle';
    state.messages.clear();
    state.textSize = 0;
    state.textTruncated = false;
    state.error = null;
    state.outcomeUnknown = false;
    state.uncertain = null;
  }

  _turn(state, turn) {
    const id = nonempty(turn.id, 'turn.id');
    if (state.retired.has(id)) return;
    if (state.turnId !== id) this._resetTurn(state, id);
    const status = turn.status ?? 'inProgress';
    if (!(TERMINAL.has(state.status) && status === 'inProgress')) {
      state.status = TERMINAL.has(status) ? status : 'inProgress';
    }
    for (const item of turn.items ?? []) if (item.type === 'agentMessage') this._message(state, item.id, item.text ?? '', item.phase);
    if (turn.error) state.error = typeof turn.error.message === 'string' ? turn.error.message.slice(0, MAX_EVENT_TEXT) : JSON.stringify(bounded(turn.error));
    else if (TERMINAL.has(status)) state.error = null;
    if (TERMINAL.has(state.status)) {
      state.interruptRequested = null;
      this._known(state);
      this._abortRequests(state.threadId, state.turnId);
    }
  }

  _message(state, id, text, phase) {
    if (typeof text !== 'string') return;
    const key = typeof id === 'string' ? id : 'agent-message';
    const old = state.messages.get(key);
    if (!old && state.messages.size >= 128) { state.textTruncated = true; return; }
    const kept = text.slice(0, MAX_TEXT - state.textSize + (old?.text.length ?? 0));
    if (kept.length < text.length) state.textTruncated = true;
    state.textSize += kept.length - (old?.text.length ?? 0);
    state.messages.set(key, { text: kept, phase: phase === undefined ? old?.phase : phase });
  }

  // The server no longer holds the thread. An active turn stays unknown until native history shows its end.
  _detach(state, reason) {
    this._abortRequests(state.threadId);
    const compaction = this._compactions.get(state.threadId);
    if (compaction) {
      this._compactions.delete(state.threadId);
      compaction.reject(new Error(reason));
    }
    state.attached = false;
    // Permission overrides of a timed-out resume cannot outlive the server that held them.
    if (state.uncertain?.method === 'thread/resume') this._known(state);
    if (state.status === 'inProgress' || state.outcomeUnknown) {
      Object.assign(state, { status: 'disconnected', outcomeUnknown: true, uncertain: null, error: reason });
    }
    this._publish(state);
  }

  _notification(method, params) {
    // Only threads this client started or resumed; a notification never confers ownership.
    const state = this._threads.get(params?.threadId ?? params?.thread?.id);
    if (!state) return;
    if (method === 'serverRequest/resolved') this._abortRequest(params.requestId, params.threadId);
    if (!/delta$|tokenUsage/i.test(method)) {
      state.events.push({ method, params: bounded(params) });
      if (state.events.length > 50) state.events.shift();
    }
    const turnId = params.turnId ?? params.turn?.id;
    if (turnId && state.retired.has(turnId)) return;
    if (method === 'thread/tokenUsage/updated') {
      const usage = params.tokenUsage;
      const total = usageBreakdown(usage?.total);
      const last = usageBreakdown(usage?.last);
      if (usage.modelContextWindow != null && (!Number.isSafeInteger(usage.modelContextWindow) || usage.modelContextWindow <= 0)) {
        throw new TypeError('Invalid native modelContextWindow');
      }
      if (turnId && state.turnId !== turnId) {
        this._resetTurn(state, turnId);
        state.status = 'inProgress';
      }
      state.tokenUsage = { ...usage, total, last };
      state.tokenUsageTurnId = turnId;
      const baseline = state.usageBaseline;
      state.turnUsage = baseline && USAGE_KEYS.every(key => (total[key] ?? 0) >= (baseline[key] ?? 0))
        ? Object.fromEntries(USAGE_KEYS.map(key => [key, (total[key] ?? 0) - (baseline[key] ?? 0)])) : null;
    }
    if (method === 'thread/started' && params.thread) this._threadState(state, params.thread);
    else if (method === 'turn/started' || method === 'turn/completed') {
      if (params.turn?.id) this._turn(state, params.turn);
    } else if (method === 'item/completed' || method === 'item/started') {
      if (turnId && state.turnId !== turnId) {
        this._resetTurn(state, turnId);
        state.status = 'inProgress';
      }
      if (params.item?.type === 'agentMessage') this._message(state, params.item.id, params.item.text ?? '', params.item.phase);
      if (method === 'item/completed' && params.item?.type === 'agentMessage'
        && params.item.delivery === 'async') this._asyncQuestions(state, params.item, turnId);
    } else if (method === 'error' && params.error) {
      state.error = String(params.error.message ?? 'Codex reported an error').slice(0, MAX_EVENT_TEXT);
    } else if (method === 'thread/closed') this._detach(state, 'Codex thread closed');
    const compaction = this._compactions.get(state.threadId);
    if (compaction?.cancelled && !compaction.interruptSent && state.status === 'inProgress'
      && state.turnId && state.turnId !== compaction.previousTurnId) {
      compaction.interruptSent = true;
      this.cancel(state.threadId).catch(() => {});
    }
    if (compaction && state.turnId !== compaction.previousTurnId && TERMINAL.has(state.status)) {
      this._compactions.delete(state.threadId);
      compaction.resolve(this._snapshot(state));
    }
    this._publish(state);
    if (this._onNotification) {
      try { this._onNotification(method, bounded(params)); } catch { /* An observer must never break the transport. */ }
    }
  }

  _consume(chunk) {
    if (this._failure) return;
    const end = chunk.lastIndexOf('\n');
    if (end === -1) {
      // Only new bytes are measured; a partial line is never re-measured.
      this._stdoutBytes += Buffer.byteLength(chunk);
      if (this._stdoutBytes > MAX_LINE) this._fail(new Error(LINE_TOO_LONG));
      else this._stdout += chunk;
      return;
    }
    const lines = (this._stdout + chunk.slice(0, end)).split('\n');
    this._stdout = chunk.slice(end + 1);
    this._stdoutBytes = Buffer.byteLength(this._stdout);
    for (const line of lines) {
      if (Buffer.byteLength(line) > MAX_LINE) { this._fail(new Error(LINE_TOO_LONG)); return; }
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this._fail(new Error('Codex emitted invalid JSONL')); return; }
      this._receive(message);
      if (this._failure) return;
    }
    if (this._stdoutBytes > MAX_LINE) this._fail(new Error(LINE_TOO_LONG));
  }

  _abortRequest(id, threadId) {
    const request = this._serverRequests.get(id);
    if (!request || request.threadId !== threadId) return;
    this._serverRequests.delete(id);
    request.controller.abort();
  }

  _abortRequests(threadId, turnId) {
    for (const [id, request] of this._serverRequests) {
      if (request.threadId === threadId && (turnId == null || request.turnId === turnId)) this._abortRequest(id, threadId);
    }
  }

  _asyncQuestions(state, item, turnId) {
    if (state.status !== 'inProgress' || state.interruptRequested || state.turnId !== turnId || state.asyncQuestions.has(item.id)) return;
    if (!Array.isArray(item.questions) || !item.questions.length) return;
    nonempty(item.id, 'async question item.id');
    const questions = item.questions.map((question, index) => {
      if (typeof question?.title !== 'string' || (question.options != null
        && (!Array.isArray(question.options) || question.options.some(option => typeof option !== 'string')))) {
        throw new TypeError('Invalid native async question');
      }
      return {
        id: JSON.stringify(['request_user_input_async', item.id, index]),
        header: question.title, question: question.title, isOther: true, isSecret: false,
        options: question.options?.map(label => ({ label, description: '' })) ?? null,
      };
    });
    state.asyncQuestions.add(item.id);
    this._serverRequest({
      id: `async:${state.threadId}:${turnId}:${item.id}`, method: 'item/tool/requestUserInput',
      params: { threadId: state.threadId, turnId, itemId: item.id, isBlocking: false, delivery: 'async', questions },
    }, ({ result, error }) => {
      if (state.status !== 'inProgress' || state.turnId !== turnId) return;
      if (error) {
        state.error = error.message;
        return;
      }
      const answers = questions.flatMap(question => {
        const answer = result.answers[question.id]?.answers.join('\n');
        return answer ? [{ answer, question: question.question, questionItemId: question.id }] : [];
      });
      if (!answers.length) return;
      const prompt = `<send_user_message_question_reply>\n${JSON.stringify(answers)}\n</send_user_message_question_reply>`;
      this.steer({ threadId: state.threadId, turnId, prompt }).catch(error => {
        // A response to a finished turn is intentionally dropped, just as in the native TUI.
        if (state.status === 'inProgress' && state.turnId === turnId) state.error = String(error.message).slice(0, MAX_EVENT_TEXT);
      });
    });
  }

  _serverRequest({ id, method, params }, respond) {
    const reply = payload => {
      if (respond) { respond(payload); return; }
      try { this._send({ id, ...payload }); }
      catch (error) { this._fail(error); }
    };
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      reply({ result: { decision: 'decline' } });
      return;
    }
    if (method === 'item/permissions/requestApproval') {
      reply({ result: { permissions: {}, scope: 'turn' } });
      return;
    }
    if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
      reply({ result: { decision: { denied: { rejection: 'OMP Codex native never grants approvals' } } } });
      return;
    }
    const questions = method === 'item/tool/requestUserInput';
    const form = method === 'mcpServer/elicitation/request'
      && ['form', 'openai/form', 'openaiForm'].includes(params?.mode);
    if (!questions && !form) {
      reply({ error: { code: -32601, message: 'Server request method is not supported by this client' } });
      return;
    }
    const state = this._threads.get(params?.threadId);
    const turnId = params?.turnId ?? null;
    if (state?.interruptRequested && (turnId === null || state.interruptRequested.turnId === null
      || turnId === state.interruptRequested.turnId)) {
      reply({ error: { code: -32600, message: 'Native turn interruption is pending; user interaction cancelled' } });
      return;
    }
    if (!state || (questions && (!turnId || state.status !== 'inProgress' || state.turnId !== turnId))
      || (!questions && turnId && (state.status !== 'inProgress' || state.turnId !== turnId))) {
      reply({ error: { code: -32602, message: 'Server request does not belong to an owned active turn' } });
      return;
    }
    if (this._serverRequests.has(id) || this._serverRequests.size >= 128) {
      reply({ error: { code: -32600, message: 'Duplicate or excessive server request' } });
      return;
    }
    const controller = new AbortController();
    const request = { threadId: state.threadId, turnId, controller };
    this._serverRequests.set(id, request);
    // Never await user UI in the JSONL reader: native resolution and other RPCs must still run.
    Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      return this._onRequest
        ? this._onRequest({ method, params: structuredClone(params), threadId: state.threadId, turnId, signal: controller.signal })
        : questions ? { answers: {} } : { action: 'cancel' };
    }).then(result => {
      if (this._serverRequests.get(id) !== request || controller.signal.aborted) return;
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('onRequest must return a native result object');
      if (questions) {
        if (!result.answers || typeof result.answers !== 'object' || Array.isArray(result.answers)
          || Object.values(result.answers).some(answer => !Array.isArray(answer?.answers)
            || answer.answers.some(value => typeof value !== 'string'))) throw new TypeError('Invalid native question answers');
      } else if (!['accept', 'decline', 'cancel'].includes(result.action)) throw new TypeError('Invalid native MCP elicitation action');
      const value = jsonValue(result, 'onRequest result');
      this._serverRequests.delete(id);
      reply({ result: value });
    }).catch(error => {
      if (this._serverRequests.get(id) !== request || controller.signal.aborted) return;
      this._serverRequests.delete(id);
      reply({ error: { code: -32602, message: String(error?.message ?? error).slice(0, MAX_EVENT_TEXT) } });
    });
  }

  _receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this._fail(new Error('Codex emitted an invalid RPC message'));
      return;
    }
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        this._serverRequest(message);
      } else {
        try { this._notification(message.method, message.params); }
        catch { this._fail(new Error('Codex emitted an invalid notification')); }
      }
      return;
    }
    const pending = this._pending.get(message.id);
    if (!pending) return;
    this._pending.delete(message.id);
    clearTimeout(pending.timer);
    const { state } = pending;
    if (Object.hasOwn(message, 'error')) {
      const error = rpcError(message.error);
      if (state && (!pending.timedOut || state.uncertain?.id === pending.id)) {
        this._known(state, pending.id);
        // A late steer or interrupt rejection must not overwrite a finished turn's result.
        if (!TERMINAL.has(state.status)) state.error = error.message;
        if (pending.timedOut && pending.method === 'turn/start' && !state.turnId) state.status = 'failed';
        this._publish(state);
      }
      pending.reject(error);
      return;
    }
    try {
      if (!Object.hasOwn(message, 'result')) throw new Error('Codex RPC response has neither result nor error');
      pending.onResult?.(message.result, pending);
      pending.resolve(message.result);
    } catch (error) {
      pending.reject(error);
      // A permission or model mismatch refuses one thread; the transport stays usable.
      if (!REFUSED_CODES.has(error.code)) this._fail(error);
    }
  }

  _send(message) {
    const child = this._process;
    if (this._closed || this._failure || !child?.stdin.writable) throw this._failure ?? new Error('Codex transport is not writable');
    child.stdin.write(`${JSON.stringify(message)}\n`, error => {
      if (error && this._process === child) this._fail(new Error(`Codex write failed: ${error.message}`));
    });
  }

  _rpc(method, params, { state, mutation = false, onResult } = {}) {
    if (this._pending.size >= 128) return Promise.reject(new Error('Too many unresolved Codex RPC requests'));
    if (this._closed || this._failure) return Promise.reject(this._failure ?? new Error('Codex client is closed'));
    const id = this._nextId++;
    return new Promise((resolveResult, reject) => {
      const pending = { id, method, state, mutation, onResult, resolve: resolveResult, reject, timer: null, timedOut: false };
      pending.timer = setTimeout(() => {
        pending.timedOut = true;
        pending.timer = null;
        const error = new Error(`Codex ${method} timed out${mutation ? '; outcome unknown; no mutation retried' : ''}`);
        error.code = 'RPC_TIMEOUT';
        error.outcomeUnknown = mutation;
        if (state) {
          error.threadId = state.threadId;
          if (mutation) {
            state.outcomeUnknown = true;
            state.uncertain = { id, method };
            if (!TERMINAL.has(state.status)) state.error = error.message;
          }
        }
        // Retain mutation response handlers: a late reply can reveal the admitted turn or thread.
        if (!mutation) this._pending.delete(id);
        reject(error);
      }, this.timeoutMs);
      this._pending.set(id, pending);
      try { this._send({ id, method, params }); }
      catch (error) {
        clearTimeout(pending.timer);
        this._pending.delete(id);
        reject(error);
      }
    });
  }

  _fail(error) {
    if (this._failure) return;
    this._failure = error instanceof Error ? error : new Error(String(error));
    this._stdout = '';
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      const failure = new Error(`${this._failure.message}${pending.mutation ? '; outcome unknown; no mutation retried' : ''}`);
      failure.code = 'DISCONNECTED';
      failure.outcomeUnknown = pending.mutation;
      if (pending.state) failure.threadId = pending.state.threadId;
      pending.reject(failure);
    }
    this._pending.clear();
    // Threads stay owned; the next explicit call reconnects and settles them only from native history.
    for (const state of this._threads.values()) this._detach(state, this._failure.message);
    const child = this._process;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }

  close() {
    if (this._closePromise) return this._closePromise;
    this._closed = true;
    const child = this._process;
    const stopped = child && child.exitCode === null && child.signalCode === null
      ? new Promise(resolveClose => child.once('close', resolveClose)) : Promise.resolve();
    this._fail(new Error('Codex client closed'));
    this._closePromise = (async () => {
      if (child) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        let timer;
        await Promise.race([stopped, new Promise(resolveTimeout => { timer = setTimeout(resolveTimeout, 1000); })]);
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await stopped;
      }
      this._listeners.clear();
    })();
    return this._closePromise;
  }
}
