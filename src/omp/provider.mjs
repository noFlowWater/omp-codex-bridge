// Command-backed OMP provider: one Codex app-server thread per OMP provider session.
// Codex owns inference, native tools, approvals and its persisted thread; OMP receives only
// assistant events. Native activity streams as a thinking block, never as executable OMP tool calls.
import { isDeepStrictEqual } from 'node:util';
import { CodexAppServerClient } from '../codex/client.mjs';
import { CODEX_BRIDGE_PROVIDER, CODEX_BRIDGE_API, CODEX_BRIDGE_MODELS, DEFAULT_MODEL_ID, parseCodexModelId, fetchCodexModels } from './catalog.mjs';
import { inputId, inputBlocks, textOf, nativeInputs, nativeEffort, nativeOutputSchema, responseId, anchorOf } from './input.mjs';
import { LINE_CHARS, PROGRESS_CHARS, PROGRESS_LIMIT_NOTICE, clip, planLine, commandLine, nativeLabel, progressLine } from './progress.mjs';
import { loadSession, saveSession, sessionFile, readSessionRecord } from './session-store.mjs';

export { CODEX_BRIDGE_PROVIDER, CODEX_BRIDGE_API, CODEX_BRIDGE_MODELS, DEFAULT_MODEL_ID, parseCodexModelId, fetchCodexModels };
export { inputId, nativeInputs } from './input.mjs';

const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'disconnected']);
// Sent ids are never evicted (an evicted id could be resent); a full record stops new sends.
const SENT_LIMIT = 5000;
// Classification text for every error this provider reports. OMP auto-retry classifies errors
// from this field; native failures (usage limits, disconnects) must not trigger a replay.
const NO_RETRY = 'codex-bridge: native outcome reported; provider requests are not replayed';


const zeroUsage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});


function applyUsage(output, state) {
  const usage = state?.turnUsage;
  if (usage) {
    const cacheRead = usage.cachedInputTokens ?? 0;
    Object.assign(output.usage, {
      input: Math.max(0, usage.inputTokens - cacheRead), cacheRead,
      output: usage.outputTokens, totalTokens: usage.totalTokens,
      reasoningTokens: usage.reasoningOutputTokens,
    });
  }
  // Native `last` describes the last model request, not the entire agentic turn's billable usage.
  if (state?.tokenUsageTurnId === state?.turnId && state?.tokenUsage?.last) output.usage.contextTokens = state.tokenUsage.last.totalTokens;
}




function lastAssistant(messages, provider) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant' && message.provider === provider) return message;
  }
  return undefined;
}

/**
 * Returns the provider's `streamSimple`. Create it once per module: OMP's custom-API registry is
 * process-global and the latest registration wins, so every child session must reach the same
 * session table. Each `options.sessionId` owns its own client and thread; teardown of
 * one session (provider state `close()`) never touches another.
 *
 * `stateDir` holds one small record per session (file name = sha256 of the session id): policy marker,
 * cwd, native thread id, latest admitted turn id and the ids of every input already sent. It is
 * written before each native mutation, so a crash, dispose, revive or OMP requeue never sends
 * the same input to Codex twice.
 */
export function createCodexBridgeProvider({ EventStream, stateDir, onRequest, onProgress, onRateLimits, onNotice, createClient = options => new CodexAppServerClient(options) }) {
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir must be a nonempty path');
  const sessions = new Map();
  // Latest drive per session, and the teardown a reopened session must await.
  const runs = new Map();
  const closing = new Map();
  const contexts = new Map();
  const outputSchemas = new Map();
  const payloadRequests = new WeakMap();
  const providerSessionIds = new Map();
  // Fresh OMP branches inherit delivery receipts, then fork native history on first new input.
  const branchedSessions = new Map();
  const delay = (ms) => new Promise(resolveDelay => setTimeout(resolveDelay, ms).unref?.());
  const reportProgress = (sessionId, status) => {
    try { onProgress?.(sessionId, status); } catch { /* UI observers cannot break native work. */ }
  };
  // Bound for each teardown wait (run's interrupt admission, native turn settling).
  const CLOSE_WAIT_MS = 10_000;

  function openSession(sessionId, nativeModel, options) {
    let session = sessions.get(sessionId);
    if (session) {
      // Lifecycle hooks can open the client before its first stream supplies OMP's teardown map.
      options.providerSessionState?.set(CODEX_BRIDGE_PROVIDER, session.providerState);
      return session;
    }
    session = loadSession(stateDir, sessionId, nativeModel, options.cwd);
    session.client = createClient({
      onNotification: (method, params) => {
        if (method === 'account/rateLimits/updated') {
          try { onRateLimits?.(params); } catch { /* UI observers cannot break native work. */ }
          return;
        }
        session.sink?.(method, params);
      },
      onRequest: onRequest?.forClient?.() ?? onRequest,
    });
    const config = session.client.config ?? {};
    if (session.recorded && !isDeepStrictEqual(session.config, config)) {
      throw new Error('Native Codex bridge config overrides changed for this session; start a new task or fresh session. Nothing sent to Codex');
    }
    session.config = config;
    sessions.set(sessionId, session);
    // OMP closes provider session state on dispose, park, kill, new/fresh session and reload.
    // ponytail: records are never pruned (one small file per session); prune by mtime if it matters.
    const providerState = {
      close() {
        if (sessions.get(sessionId) === session) sessions.delete(sessionId);
        reportProgress(sessionId, undefined);
        session.sink = undefined;
        // OMP closes right after aborting a run; killing the app-server now could leave the native
        // turn unconfirmed (and the revived child stopped). Let the run's interrupt land and the
        // turn settle first, each bounded, then close.
        const done = (async () => {
          await Promise.race([runs.get(sessionId) ?? Promise.resolve(), delay(CLOSE_WAIT_MS)]);
          const { threadId, turnId } = session;
          if (threadId && turnId && session.client.snapshot(threadId)?.status === 'inProgress') {
            await Promise.race([settled(session.client, threadId, turnId), delay(CLOSE_WAIT_MS)]);
          }
          await session.client.close();
        })().catch(() => {}).finally(() => { if (closing.get(sessionId) === done) closing.delete(sessionId); });
        closing.set(sessionId, done);
        return done;
      },
    };
    session.providerState = providerState;
    session.close = () => providerState.close();
    options.providerSessionState?.set(CODEX_BRIDGE_PROVIDER, providerState);
    return session;
  }

  const sessionIdOf = ctx => {
    const journalId = ctx.sessionManager.getSessionId();
    const current = providerSessionIds.get(journalId);
    if (current) return current;
    const preserved = branchEntries(ctx).findLast(entry => entry.type === 'compaction' && entry.preserveData?.codexNative)?.preserveData.codexNative;
    return preserved?.providerSessionId ?? journalId;
  };
  function branchEntries(ctx, entries = ctx.sessionManager.getBranch()) {
    const reset = entries.findLastIndex(entry => entry.type === 'reset_boundary');
    return reset < 0 ? entries : entries.slice(reset + 1);
  }
  function lifecycleSession(ctx) {
    if (ctx.model?.provider !== CODEX_BRIDGE_PROVIDER) return undefined;
    const selected = parseCodexModelId(ctx.model.id);
    if (!selected) throw new Error('Unknown native model; no lifecycle operation performed');
    const session = openSession(sessionIdOf(ctx), selected.model, { cwd: ctx.cwd });
    if (session.cwd !== ctx.cwd || session.model !== selected.model) {
      throw new Error('Native lifecycle settings do not match this session record; no native operation performed');
    }
    return session;
  }
  function boundary(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === 'reset_boundary') return null;
      if (entry.type === 'compaction' && entry.preserveData?.codexNative) return entry.preserveData.codexNative;
      if (entry.type !== 'message') continue;
      const message = entry.message;
      if (message.role === 'toolResult' && message.toolName === 'yield') continue;
      if (message.role === 'developer' && message.synthetic) continue;
      const anchor = anchorOf(message);
      if (message.provider === CODEX_BRIDGE_PROVIDER && anchor) return anchor;
      throw new Error('This history point is not a completed native turn; select a completed Codex answer or rewind before the first request');
    }
    return null;
  }
  async function resetSession(session) {
    if (session.threadId) {
      let state = session.client.snapshot(session.threadId);
      if (!state || state.status === 'disconnected') state = await session.client.status(session.threadId);
      if (state?.status === 'inProgress') {
        await session.client.cancel(session.threadId);
        state = await settled(session.client, session.threadId, state.turnId);
      }
      if (state?.outcomeUnknown || !['idle', 'completed', 'failed', 'interrupted'].includes(state?.status)) {
        throw new Error('Native reset cannot confirm the old turn has stopped; no new native thread was created');
      }
    }
    Object.assign(session, {
      threadId: undefined, turnId: undefined, latestResponseId: undefined, opaque: undefined,
      admitted: false, failure: undefined, rewrite: undefined,
    });
    saveSession(stateDir, session);
  }
  async function restoreBoundary(session, anchor, signal) {
    if (anchor === null) return resetSession(session);
    if (!session.threads.has(anchor.threadId)) throw new Error('The selected native thread is not owned by this session; nothing sent');
    if (session.threadId === anchor.threadId && session.latestResponseId === responseId(anchor.threadId, anchor.turnId)) {
      session.rewrite = undefined;
      return;
    }
    if (signal?.aborted) throw new Error('Cancelled before native history fork; nothing sent');
    // A fork changes native history only; no turn/start and no transcript replay.
    const forked = await session.client.fork({
      threadId: anchor.threadId, lastTurnId: anchor.turnId, cwd: session.cwd, model: session.model,
      onThread: threadId => { session.threads.add(threadId); saveSession(stateDir, session); },
    });
    Object.assign(session, {
      threadId: forked.threadId, turnId: forked.turnId, admitted: true, opaque: undefined,
      latestResponseId: responseId(anchor.threadId, anchor.turnId), rewrite: undefined, failure: undefined,
    });
    session.threads.add(forked.threadId);
    saveSession(stateDir, session);
  }

  // Resolves with the snapshot once `turnId` (or, without one, any active turn) is terminal.
  function settled(client, threadId, turnId, signal) {
    return new Promise(resolveSettled => {
      let unsubscribe = () => {};
      const finish = state => {
        unsubscribe();
        signal?.removeEventListener('abort', abort);
        resolveSettled(state);
      };
      const abort = () => finish(undefined);
      const check = () => {
        if (signal?.aborted) return abort();
        const state = client.snapshot(threadId);
        if (!state || (turnId ? state.turnId === turnId && TERMINAL.has(state.status) : state.status !== 'inProgress')) {
          finish(state);
        }
      };
      unsubscribe = client.subscribe(event => { if (event.threadId === threadId) check(); });
      signal?.addEventListener('abort', abort, { once: true });
      check();
    });
  }

  async function steerInputs(session, steering, signal, note) {
    const { client, threadId, turnId } = session;
    while (steering && !signal.aborted) {
      await steering.wait(signal);
      if (signal.aborted) return;
      const claim = await steering.claim(signal);
      if (!claim) { await new Promise(resolveDelay => setTimeout(resolveDelay, 50)); continue; }
      let ids, input, text;
      try {
        ids = claim.messages.map(inputId);
        input = claim.messages.flatMap(inputBlocks);
        text = claim.messages.map(textOf).filter(part => part.trim()).join('\n\n');
      } catch (error) {
        // OMP owns undeliverable input again; every claimed batch must settle exactly once.
        claim.reject();
        note(`steering rejected before submission: ${error.message}`);
        continue;
      }
      // A full record cannot hold the steer: OMP delivers it with the next request, which then stops.
      if (!input.length || signal.aborted || session.sent.size + ids.length > SENT_LIMIT) { claim.reject(); continue; }
      // Recorded first: if OMP requeues this input after an abort, it is not sent again.
      for (const id of ids) session.sent.add(id);
      try { saveSession(stateDir, session); } catch {
        // Unrecorded input is never steered; OMP delivers it with the next request.
        for (const id of ids) session.sent.delete(id);
        claim.reject();
        continue;
      }
      try {
        await client.steer({ threadId, turnId, input });
        claim.accept();
        note(`steered: ${text}`);
      } catch (error) {
        if (error?.outcomeUnknown) {
          // It may already be in the native turn: never send it again.
          claim.accept();
          note(`steer outcome unknown, not resent: ${error.message}`);
        } else {
          for (const id of ids) session.sent.delete(id);
          // ponytail: if this rewrite fails, only the on-disk record still lists the unsent steer; a later revive then refuses it as "already submitted" (fail closed, never a duplicate).
          try { saveSession(stateDir, session); } catch { /* fail closed: see above */ }
          claim.reject();
        }
      }
    }
  }

  async function watchTurn(stream, output, session, options) {
    const { client, threadId, turnId } = session;
    const { signal } = options;
    // Progress stays in a bounded thinking block; the native footer summarizes active workers.
    let progress;
    let progressChars = 0;
    let logTruncated = false;
    let lines = 0;
    let activity = null;
    let plan = null;
    const publish = (state = client.snapshot(threadId)) => {
      if (state?.latestPlan) plan = planLine(state.latestPlan);
      reportProgress(options.sessionId, {
        threadId, turnId, status: state?.status ?? 'unknown', activity, plan,
        execution: state?.execution ?? {
          model: state?.model ?? null, cwd: state?.cwd ?? null, requestedReasoningEffort: null,
        },
        logTruncated,
      });
    };
    const append = (delta) => {
      if (!progress) {
        progress = { type: 'thinking', thinking: '' };
        output.content.push(progress);
        stream.push({ type: 'thinking_start', contentIndex: 0, partial: output });
      }
      progressChars += delta.length;
      progress.thinking += delta;
      stream.push({ type: 'thinking_delta', contentIndex: 0, delta, partial: output });
    };
    const note = (line) => {
      if (!line || logTruncated) return;
      const delta = `${progress?.thinking ? '\n' : ''}[codex ${++lines}] ${clip(line, LINE_CHARS)}`;
      // Reserve the explicit ceiling notice; never grow the transcript beyond its original cap.
      if (progressChars + delta.length > PROGRESS_CHARS - PROGRESS_LIMIT_NOTICE.length) {
        logTruncated = true;
        append(PROGRESS_LIMIT_NOTICE);
        return;
      }
      append(delta);
    };
    const sink = (method, params) => {
      if ((params?.turnId ?? params?.turn?.id) !== turnId) return;
      try {
        const state = client.snapshot(threadId);
        const line = progressLine(method, params, state);
        if (line) activity = clip(line, LINE_CHARS);
        if (method === 'turn/plan/updated') plan = planLine(params);
        note(line);
        publish(state);
      } catch { /* malformed item: no progress line */ }
    };
    const initial = client.snapshot(threadId);
    // Snapshot activity initializes replay only; a newer live event must never be replaced by an older snapshot field.
    if (initial?.latestActivity) {
      const latest = initial.latestActivity;
      const line = progressLine(latest.method, latest.params, initial);
      if (line) activity = clip(line, LINE_CHARS);
    }
    const execution = initial?.execution ?? initial;
    const effortLabel = execution?.requestedReasoningEffort == null ? 'native default (not overridden)' : nativeLabel(execution.requestedReasoningEffort, 32);
    note(`native execution: model ${nativeLabel(execution?.model, 200)}; cwd ${nativeLabel(execution?.cwd, 1000)}; requested effort ${effortLabel}`);
    // Replay the bounded event window, then recover semantic state even when its event was evicted.
    for (const event of initial?.events ?? []) sink(event.method, event.params);
    if (initial?.latestPlan && !(initial.events ?? []).some(event => event.method === 'turn/plan/updated' && event.params?.turnId === turnId)) {
      note(planLine(initial.latestPlan));
    }
    if (initial?.commandFailure && !(initial.events ?? []).some(event => event.params?.item?.id === initial.commandFailure.itemId && event.method === 'item/completed')) {
      note(commandLine({
        id: initial.commandFailure.itemId, command: initial.commandFailure.command,
        status: 'failed', exitCode: initial.commandFailure.exitCode,
      }, initial.commandFailure));
    }
    session.sink = sink;
    publish(initial);

    const ended = new AbortController();
    let abortDetail;
    const interrupted = new Promise(resolveAbort => {
      const interrupt = async () => {
        try {
          await client.cancel(threadId);
          abortDetail = `Codex interrupt requested for turn ${turnId}`;
        } catch (error) {
          abortDetail = `Codex interrupt of turn ${turnId} failed: ${error?.message ?? error}`;
        }
        resolveAbort();
      };
      if (signal?.aborted) void interrupt();
      else signal?.addEventListener('abort', interrupt, { once: true, signal: ended.signal });
    });
    void steerInputs(session, options.liveSteering, ended.signal, note).catch(() => {});

    try {
      const result = await Promise.race([settled(client, threadId, turnId, ended.signal), interrupted.then(() => undefined)]);
      if (progress) stream.push({ type: 'thinking_end', contentIndex: 0, content: progress.thinking, partial: output });
      return { result, abortDetail };
    } finally {
      ended.abort();
      reportProgress(options.sessionId, undefined);
      if (session.sink === sink) session.sink = undefined;
    }
  }

  async function submitInputs(session, fresh, request) {
    const { client } = session;
    const { options, serviceTier, outputSchema, taskName, systemPrompt } = request;
    const { signal } = options;
    let effectiveModel = session.model;
    // A full record cannot hold these ids; checked before any native request, including reads.
    const ids = fresh.map(inputId);
    if (session.sent.size + ids.length > SENT_LIMIT) {
      throw new Error(`codex-bridge sent-input record is full (${SENT_LIMIT} inputs); nothing sent. Start a new task`);
    }
    // An interrupted turn may still be winding down; new input starts a turn, never steers it.
    if (session.threadId && client.snapshot(session.threadId)?.status === 'inProgress') {
      await settled(client, session.threadId, undefined, signal);
      if (signal?.aborted) throw Object.assign(new Error('Cancelled while the previous native turn was ending; no native turn started'), { stopReason: 'aborted' });
    }
    // New input only follows a turn confirmed finished: after a crash the new client knows
    // nothing, and resume/reconcile would otherwise steer into, or race, a still-running turn.
    // status() is read-only (persisted last turn on a new client, reconcile on a live one).
    // ponytail: a turn a dead server left inProgress in history stops this child for good; start a new task.
    if (session.threadId) {
      let last;
      try { last = await client.status(session.threadId); }
      catch (error) { throw new Error(`Previous Codex turn on ${session.threadId} could not be confirmed finished (${error?.message ?? error}); nothing sent`); }
      if (last?.outcomeUnknown || !['idle', 'completed', 'failed', 'interrupted'].includes(last?.status)) {
        throw new Error(`Previous Codex turn ${last?.turnId ?? session.turnId ?? '(unconfirmed)'} on ${session.threadId} is ${last?.status ?? 'unknown'}; not confirmed finished, nothing sent. Interrupt or inspect it with codex_bridge status, or start a new task`);
      }
      effectiveModel ??= last.model;
      // An earlier submission's outcome is unconfirmed (crash or unknown RPC outcome). Only a new,
      // finished native turn proves it was admitted; otherwise its input could be lost or doubled.
      if (session.failure) {
        if (!last?.turnId || last.turnId === session.turnId || !['completed', 'failed', 'interrupted'].includes(last.status)) {
          throw new Error(`An earlier input's Codex submission on ${session.threadId} is unconfirmed (${session.failure}); not resent, nothing sent. Inspect it with codex_bridge status, or start a new task`);
        }
        Object.assign(session, { turnId: last.turnId, admitted: true, failure: undefined });
        try { saveSession(stateDir, session); } catch (error) {
          throw new Error(`codex-bridge could not write its session record (${error?.message ?? error}); nothing sent to Codex`);
        }
      }
    }
    // Only a fresh native thread gets developerInstructions. Existing records already hold the old user-text delegation.
    const system = !session.threadId ? (systemPrompt ?? []).join('\n\n').trim() : '';
    const input = fresh.flatMap(inputBlocks);
    const effort = await nativeEffort(client, effectiveModel, options);
    // Recorded before any native mutation: from here on these inputs are never sent again.
    for (const id of ids) session.sent.add(id);
    // Until admission is confirmed the record says so; the previous turn id stays as the baseline.
    Object.assign(session, { failure: 'Codex submission in flight; outcome unknown', inFlight: true });
    try { saveSession(stateDir, session); } catch (error) {
      for (const id of ids) session.sent.delete(id);
      Object.assign(session, { failure: undefined, inFlight: false });
      throw new Error(`codex-bridge could not write its session record (${error?.message ?? error}); nothing sent to Codex`);
    }
    let snapshot;
    try {
      snapshot = await client.run({
        threadId: session.threadId, input, cwd: options.cwd, model: session.model,
        effort, serviceTier, outputSchema, developerInstructions: system || undefined, signal,
        // A thread whose ID cannot be recorded gets no turn.
        onThread: (threadId) => {
          if (session.threadId !== threadId) {
            session.threadId = threadId;
            session.threads.add(threadId);
            saveSession(stateDir, session);
          }
          if (taskName && (session.nativeName?.threadId !== threadId || session.nativeName.name !== taskName)) {
            session.nativeName = { threadId, name: taskName };
            // Titles are optional metadata; their RPC must not delay or replay task input.
            void client.setThreadName(threadId, taskName).catch(error => {
              try { onNotice?.(`Codex task name could not be saved: ${clip(error.message, 300)}`, 'warning'); } catch { /* UI only. */ }
            });
          }
        },
      });
      session.inFlight = false;
    } catch (error) {
      session.inFlight = false;
      session.threadId ??= typeof error?.threadId === 'string' ? error.threadId : undefined;
      const message = `Codex native submission failed${error?.code ? ` (${error.code})` : ''}: ${error?.message ?? error}`;
      // Without a confirmed thread ID no turn/start was ever sent (an unknown thread/start at most
      // leaves an empty orphan thread), so only then are the inputs definitely undelivered.
      if (error?.outcomeUnknown === true && session.threadId) {
        // The turn may exist: these inputs stay recorded as sent and are never resubmitted.
        Object.assign(session, { admitted: true, failure: `${message}; outcome unknown, not resubmitted` });
      } else {
        // Definitely not admitted: the inputs were not delivered and go with the next new message.
        for (const id of ids) session.sent.delete(id);
        session.failure = undefined;
      }
      let recordError = '';
      try { saveSession(stateDir, session); } catch (saveError) { recordError = `; session record not updated: ${saveError?.message ?? saveError}`; }
      throw new Error((session.failure ?? message) + recordError);
    }
    Object.assign(session, { threadId: snapshot.threadId, turnId: snapshot.turnId, admitted: true, failure: undefined });
    try { saveSession(stateDir, session); } catch (error) {
      throw new Error(`Codex admitted turn ${snapshot.turnId} on thread ${snapshot.threadId}, but the session record could not be written (${error?.message ?? error}); the turn keeps running natively and is not observed here. Inspect it with codex_bridge status`);
    }
  }

  async function drive(stream, model, context, options) {
    const output = {
      role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: zeroUsage(), stopReason: 'stop', timestamp: Date.now(),
    };
    let started = false;
    const start = () => { if (!started) { started = true; stream.push({ type: 'start', partial: output }); } };
    const finish = (reason, errorMessage) => {
      start();
      output.stopReason = reason;
      if (reason === 'error' || reason === 'aborted') {
        output.errorMessage = errorMessage;
        output.errorClassificationMessage = NO_RETRY;
        stream.push({ type: 'error', reason, error: output });
      } else stream.push({ type: 'done', reason, message: output });
    };
    const signal = options.signal;
    const selected = parseCodexModelId(model.id);
    if (!selected) return finish('error', `Unknown codex-bridge model ${model.id}; no native turn started. Select codex-bridge/${DEFAULT_MODEL_ID} or a listed native model and start a new task`);
    const { model: nativeModel } = selected;
    // Side requests (/btw, completion probes) branch from a session and would start unowned turns.
    if (options.parentSessionId) return finish('error', 'codex-bridge does not serve side requests; no native turn started');
    if (!options.sessionId) return finish('error', 'codex-bridge requires a stable session id; no native turn started');
    if (!options.cwd) return finish('error', 'codex-bridge requires the session cwd; no native turn started');
    if (signal?.aborted) return finish('aborted', 'Cancelled before submission; no native turn started');
    let taskName;
    let serviceTier = options.serviceTier;
    if (options.onPayload) {
      const payload = { api: CODEX_BRIDGE_API, sessionId: options.sessionId };
      const request = { sessionId: options.sessionId, captured: false };
      payloadRequests.set(payload, request);
      try {
        const rewritten = await options.onPayload(payload, model, signal);
        if (signal?.aborted) return finish('aborted', 'Cancelled by provider request hooks; no native turn started');
        if (payload.api !== CODEX_BRIDGE_API || payload.sessionId !== options.sessionId
          || rewritten !== undefined && (rewritten?.api !== CODEX_BRIDGE_API || rewritten?.sessionId !== options.sessionId)) {
          return finish('error', 'Provider request hooks changed native request identity; no native turn started');
        }
        if (!request.captured) return finish('error', 'Native request hooks did not supply authoritative session context; no native turn started');
        taskName = request.taskName;
        serviceTier ??= request.serviceTier;
      } finally {
        payloadRequests.delete(payload);
      }
    }
    if (serviceTier === 'auto') serviceTier = undefined;
    const yieldTool = context.tools?.find(tool => tool.name === 'yield');
    if (yieldTool && !outputSchemas.has(options.sessionId)) {
      return finish('error', 'No authoritative session_init output schema metadata is available; no native turn started');
    }
    const outputSchema = nativeOutputSchema(outputSchemas.get(options.sessionId));
    let validateOutput;
    if (outputSchema !== undefined) {
      const api = await import('@oh-my-pi/pi-ai');
      validateOutput = api.validateJsonSchemaValue;
      if (typeof validateOutput !== 'function' || typeof api.isValidJsonSchema !== 'function') {
        return finish('error', 'OMP JSON Schema validation APIs are unavailable; no native turn started');
      }
      if (!api.isValidJsonSchema(outputSchema)) return finish('error', 'session_init.outputSchema is not a supported JSON Schema object; no native turn started');
    }
    if (yieldTool?.parameters?.required?.includes('key')) return finish('error', 'Native completion cannot identify a workpool yield key; no native turn started');
    const complete = (text, turnId, state) => {
      applyUsage(output, state);
      let data;
      if (outputSchema !== undefined) {
        try {
          data = JSON.parse(state?.finalText ?? text);
          const validation = validateOutput(outputSchema, data);
          if (!validation.success) throw new Error(validation.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
        } catch (error) {
          return finish('error', `Codex final output is invalid structured data (${error.message}); native work was not replayed`);
        }
      }
      if (state?.threadId && turnId) output.responseId = responseId(state.threadId, turnId);
      const session = sessions.get(options.sessionId);
      if (session && output.responseId) {
        session.latestResponseId = output.responseId;
        saveSession(stateDir, session);
      }
      const index = output.content.length;
      output.content.push({ type: 'text', text });
      stream.push({ type: 'text_start', contentIndex: index, partial: output });
      if (text) stream.push({ type: 'text_delta', contentIndex: index, delta: text, partial: output });
      stream.push({ type: 'text_end', contentIndex: index, content: text, partial: output });
      if (!yieldTool) return finish('stop');
      const call = { type: 'toolCall', id: `codex-yield-${turnId}`, name: 'yield', arguments: outputSchema === undefined ? { type: 'result' } : { data } };
      output.content.push(call);
      stream.push({ type: 'toolcall_end', contentIndex: index + 1, toolCall: call, partial: output });
      return finish('toolUse');
    };

    const session = openSession(options.sessionId, nativeModel, options);
    if (session.cwd !== options.cwd) {
      return finish('error', `This session's native thread runs in ${session.cwd}; start a new task for ${options.cwd}. No native turn started`);
    }
    if (session.model !== nativeModel) {
      const label = (name) => name ? `native model ${name}` : 'the Codex default model';
      return finish('error', `This session's native thread uses ${label(session.model)}; start a new task for ${label(nativeModel)}. Native model changes are not applied mid-session; no native turn started`);
    }
    // This transcript already talked to Codex, but no record of what was sent exists (deleted,
    // or a rotated provider session id): replaying could rerun native work, so stop.
    if ((!session.recorded || !session.threadId && session.threads.size > 0) && lastAssistant(context.messages, model.provider)) {
      return finish('error', `No codex-bridge session record for this transcript's earlier Codex turns (${session.file}); nothing sent to Codex. Start a new task`);
    }
    start();

    const { client } = session;
    if (session.inFlight) return finish('error', 'A Codex submission for this session is still in flight; nothing sent');
    // A submission that crashed before any thread was confirmed never reached a turn (no
    // turn/start without a recorded thread), so its inputs are undelivered: send them again.
    if (session.failure && !session.threadId) {
      const sent = session.sent;
      Object.assign(session, { sent: new Set(), failure: undefined });
      try { saveSession(stateDir, session); } catch (error) {
        Object.assign(session, { sent, failure: 'Codex submission in flight; outcome unknown' });
        return finish('error', `codex-bridge could not write its session record (${error?.message ?? error}); nothing sent to Codex`);
      }
    }
    const pending = nativeInputs(context.messages);
    const fresh = pending.filter(message => !session.sent.has(inputId(message)));
    if (fresh.length) {
      const visible = anchorOf(lastAssistant(context.messages, model.provider));
      const preserved = contexts.get(options.sessionId);
      if (session.rewrite !== undefined) await restoreBoundary(session, session.rewrite, signal);
      else if (visible && session.latestResponseId && responseId(visible.threadId, visible.turnId) !== session.latestResponseId) {
        await restoreBoundary(session, visible, signal);
      } else if (preserved && !visible && session.threadId !== preserved.threadId) {
        throw new Error('Compacted native continuation anchor does not match the owned thread; nothing sent');
      }
    }
    if (!pending.length) {
      // OMP housekeeping prompt (yield reminder, budget wrap-up): answer from the last native
      // result without any native request.
      const text = textOf(lastAssistant(context.messages, model.provider) ?? { content: '' });
      if (!text.trim()) return finish('error', 'No new input for Codex and no earlier native result; no native turn started');
      const previous = lastAssistant(context.messages, model.provider);
      return complete(text, anchorOf(previous)?.turnId ?? session.turnId, {
        threadId: anchorOf(previous)?.threadId ?? session.threadId,
        finalText: previous?.content?.find?.(block => block.type === 'toolCall' && block.name === 'yield')?.arguments?.data !== undefined
          ? JSON.stringify(previous.content.find(block => block.type === 'toolCall' && block.name === 'yield').arguments.data) : undefined,
      });
    }

    let replayed = false;
    if (fresh.length) {
      try {
        await submitInputs(session, fresh, { options, serviceTier, outputSchema, taskName, systemPrompt: context.systemPrompt });
      } catch (error) {
        return finish(error.stopReason ?? 'error', error.message);
      }
    } else {
      // Every input was already sent (provider retry, revive after crash/dispose, requeued steer):
      // report the turn that received it; never resubmit.
      replayed = true;
      if (session.failure) return finish('error', `${session.failure} (not resubmitted)`);
      if (!session.threadId || !session.turnId) {
        return finish('error', 'This input was already submitted to Codex but its native turn was never confirmed; outcome unknown, not resubmitted');
      }
      if (client.snapshot(session.threadId)?.turnId !== session.turnId) {
        let state;
        try { state = await client.status(session.threadId); }
        catch (error) { return finish('error', `Input already sent to Codex turn ${session.turnId}; its outcome could not be read (${error?.message ?? error}); not resubmitted`); }
        if (state?.turnId !== session.turnId || !TERMINAL.has(state.status)) {
          return finish('error', `Input already sent to Codex turn ${session.turnId}; its outcome is unknown and it was not resubmitted`);
        }
        if (state.status === 'completed') return complete(state.text ?? '', session.turnId, state);
        return finish('error', `This input was already delivered into Codex turn ${session.turnId}, which ended ${state.status}${state.error ? `: ${state.error}` : ''}; not resubmitted. Send a new message to continue`);
      }
    }
    const { threadId, turnId } = session;
    if (!threadId || !turnId) return finish('error', 'Codex native turn identity is unknown; not resubmitted');

    const { result, abortDetail } = await watchTurn(stream, output, session, options);
    if (!result) return finish('aborted', `${abortDetail}; native completion is not confirmed`);
    applyUsage(output, result);
    if (result.status === 'completed') return complete(result.text ?? '', turnId, result);
    const detail = result.error ? `: ${result.error}` : '';
    if (result.status === 'interrupted') {
      if (replayed && !signal?.aborted) return finish('error', `This input was already delivered into interrupted Codex turn ${turnId}; send a new message to continue`);
      return finish(signal?.aborted ? 'aborted' : 'error', `Codex native turn ${turnId} was interrupted${detail}`);
    }
    if (result.status === 'disconnected') {
      return finish('error', `Codex app-server disconnected; outcome of native turn ${turnId} is unknown and was not resubmitted${detail}`);
    }
    return finish('error', `Codex native turn ${turnId} failed${detail || ': no error message'}`);
  }

  function streamSimple(model, context, options = {}) {
    const stream = new EventStream();
    const sessionId = options.sessionId;
    // A revived session starts only after its previous client finished closing.
    const run = Promise.resolve(sessionId && closing.get(sessionId))
      .then(() => drive(stream, model, context, options));
    if (sessionId) {
      const tracked = run.catch(() => {});
      runs.set(sessionId, tracked);
      tracked.then(() => { if (runs.get(sessionId) === tracked) runs.delete(sessionId); });
    }
    run.catch(error => {
      stream.push({
        type: 'error', reason: 'error',
        error: {
          role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          usage: zeroUsage(), stopReason: 'error', timestamp: Date.now(),
          errorMessage: `codex-bridge provider failed: ${error?.message ?? error}`,
          errorClassificationMessage: NO_RETRY,
        },
      });
    });
    return stream;
  };
  streamSimple.closeAll = async () => {
    const owned = [...sessions.values()];
    await Promise.all(owned.map(async session => {
      if (session.threadId && session.client.snapshot(session.threadId)?.status === 'inProgress') {
        try { await session.client.cancel(session.threadId); } catch { /* closing still tears down transport */ }
      }
      await session.close();
    }));
    await Promise.all(closing.values());
    contexts.clear();
    outputSchemas.clear();
    providerSessionIds.clear();
    branchedSessions.clear();
  };
  streamSimple.close = async sessionId => {
    sessionId = providerSessionIds.get(sessionId) ?? sessionId;
    const session = sessions.get(sessionId);
    if (session) {
      if (session.threadId && session.client.snapshot(session.threadId)?.status === 'inProgress') {
        try { await session.client.cancel(session.threadId); } catch { /* close still tears down transport */ }
      }
      await session.close();
    }
    await closing.get(sessionId);
    contexts.delete(sessionId);
    outputSchemas.delete(sessionId);
  };
  streamSimple.clear = async sessionId => {
    sessionId = providerSessionIds.get(sessionId) ?? sessionId;
    await closing.get(sessionId);
    let session = sessions.get(sessionId);
    contexts.delete(sessionId);
    outputSchemas.delete(sessionId);
    if (!session) {
      // Load only this session's durable record; never delete old native thread history.
      const record = readSessionRecord(sessionFile(stateDir, sessionId));
      if (record === undefined) return;
      session = openSession(sessionId, record.model, { cwd: record.cwd });
    }
    // OMP closes provider state before session_clear and rotates the next request's UUID.
    // A client reopened to confirm reset must not survive as an unregistered old-session server.
    try { await resetSession(session); }
    finally { await session.close(); }
  };
  function captureContext(_event, ctx, sessionId) {
    const branch = ctx.sessionManager.getBranch();
    const entries = branchEntries(ctx, branch);
    const opaque = entries.findLast(entry => entry.type === 'compaction' && entry.preserveData?.codexNative)?.preserveData.codexNative;
    const journalId = ctx.sessionManager.getSessionId();
    sessionId ??= providerSessionIds.get(journalId) ?? opaque?.providerSessionId ?? journalId;
    const init = branch.findLast(entry => entry.type === 'session_init');
    if (init) outputSchemas.set(sessionId, init.outputSchema);
    else outputSchemas.delete(sessionId);
    if (!opaque) { contexts.delete(sessionId); return; }
    if (ctx.model?.provider !== CODEX_BRIDGE_PROVIDER || ctx.model.id !== opaque.ompModel) {
      ctx.abort();
      const error = 'This branch contains opaque Codex compaction; use the original codex-bridge model, /clear, or rewind to raw history before switching providers';
      ctx.ui.notify(error, 'error');
      throw new Error(error);
    }
    contexts.set(sessionId, opaque);
    // OMP emits this role before convertToLlm wraps it as user text. Native history already holds it.
    if (_event.messages) return { messages: _event.messages.filter(message => message.role !== 'compactionSummary') };
  }
  streamSimple.prepareBranch = async (event, ctx) => {
    if (ctx.model?.provider !== CODEX_BRIDGE_PROVIDER) {
      try { captureContext({}, ctx); } catch { return { cancel: true }; }
      return;
    }
    try {
      const sourceId = sessionIdOf(ctx);
      await closing.get(sourceId);
      const source = lifecycleSession(ctx);
      if (source.inFlight || source.failure) throw new Error('Native submission is not confirmed; branching cannot replay or abandon it');
      if (source.threadId) {
        const state = await source.client.status(source.threadId);
        if (state.outcomeUnknown || !['idle', 'completed', 'failed', 'interrupted'].includes(state.status)) {
          throw new Error('Native turn is not confirmed finished; branch after it settles');
        }
      }
      let entries = branchEntries(ctx);
      if (event.entryId !== undefined) {
        const target = ctx.sessionManager.getEntry(event.entryId);
        if (!target) throw new Error('The selected branch entry does not exist');
        const leaf = event.reason === 'branch' ? target.parentId : target.id;
        entries = leaf ? branchEntries(ctx, ctx.sessionManager.getBranch(leaf)) : [];
      }
      const anchor = boundary(entries);
      if (anchor && !source.threads.has(anchor.threadId)) throw new Error('The selected native thread is not owned by this session');
      return {
        sourceId, anchor,
        session: { ...source, sent: new Set(source.sent), threads: new Set(source.threads) },
      };
    } catch (error) {
      ctx.ui.notify(`Codex branch stopped: ${error.message}`, 'error');
      return { cancel: true };
    }
  };
  streamSimple.adoptBranch = (prepared, ctx) => {
    if (!prepared || prepared.cancel) return;
    const journalId = ctx.sessionManager.getSessionId();
    if (journalId === prepared.sourceId) throw new Error('OMP branch did not create a new session identity; no native operation performed');
    const session = {
      ...prepared.session, file: sessionFile(stateDir, journalId),
      // Force a native fork even when the source checkpoint was its latest visible answer.
      latestResponseId: undefined, rewrite: prepared.anchor,
    };
    saveSession(stateDir, session);
    providerSessionIds.set(journalId, journalId);
    branchedSessions.set(journalId, session);
  };
  streamSimple.context = (event, ctx) => captureContext(event, ctx);
  streamSimple.beforeProviderRequest = (event, ctx, metadata = {}) => {
    const request = payloadRequests.get(event.payload);
    if (!request) return;
    if (event.payload.api !== CODEX_BRIDGE_API || event.payload.sessionId !== request.sessionId) {
      throw new Error('Native provider request identity changed; no native work admitted');
    }
    const journalId = ctx.sessionManager.getSessionId();
    const branch = branchedSessions.get(journalId);
    if (branch && request.sessionId !== journalId) {
      if (sessions.has(journalId)) throw new Error('Native branch identity changed after lifecycle admission; nothing sent');
      saveSession(stateDir, { ...branch, file: sessionFile(stateDir, request.sessionId) });
    }
    captureContext({}, ctx, request.sessionId);
    providerSessionIds.set(ctx.sessionManager.getSessionId(), request.sessionId);
    const title = ctx.sessionManager.getSessionName?.();
    request.taskName = typeof title === 'string' && title.trim() ? title
      : ctx.agent?.kind === 'sub' && typeof ctx.agent.id === 'string' ? ctx.agent.id : undefined;
    request.serviceTier = metadata.serviceTier;
    request.captured = true;
    branchedSessions.delete(journalId);
    return event.payload;
  };
  streamSimple.beforeCompact = async (event, ctx) => {
    if (ctx.model?.provider !== CODEX_BRIDGE_PROVIDER) {
      try { streamSimple.context(event, ctx); } catch { return { cancel: true }; }
      return;
    }
    let compacting;
    try {
      if (event.customInstructions?.trim()) throw new Error('Native Codex compaction does not accept summary focus instructions');
      await closing.get(sessionIdOf(ctx));
      const session = lifecycleSession(ctx);
      if (!session?.threadId || session.failure) throw new Error('No confirmed native thread is available to compact');
      if (session.inFlight) throw new Error('Native turn is still settling; compact after it finishes');
      if (session.rewrite !== undefined) await restoreBoundary(session, session.rewrite, event.signal);
      if (!session.threadId) throw new Error('The selected history boundary has no native thread to compact');
      const status = await session.client.status(session.threadId);
      if (status.outcomeUnknown || !['completed', 'failed', 'interrupted', 'idle'].includes(status.status)) throw new Error('Native turn is not confirmed finished');
      await session.client.resume({ threadId: session.threadId, cwd: session.cwd, model: session.model });
      compacting = session;
      session.failure = 'Native compaction admission is unconfirmed; not replayed';
      saveSession(stateDir, session);
      const result = await session.client.compact({ threadId: session.threadId, signal: event.signal });
      if (result.status !== 'completed') throw new Error(`Native compaction ended ${result.status}: ${result.error ?? 'no summary exposed'}`);
      const opaque = {
        version: 1, threadId: session.threadId, turnId: result.turnId, cwd: session.cwd,
        ompModel: ctx.model.id, visibleResponseId: session.latestResponseId,
        providerSessionId: sessionIdOf(ctx),
      };
      Object.assign(session, { turnId: result.turnId, opaque, failure: undefined });
      saveSession(stateDir, session);
      contexts.set(sessionIdOf(ctx), opaque);
      return {
        compaction: {
          summary: 'Codex compacted its native thread. The app-server exposes no readable summary. Continue with the original codex-bridge model.',
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details: {
            kind: 'codex-bridge-opaque', summaryAvailable: false, cost: 'unknown',
            nativeUsage: result.tokenUsage, nativeTurnUsage: result.turnUsage,
          },
          preserveData: { ...event.preparation.previousPreserveData, codexNative: opaque },
        },
      };
    } catch (error) {
      if (compacting && !error.outcomeUnknown) {
        compacting.failure = undefined;
        try { saveSession(stateDir, compacting); } catch { /* preserve the durable uncertain marker on write failure */ }
      }
      ctx.ui.notify(`Codex compaction stopped: ${error.message}`, 'error');
      return { cancel: true };
    }
  };
  streamSimple.afterCompact = (event, ctx) => {
    const opaque = event.compactionEntry?.preserveData?.codexNative;
    if (opaque) contexts.set(sessionIdOf(ctx), opaque);
  };
  streamSimple.beforeTree = async (event, ctx) => {
    if (ctx.model?.provider !== CODEX_BRIDGE_PROVIDER) {
      if (event.preparation.userWantsSummary && branchEntries(ctx).some(entry => entry.preserveData?.codexNative)) {
        ctx.ui.notify('This branch contains opaque Codex history; navigate without a summary or rewind to raw history first', 'error');
        return { cancel: true };
      }
      return;
    }
    try {
      if (event.preparation.userWantsSummary) throw new Error('Native branch summaries are not exposed; choose navigation without a summary');
      const target = ctx.sessionManager.getEntry(event.preparation.targetId);
      const rewind = target?.type === 'custom_message'
        || target?.type === 'message' && target.message.role === 'user';
      const leaf = rewind ? target.parentId : target?.id;
      const anchor = boundary(leaf ? ctx.sessionManager.getBranch(leaf) : []);
      if (anchor && !lifecycleSession(ctx).threads.has(anchor.threadId)) throw new Error('The selected native thread is not owned by this session');
    } catch (error) {
      ctx.ui.notify(error.message, 'error');
      return { cancel: true };
    }
  };
  streamSimple.afterTree = (_event, ctx) => {
    const session = lifecycleSession(ctx);
    if (!session) return;
    session.rewrite = boundary(branchEntries(ctx));
    saveSession(stateDir, session);
    streamSimple.context(_event, ctx);
  };
  return streamSimple;
}
