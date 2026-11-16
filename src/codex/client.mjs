import { isAbsolute } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { AppServerTransport } from './transport.mjs';
import {
  TERMINAL, REFUSED_CODES, MAX_EVENT_TEXT, USAGE_KEYS,
  bounded, nonempty, jsonValue, userInput, usageBreakdown, aborted, checkSignal,
  validateThreadOptions, withThread, resolveNativeConfig, cwdError, validateApprovalResult,
} from './protocol.mjs';
import {
  listModels, inspectConnection, listThreads, getThreadDetails, inspectThreadStatus, readLastTurn,
  projectItem, recordItem, threadSnapshot,
} from './inspection.mjs';

function blankState(threadId) {
  return {
    threadId, turnId: null, status: 'idle', error: null, outcomeUnknown: false,
    cwd: null, model: null, permissions: null, requestedReasoningEffort: null, developerInstructions: undefined,
    latestActivity: null, latestPlan: null, fileChanges: [], commandFailure: null, inspection: 'live',
    tokenUsage: null, tokenUsageTurnId: null, usageBaseline: null, turnUsage: null,
    events: [], messages: new Map(), textSize: 0, textTruncated: false,
    asyncQuestions: new Set(),
    retired: new Set(), uncertain: null, interruptRequested: null, attached: false, published: null,
  };
}


export class CodexAppServerClient {
  // onNotification(method, boundedParams) observes owned-thread notifications (item progress for
  // provider streaming); the default subscriber API stays the lightweight {threadId, turnId, status}.
  constructor({ command, timeoutMs, env, config, onNotification, onRequest } = {}) {
    if (onNotification !== undefined && typeof onNotification !== 'function') throw new TypeError('onNotification must be a function');
    if (onRequest !== undefined && typeof onRequest !== 'function') throw new TypeError('onRequest must be a function');
    this._config = resolveNativeConfig(config, env);
    this._threads = new Map();
    this._queues = new Map();
    this._listeners = new Set();
    this._onNotification = onNotification;
    this._onRequest = onRequest;
    this._serverRequests = new Map();
    this._compactions = new Map();
    this._transport = new AppServerTransport({ command, timeoutMs, env,
      onNotification: (method, params) => this._handleNotification(method, params),
      onRequest: message => this._handleServerRequest(message),
      onDisconnect: error => {
        // Threads stay owned; explicit calls reconnect and settle them only from native history.
        for (const state of this._threads.values()) this._detachThread(state, error.message);
      },
    });
  }

  // A defensive copy binds callers' receipts without exposing mutable effective overrides.
  get config() {
    return structuredClone(this._config);
  }

  connect() {
    return this._transport.connect();
  }

  // Listeners receive { threadId, turnId, status } whenever that pair changes; read snapshot() for details.
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  // Native diagnostics and history reads never register local ownership.
  listModels() {
    return listModels(this);
  }

  inspectConnection() {
    return inspectConnection(this);
  }

  listThreads(options) {
    return listThreads(this, options);
  }

  getThreadDetails(threadId, options) {
    return getThreadDetails(this, threadId, options);
  }

  snapshot(threadId) {
    if (threadId !== undefined) {
      const state = this._threads.get(threadId);
      return state ? this._threadSnapshot(state) : undefined;
    }
    return [...this._threads.values()].map(state => this._threadSnapshot(state));
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
      return this._threadSnapshot(state);
    }
    return inspectThreadStatus(this, threadId);
  }

  _threadSnapshot(state) {
    return threadSnapshot(state);
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

  _getThread(threadId) {
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
  async _loadThread({ threadId, cwd, model, developerInstructions }) {
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
        if (threadId) state = this._getThread(threadId);
        try {
          await this._request(threadId ? 'thread/resume' : 'thread/start', {
            cwd: directory, ...(model === undefined ? {} : { model }),
            ...(Object.keys(this._config).length ? { config: this.config } : {}),
            ...(developerInstructions === undefined ? {} : { developerInstructions }),
            ...(threadId ? { threadId, excludeTurns: true } : {}),
          }, {
            state, mutation: true,
            onResult: (result, request) => {
              const id = nonempty(result?.thread?.id, 'response.thread.id');
              if (threadId && id !== threadId) throw new Error('Codex resumed an unexpected thread');
              state = this._getThread(id);
              const denied = cwdError(result, directory)
                // An explicit model is the thread's model; Codex silently using another one gets no turn.
                ?? (model !== undefined && typeof result.model === 'string' && result.model !== model
                  ? Object.assign(new Error(`Codex reported model ${result.model} for requested model ${model}; no turn started`), { code: 'MODEL_MISMATCH' })
                  : null);
              if (denied) {
                denied.threadId = id;
                state.error = denied.message;
                throw denied;
              }
              Object.assign(state, { cwd: result.cwd ?? directory, model: result.model ?? model ?? null, developerInstructions,
                permissions: bounded({ approvalPolicy: result.approvalPolicy ?? null, sandbox: result.sandbox ?? null }), attached: true });
              if (!threadId) state.usageBaseline = Object.fromEntries(USAGE_KEYS.map(key => [key, 0]));
              this._confirmOutcome(state, request.id);
              this._applyThread(state, result.thread);
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
      const state = await this._loadThread({ threadId, cwd, model, developerInstructions });
      try {
        if (onThread) await onThread(state.threadId);
        return this._threadSnapshot(state);
      } catch (error) {
        throw withThread(error, state.threadId);
      }
    });
  }


  // onThread(threadId) runs once the thread ID is confirmed and before any turn request, so a
  // caller can record the authoritative native ID first; if it throws, no turn is requested.
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
        state = await this._loadThread({ threadId, cwd, model, developerInstructions });
        const directory = state.cwd;
        if (onThread) await onThread(state.threadId);
        if (state.status === 'inProgress' && (effort !== undefined || outputSchema !== undefined)) {
          throw new Error('effort and outputSchema cannot change an active turn through turn/steer');
        }
        if (state.status === 'inProgress' && !state.turnId) await this._reconcile(state);
        if (state.status === 'inProgress') {
          await this._steerTurn(state, input);
        } else {
          this._resetTurn(state);
          state.status = 'inProgress';
          state.requestedReasoningEffort = effort ?? null;
          this._publish(state);
          try {
            await this._request('turn/start', {
              threadId: state.threadId, input, cwd: directory,
              ...(model === undefined ? {} : { model }),
              ...(effort === undefined ? {} : { effort }),
              ...(outputSchema === undefined ? {} : { outputSchema }),
            }, {
              state, mutation: true,
              onResult: (result, request) => {
                if (!result?.turn?.id) throw new Error('Codex turn/start response has no turn ID');
                this._applyTurn(state, result.turn);
                this._confirmOutcome(state, request.id);
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
        return this._threadSnapshot(state);
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
    if (sandbox !== undefined) throw new TypeError('sandbox is not a thread option; use constructor config native overrides');
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
        await this._request('thread/fork', {
          threadId, ...(lastTurnId === undefined ? {} : { lastTurnId }),
          cwd: directory, excludeTurns: true,
          ...(Object.keys(this._config).length ? { config: this.config } : {}),
          ...(model === undefined ? {} : { model }),
          ...(developerInstructions === undefined ? {} : { developerInstructions }),
        }, {
          mutation: true,
          onResult: (result, request) => {
            const id = nonempty(result?.thread?.id, 'response.thread.id');
            if (id === threadId || this._threads.has(id)) throw new Error('Codex fork returned an existing thread ID');
            forked = this._getThread(id);
            const denied = cwdError(result, directory)
              ?? (model !== undefined && typeof result.model === 'string' && result.model !== model
                ? Object.assign(new Error('Codex fork reported a different model; no turn started'), { code: 'MODEL_MISMATCH' }) : null);
            if (denied) {
              forked.error = denied.message;
              throw withThread(denied, id);
            }
            Object.assign(forked, { cwd: result.cwd ?? directory, model: result.model ?? model ?? null, developerInstructions,
              permissions: bounded({ approvalPolicy: result.approvalPolicy ?? null, sandbox: result.sandbox ?? null }), attached: true });
            this._applyThread(forked, result.thread);
            if (request.timedOut) forked.error = 'Codex thread/fork response arrived after its timeout; no turn was started';
            this._publish(forked);
          },
        });
        if (onThread) await onThread(forked.threadId);
        return this._threadSnapshot(forked);
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
      operation.admission = this._request('thread/compact/start', { threadId }, { state, mutation: true,
        onResult: (_result, request) => this._confirmOutcome(state, request.id) }).catch(error => {
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
      try {
        await this.connect();
        if (state.outcomeUnknown || (state.status === 'inProgress' && !state.turnId)) await this._reconcile(state);
      } catch (error) {
        // No interrupt was sent. Its coalescing slot must not block a later confirmed active turn.
        if (state.interruptRequested === requested) state.interruptRequested = null;
        throw error;
      }
      if (requested?.turnId && state.turnId !== requested.turnId) return this._threadSnapshot(state);
      if (state.status !== 'inProgress') return this._threadSnapshot(state);
      const request = state.interruptRequested ??= { turnId: state.turnId };
      try {
        await this._request('turn/interrupt', { threadId, turnId: state.turnId }, {
          state, mutation: true, onResult: (_result, pending) => this._confirmOutcome(state, pending.id),
        });
      } catch (error) {
        if (error.outcomeUnknown !== true && state.interruptRequested === request) state.interruptRequested = null;
        throw error;
      }
      // Admission is not completion; only turn/completed confirms interruption.
      return this._threadSnapshot(state);
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
      await this._steerTurn(state, input);
      return this._threadSnapshot(state);
    });
  }

  _steerTurn(state, input) {
    if (state.interruptRequested) return Promise.reject(new Error('Native turn interruption is pending; no input sent'));
    const expectedTurnId = state.turnId;
    return this._request('turn/steer', { threadId: state.threadId, expectedTurnId, input }, {
      state, mutation: true,
      onResult: (result, request) => {
        if (result?.turnId !== expectedTurnId) throw new Error('Codex steered an unexpected turn');
        this._confirmOutcome(state, request.id);
      },
    });
  }

  _confirmOutcome(state, requestId) {
    if (requestId !== undefined && state.uncertain && state.uncertain.id !== requestId) return;
    state.outcomeUnknown = false;
    state.uncertain = null;
    if (!TERMINAL.has(state.status)) state.error = null;
  }

  _readLastTurn(threadId) {
    return readLastTurn(this, threadId);
  }

  async _reconcile(state) {
    let turn;
    try {
      turn = await this._readLastTurn(state.threadId);
    } catch (error) {
      if (!state.outcomeUnknown) throw error;
      throw Object.assign(new Error(error.message, { cause: error }), {
        code: error.code, outcomeUnknown: true, threadId: state.threadId,
      });
    }
    if (!state.outcomeUnknown && !(state.status === 'inProgress' && !state.turnId)) return;
    // Only a native turn this client has not retired settles the outcome. A read cannot prove a timed-out
    // resume attached successfully, and an in-progress turn proves nothing about a timed-out
    // steer/interrupt of that same turn or about work left by a dead server.
    const unproven = turn?.status === 'inProgress' && (state.status === 'disconnected'
      || (turn.id === state.turnId && ['turn/steer', 'turn/interrupt'].includes(state.uncertain?.method)));
    if (turn && (turn.status === 'inProgress' || TERMINAL.has(turn.status))
      && !state.retired.has(turn.id) && state.uncertain?.method !== 'thread/resume' && !unproven) {
      this._applyTurn(state, turn);
      this._confirmOutcome(state);
      this._publish(state);
      return;
    }
    const error = new Error(`Thread ${state.threadId}: outcome of the previous ${state.uncertain?.method ?? 'turn'} is unknown; no mutation retried`);
    error.outcomeUnknown = true;
    error.threadId = state.threadId;
    throw error;
  }

  _applyThread(state, thread) {
    if (typeof thread.cwd === 'string') state.cwd = thread.cwd;
    if (typeof thread.model === 'string') state.model = thread.model;
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const turn = turns.findLast(entry => entry.status === 'inProgress') ?? turns.at(-1);
    if (turn) this._applyTurn(state, turn);
    else if (thread.status?.type === 'active' && !TERMINAL.has(state.status)) state.status = 'inProgress';
    else if (thread.status?.type === 'systemError') {
      state.status = 'failed';
      state.error = 'Codex thread reported a system error';
    }
  }

  _resetTurn(state, id = null) {
    if (state.turnId !== id && state.turnId !== null) state.requestedReasoningEffort = null;
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
    state.latestActivity = null;
    state.latestPlan = null;
    state.fileChanges = [];
    state.commandFailure = null;
    state.error = null;
    state.outcomeUnknown = false;
    state.uncertain = null;
  }

  _applyTurn(state, turn) {
    const id = nonempty(turn.id, 'turn.id');
    if (state.retired.has(id)) return;
    if (state.turnId !== id) this._resetTurn(state, id);
    const status = turn.status ?? 'inProgress';
    if (!(TERMINAL.has(state.status) && status === 'inProgress')) {
      state.status = TERMINAL.has(status) ? status : 'inProgress';
    }
    for (const item of turn.items ?? []) this._recordItem(state, item);
    if (turn.error) state.error = typeof turn.error.message === 'string' ? turn.error.message.slice(0, MAX_EVENT_TEXT) : JSON.stringify(bounded(turn.error));
    else if (TERMINAL.has(status)) state.error = null;
    if (TERMINAL.has(state.status)) {
      state.interruptRequested = null;
      this._confirmOutcome(state);
      this._abortRequests(state.threadId, state.turnId);
    }
  }

  _recordItem(state, item) {
    recordItem(state, item);
  }

  // The server no longer holds the thread. An active turn stays unknown until native history shows its end.
  _detachThread(state, reason) {
    this._abortRequests(state.threadId);
    const compaction = this._compactions.get(state.threadId);
    if (compaction) {
      this._compactions.delete(state.threadId);
      compaction.reject(Object.assign(new Error(reason), { outcomeUnknown: true, threadId: state.threadId }));
    }
    state.attached = false;
    // A timed-out resume cannot remain attached to a server that no longer holds it.
    if (state.uncertain?.method === 'thread/resume') this._confirmOutcome(state);
    if (state.status === 'inProgress' || state.outcomeUnknown) {
      Object.assign(state, { status: 'disconnected', outcomeUnknown: true, uncertain: null, error: reason });
    }
    this._publish(state);
  }

  _handleNotification(method, params) {
    // Only threads this client started or resumed; a notification never confers ownership.
    const state = this._threads.get(params?.threadId ?? params?.thread?.id);
    if (!state) return;
    if (method === 'serverRequest/resolved') this._abortRequest(params.requestId, params.threadId);
    const turnId = params.turnId ?? params.turn?.id;
    if (turnId && state.retired.has(turnId)) return;
    const projected = params.item ? bounded({ item: projectItem(params.item),
      threadId: params.threadId, turnId: params.turnId }) : bounded(params);
    if (!/delta$|tokenUsage/i.test(method)) {
      state.events.push({ method, params: projected });
      if (state.events.length > 50) state.events.shift();
    }
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
    if (method === 'thread/started' && params.thread) this._applyThread(state, params.thread);
    else if (method === 'turn/started' || method === 'turn/completed') {
      if (params.turn?.id) this._applyTurn(state, params.turn);
    } else if (method === 'item/completed' || method === 'item/started') {
      if (turnId && state.turnId !== turnId) {
        this._resetTurn(state, turnId);
        state.status = 'inProgress';
      }
      this._recordItem(state, params.item);
      if (method === 'item/completed' && params.item?.type === 'agentMessage'
        && params.item.delivery === 'async') this._askAsyncQuestions(state, params.item, turnId);
    } else if (method === 'error' && params.error) {
      state.error = String(params.error.message ?? 'Codex reported an error').slice(0, MAX_EVENT_TEXT);
    } else if (method === 'thread/closed') this._detachThread(state, 'Codex thread closed');
    if (method === 'turn/plan/updated') {
      if (turnId && state.turnId !== turnId) {
        this._resetTurn(state, turnId);
        state.status = 'inProgress';
      }
      const plan = Array.isArray(params.plan) ? params.plan : [];
      let left = 4096;
      state.latestPlan = {
        turnId: turnId ?? state.turnId,
        explanation: typeof params.explanation === 'string' ? params.explanation.slice(0, 1024) : null,
        plan: plan.slice(0, 50).map(entry => {
          const step = typeof entry?.step === 'string' ? entry.step.slice(0, Math.min(512, left)) : '';
          left -= step.length;
          return { step, status: typeof entry?.status === 'string' ? entry.status.slice(0, 64) : 'unknown' };
        }),
        truncated: plan.length > 50,
      };
      state.latestPlan.truncated = plan.length > 50 || plan.some((entry, index) => entry?.step !== state.latestPlan.plan[index]?.step);
    }
    if (method === 'item/started' || method === 'item/completed' || method === 'turn/plan/updated'
      || method === 'model/rerouted' || method === 'error') {
      state.latestActivity = { method, params: projected, at: Date.now() };
    }
    const compaction = this._compactions.get(state.threadId);
    if (compaction?.cancelled && !compaction.interruptSent && state.status === 'inProgress'
      && state.turnId && state.turnId !== compaction.previousTurnId) {
      compaction.interruptSent = true;
      this.cancel(state.threadId).catch(() => {});
    }
    if (compaction && state.turnId !== compaction.previousTurnId && TERMINAL.has(state.status)) {
      this._compactions.delete(state.threadId);
      compaction.resolve(this._threadSnapshot(state));
    }
    this._publish(state);
    if (this._onNotification) {
      try { this._onNotification(method, projected); } catch { /* An observer must never break the transport. */ }
    }
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

  _askAsyncQuestions(state, item, turnId) {
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
    this._handleServerRequest({
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

  _handleServerRequest({ id, method, params }, respond) {
    const reply = payload => {
      if (respond) { respond(payload); return; }
      try { this._transport.send({ id, ...payload }); }
      catch (error) { this._transport.fail(error); }
    };
    const commandApproval = method === 'item/commandExecution/requestApproval';
    const fileApproval = method === 'item/fileChange/requestApproval';
    const permissionApproval = method === 'item/permissions/requestApproval';
    const legacyApproval = method === 'applyPatchApproval' || method === 'execCommandApproval';
    const approval = commandApproval || fileApproval || permissionApproval || legacyApproval;
    const denied = legacyApproval ? { decision: { denied: { rejection: 'No approval handler is available' } } }
      : permissionApproval ? { permissions: {}, scope: 'turn' } : { decision: 'decline' };
    const questions = method === 'item/tool/requestUserInput';
    const form = method === 'mcpServer/elicitation/request'
      && ['form', 'openai/form', 'openaiForm'].includes(params?.mode);
    if (!questions && !form && !approval) {
      reply({ error: { code: -32601, message: 'Server request method is not supported by this client' } });
      return;
    }
    const state = this._threads.get(params?.threadId ?? (legacyApproval ? params?.conversationId : undefined));
    const turnId = params?.turnId ?? (legacyApproval ? state?.turnId : null);
    if (state?.interruptRequested && (turnId === null || state.interruptRequested.turnId === null
      || turnId === state.interruptRequested.turnId)) {
      reply({ error: { code: -32600, message: 'Native turn interruption is pending; user interaction cancelled' } });
      return;
    }
    if (!state || (questions && (!turnId || state.status !== 'inProgress' || state.turnId !== turnId))
      || (approval && (!state.attached || state.outcomeUnknown || !turnId || state.status !== 'inProgress' || state.turnId !== turnId))
      || (legacyApproval && params?.conversationId && params.conversationId !== state.threadId)
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
        : approval ? denied : questions ? { answers: {} } : { action: 'cancel' };
    }).then(result => {
      if (this._serverRequests.get(id) !== request || controller.signal.aborted) return;
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('onRequest must return a native result object');
      if (questions) {
        if (!result.answers || typeof result.answers !== 'object' || Array.isArray(result.answers)
          || Object.values(result.answers).some(answer => !Array.isArray(answer?.answers)
            || answer.answers.some(value => typeof value !== 'string'))) throw new TypeError('Invalid native question answers');
      } else if (approval) validateApprovalResult(method, result);
      else if (!['accept', 'decline', 'cancel'].includes(result.action)) throw new TypeError('Invalid native MCP elicitation action');
      const value = jsonValue(result, 'onRequest result');
      this._serverRequests.delete(id);
      reply({ result: value });
    }).catch(error => {
      if (this._serverRequests.get(id) !== request || controller.signal.aborted) return;
      this._serverRequests.delete(id);
      reply({ error: { code: -32602, message: String(error?.message ?? error).slice(0, MAX_EVENT_TEXT) } });
    });
  }

  _request(method, params, { state, mutation = false, onResult } = {}) {
    const interruption = method === 'turn/interrupt' ? state?.interruptRequested : null;
    return this._transport.request(method, params, { mutation, onResult, threadId: state?.threadId,
      onError: (error, pending) => {
        if (!state || (pending.timedOut && state.uncertain?.id !== pending.id)) return;
        this._confirmOutcome(state, pending.id);
        if (interruption && state.interruptRequested === interruption) state.interruptRequested = null;
        // A late steer or interrupt rejection must not overwrite a finished turn's result.
        if (!TERMINAL.has(state.status)) state.error = error.message;
        if (pending.timedOut && method === 'turn/start' && !state.turnId) state.status = 'failed';
        this._publish(state);
      },
      onTimeout: (error, pending) => {
        if (!state || !mutation) return;
        state.outcomeUnknown = true;
        state.uncertain = { id: pending.id, method };
        if (!TERMINAL.has(state.status)) state.error = error.message;
      },
    });
  }

  async close() {
    await this._transport.close();
    this._listeners.clear();
  }
}
