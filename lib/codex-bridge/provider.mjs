// Command-backed OMP provider: one Codex app-server thread per OMP provider session.
// Codex owns inference, native tools, approvals and its persisted thread; OMP receives only
// assistant events. Native activity streams as a thinking block, never as executable OMP tool calls.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexNativeClient } from './client.mjs';

export const CODEX_NATIVE_PROVIDER = 'codex-bridge';
export const CODEX_NATIVE_API = 'codex-bridge-app-server';
// Every codex-bridge thread runs workspace-write: writable only at the session cwd, network and
// temp dirs off, approvals never. The OMP model id selects only the native model, explicitly
// (agent frontmatter or model switch), never inferred from prompt text: `default` runs Codex's
// configured default model; any other id is a native model slug discovered via native model/list.
const SANDBOX = 'workspace-write';
export const DEFAULT_MODEL_ID = 'default';
// Native slugs OMP selectors cannot express (whitespace, CSV comma, glob characters) are never offered or run.
// Retired `<sandbox>[--<model>]` ids are refused, never mapped onto workspace-write.
const UNSELECTABLE = /[\s,*?{}[\]\0]|^(read-only|workspace-write)(--|$)/;

// { model } for a codex-bridge OMP model id (model undefined = Codex default), else undefined.
export function parseCodexNativeModelId(id) {
  if (id === DEFAULT_MODEL_ID) return { model: undefined };
  if (typeof id !== 'string' || !id || UNSELECTABLE.test(id)) return undefined;
  return { model: id };
}

const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'disconnected']);
const LINE_CHARS = 2000;
const PROGRESS_CHARS = 64 * 1024;
// Sent ids are never evicted (an evicted id could be resent); a full record stops new sends.
const SENT_LIMIT = 5000;
// Classification text for every error this provider reports. OMP auto-retry classifies errors
// from this field; native failures (usage limits, disconnects) must not trigger a replay.
const NO_RETRY = 'codex-bridge: native outcome reported; provider requests are not replayed';

// The default advertises native input/effort support before discovery; explicit catalog limits win.
// Zero prices mean unknown subscription cost.
const profile = (id, name, native = {}) => ({
  id,
  name,
  reasoning: native.supportedReasoningEfforts == null ? id === DEFAULT_MODEL_ID : native.supportedReasoningEfforts.length > 0,
  input: (native.inputModalities?.includes('image') ?? id === DEFAULT_MODEL_ID) ? ['text', 'image'] : ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: native.contextWindow ?? 1_000_000,
  maxTokens: 128_000,
});
export const CODEX_NATIVE_MODELS = [profile(DEFAULT_MODEL_ID, 'Codex native (native usage when available; cost unknown)')];

// OMP fetchDynamicModels: the default profile plus one per native model/list entry. One short-lived
// app-server (initialize + model/list only, never a thread), always closed.
export async function fetchCodexNativeModels({ createClient = options => new CodexNativeClient(options) } = {}) {
  const client = createClient({ timeoutMs: 5000 });
  try {
    const listed = await client.listModels();
    const defaultModel = listed.find(entry => entry.isDefault);
    return [
      profile(DEFAULT_MODEL_ID, CODEX_NATIVE_MODELS[0].name, defaultModel),
      ...listed.filter(entry => entry.model !== DEFAULT_MODEL_ID && parseCodexNativeModelId(entry.model))
        .map(entry => profile(entry.model, `Codex native on ${entry.model} (cost unknown)`, entry)),
    ];
  } finally {
    await client.close();
  }
}

const zeroUsage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const textOf = (message) => typeof message.content === 'string' ? message.content
  : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');

function inputBlocks(message) {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content, text_elements: [] }];
  return (message.content ?? []).flatMap(block => {
    if (block.type === 'text') return [{ type: 'text', text: block.text, text_elements: [] }];
    if (block.type !== 'image') return [];
    if (typeof block.mimeType !== 'string' || !/^image\/[\w.+-]+$/.test(block.mimeType)
      || typeof block.data !== 'string' || !block.data) throw new Error('Invalid OMP image MIME type or data; nothing sent to Codex');
    if (block.data.startsWith('data:') && !block.data.startsWith(`data:${block.mimeType};base64,`)) {
      throw new Error('OMP image data URL does not match its MIME type; nothing sent to Codex');
    }
    return [{ type: 'image', url: block.data.startsWith('data:') ? block.data : `data:${block.mimeType};base64,${block.data}` }];
  });
}

// Keep text-only identities compatible with durable records written before image support.
export const inputId = (message) => {
  const images = typeof message.content === 'string' ? [] : (message.content ?? []).filter(block => block.type === 'image');
  return `${message.timestamp}:${sha256(images.length ? JSON.stringify([textOf(message), images]) : textOf(message)).slice(0, 32)}`;
};

const responseId = (threadId, turnId) => `codex-bridge:${encodeURIComponent(threadId)}:${encodeURIComponent(turnId)}`;
function anchorOf(message) {
  if (message?.stopReason !== 'stop' && message?.stopReason !== 'toolUse') return undefined;
  const match = /^codex-bridge:([^:]+):([^:]+)$/.exec(message.responseId ?? '');
  return match ? { threadId: decodeURIComponent(match[1]), turnId: decodeURIComponent(match[2]) } : undefined;
}

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

async function nativeEffort(client, selectedModel, options) {
  const effort = options.disableReasoning || options.reasoning === 'off' ? 'none' : options.reasoning;
  if (effort === undefined) return undefined;
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) {
    throw new Error(`OMP reasoning effort ${options.reasoning} has no native Codex equivalent; no native turn started`);
  }
  const models = await client.listModels();
  const selected = models.find(entry => selectedModel ? entry.model === selectedModel : entry.isDefault);
  const supported = selected?.supportedReasoningEfforts?.map(entry => typeof entry === 'string' ? entry : entry.reasoningEffort);
  if (!supported?.includes(effort)) throw new Error(`Native model ${selectedModel ?? '(default)'} does not advertise reasoning effort ${effort}; no native turn started`);
  return effort;
}

function nativeOutputSchema(raw) {
  if (raw === undefined || raw === null) return undefined;
  const schema = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('codex-bridge requires an object JSON Schema in session_init.outputSchema; no native turn started');
  }
  // Reject JTD-only constraints instead of forwarding them as ignored JSON Schema annotations.
  const pending = [schema];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    if (['optionalProperties', 'elements', 'values', 'discriminator', 'mapping', 'nullable'].some(key => Object.hasOwn(node, key))) {
      throw new Error('codex-bridge accepts JSON Schema output only; JTD/nullable conversion is unavailable, no native turn started');
    }
    for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
      if (node[key] && typeof node[key] === 'object') pending.push(...Object.values(node[key]));
    }
    for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
      if (Array.isArray(node[key])) pending.push(...node[key]);
    }
    for (const key of ['items', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'not', 'if', 'then', 'else', 'contains', 'propertyNames']) {
      if (node[key] && typeof node[key] === 'object') pending.push(node[key]);
    }
  }
  return schema;
}

const clip = (text, limit) => text.length > limit ? `${text.slice(0, limit)}…` : text;

// Native input = messages since the last successful assistant turn that a person or peer sent:
// user prompts and non-synthetic developer messages (parent IRC, async results, file mentions).
// Errored/aborted assistant turns do not end the window: input before them may never have reached
// Codex (a definite rejection), and the session's sent-id record filters what did. Excluded:
// synthetic prompts (yield reminders, budget wrap-ups), hidden `<system-reminder>` notices, and
// user input a live steer already delivered into a native turn.
export function nativeInputs(messages) {
  const tail = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant') {
      if (message.stopReason === 'error' || message.stopReason === 'aborted') continue;
      break;
    }
    if (message.liveSteered || (!textOf(message).trim() && !(Array.isArray(message.content) && message.content.some(block => block.type === 'image')))) continue;
    if (message.role === 'user') tail.unshift(message);
    else if (message.role === 'developer' && !message.synthetic && !textOf(message).trimStart().startsWith('<system-reminder>')) {
      tail.unshift(message);
    }
  }
  return tail;
}

function lastAssistant(messages, provider) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant' && message.provider === provider) return message;
  }
  return undefined;
}

function progressLine(method, params) {
  if (method === 'thread/tokenUsage/updated' && params.tokenUsage?.modelContextWindow != null) {
    return `native context ${params.tokenUsage.last.totalTokens}/${params.tokenUsage.modelContextWindow} tokens`;
  }
  if (method === 'turn/started') return `turn ${params.turn?.id ?? ''} started`;
  if (method === 'error') return `error: ${params.error?.message ?? 'Codex reported an error'}`;
  if (method === 'model/rerouted') return `model rerouted ${params.fromModel} → ${params.toModel} (${params.reason})`;
  const item = params.item;
  if (!item) return undefined;
  if (method === 'item/started') {
    if (item.type === 'commandExecution') return `$ ${item.command}`;
    if (item.type === 'mcpToolCall') return `mcp ${item.server}.${item.tool} started`;
    return undefined;
  }
  if (method !== 'item/completed') return undefined;
  switch (item.type) {
    case 'agentMessage': return item.phase === 'final_answer' ? undefined : item.text;
    case 'reasoning': return item.summary?.length ? item.summary.join('\n') : undefined;
    case 'plan': return `plan: ${item.text}`;
    case 'commandExecution': return `$ ${item.command} → ${item.status}${item.exitCode == null ? '' : ` (exit ${item.exitCode})`}`;
    case 'fileChange': return `files ${item.status}: ${(item.changes ?? []).map(change => change.path).join(', ')}`;
    case 'mcpToolCall': return `mcp ${item.server}.${item.tool} → ${item.status}`;
    case 'userMessage': return undefined;
    default: return `${item.type} done`;
  }
}

/**
 * Returns the provider's `streamSimple`. Create it once per module: OMP's custom-API registry is
 * process-global and the latest registration wins, so every child session must reach the same
 * session table. Each `options.sessionId` owns its own client and thread; teardown of
 * one session (provider state `close()`) never touches another.
 *
 * `stateDir` holds one small record per session (file name = sha256 of the session id): sandbox,
 * cwd, native thread id, latest admitted turn id and the ids of every input already sent. It is
 * written before each native mutation, so a crash, dispose, revive or OMP requeue never sends
 * the same input to Codex twice.
 */
export function createCodexNativeStream({ EventStream, stateDir, onRequest, createClient = options => new CodexNativeClient(options) }) {
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir must be a nonempty path');
  const bindings = new Map();
  // Latest drive per session, and the closing teardown a new binding of that session awaits.
  const runs = new Map();
  const closing = new Map();
  const contexts = new Map();
  const outputSchemas = new Map();
  const payloadRequests = new WeakMap();
  const providerSessionIds = new Map();
  const delay = (ms) => new Promise(resolveDelay => setTimeout(resolveDelay, ms).unref?.());
  // Bound for each teardown wait (run's interrupt admission, native turn settling).
  const CLOSE_WAIT_MS = 10_000;

  // Throws on any write failure; callers stop before (or report after) the native mutation.
  function save(binding) {
    const { sandbox, model, cwd, threadId, turnId, admitted, failure, sent, latestResponseId, opaque, rewrite } = binding;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${binding.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({
      sandbox, model, cwd, threadId, turnId, admitted, failure, sent: [...sent],
      latestResponseId, opaque, rewrite, threads: [...binding.threads],
    }), { mode: 0o600 });
    renameSync(temporary, binding.file);
    binding.recorded = true;
  }

  // `nativeModel` undefined = Codex default model. A record without `model` (default or written
  // before model selection existed) stays on the default; it is never upgraded to a pinned model.
  // A record's sandbox is kept only to refuse threads recorded before every thread ran workspace-write.
  function bind(sessionId, nativeModel, options) {
    let binding = bindings.get(sessionId);
    if (binding) return binding;
    // sha256 only makes the session id filename-safe.
    const file = join(stateDir, `${sha256(sessionId)}.json`);
    let record;
    try { record = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`codex-bridge session record ${file} is unreadable (${error.message}); nothing sent to Codex. Inspect or remove it, then start a new task`);
    }
    if (record !== undefined && (record === null || typeof record !== 'object' || !Array.isArray(record.sent)
      || (record.sandbox !== SANDBOX && record.sandbox !== 'read-only') || typeof record.cwd !== 'string'
      || (record.model != null && (typeof record.model !== 'string' || !record.model)))) {
      throw new Error(`codex-bridge session record ${file} is malformed; nothing sent to Codex. Inspect or remove it, then start a new task`);
    }
    binding = {
      file, recorded: record !== undefined, sandbox: record?.sandbox ?? SANDBOX, cwd: record?.cwd ?? options.cwd,
      model: record ? record.model ?? undefined : nativeModel,
      threadId: record?.threadId ?? undefined, turnId: record?.turnId ?? undefined, failure: record?.failure ?? undefined,
      // True once Codex admitted (or may have admitted) a turn: the system prompt went with it.
      admitted: record?.admitted === true, sent: new Set(record?.sent ?? []), sink: undefined,
      latestResponseId: record?.latestResponseId, opaque: record?.opaque,
      rewrite: record?.rewrite,
      threads: new Set(record?.threads ?? (record?.threadId ? [record.threadId] : [])),
    };
    binding.client = createClient({
      onNotification: (method, params) => binding.sink?.(method, params),
      onRequest: onRequest?.forClient?.() ?? onRequest,
    });
    bindings.set(sessionId, binding);
    // OMP closes provider session state on dispose, park, kill, new/fresh session and reload.
    // ponytail: records are never pruned (one small file per session); prune by mtime if it matters.
    const providerState = {
      close() {
        if (bindings.get(sessionId) === binding) bindings.delete(sessionId);
        binding.sink = undefined;
        // OMP closes right after aborting a run; killing the app-server now could leave the native
        // turn unconfirmed (and the revived child stopped). Let the run's interrupt land and the
        // turn settle first, each bounded, then close.
        const done = (async () => {
          await Promise.race([runs.get(sessionId) ?? Promise.resolve(), delay(CLOSE_WAIT_MS)]);
          const { threadId, turnId } = binding;
          if (threadId && turnId && binding.client.snapshot(threadId)?.status === 'inProgress') {
            await Promise.race([settled(binding.client, threadId, turnId), delay(CLOSE_WAIT_MS)]);
          }
          await binding.client.close();
        })().catch(() => {}).finally(() => { if (closing.get(sessionId) === done) closing.delete(sessionId); });
        closing.set(sessionId, done);
        return done;
      },
    };
    binding.close = () => providerState.close();
    options.providerSessionState?.set(CODEX_NATIVE_PROVIDER, providerState);
    return binding;
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
  function lifecycleBinding(ctx) {
    if (ctx.model?.provider !== CODEX_NATIVE_PROVIDER) return undefined;
    const selected = parseCodexNativeModelId(ctx.model.id);
    if (!selected) throw new Error('Unknown native model; no lifecycle operation performed');
    const binding = bind(sessionIdOf(ctx), selected.model, { cwd: ctx.cwd });
    if (binding.sandbox !== SANDBOX || binding.cwd !== ctx.cwd || binding.model !== selected.model) {
      throw new Error('Native lifecycle settings do not match this session record; no native operation performed');
    }
    return binding;
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
      if (message.provider === CODEX_NATIVE_PROVIDER && anchor) return anchor;
      throw new Error('This history point is not a completed native turn; select a completed Codex answer or rewind before the first request');
    }
    return null;
  }
  async function resetBinding(binding) {
    if (binding.threadId) {
      let state = binding.client.snapshot(binding.threadId);
      if (!state || state.status === 'disconnected') state = await binding.client.status(binding.threadId);
      if (state?.status === 'inProgress') {
        await binding.client.cancel(binding.threadId);
        state = await settled(binding.client, binding.threadId, state.turnId);
      }
      if (state?.outcomeUnknown || !['idle', 'completed', 'failed', 'interrupted'].includes(state?.status)) {
        throw new Error('Native reset cannot confirm the old turn has stopped; no new native thread was created');
      }
    }
    Object.assign(binding, {
      threadId: undefined, turnId: undefined, latestResponseId: undefined, opaque: undefined,
      admitted: false, failure: undefined, rewrite: undefined,
    });
    save(binding);
  }
  async function restoreBoundary(binding, anchor, signal) {
    if (anchor === null) return resetBinding(binding);
    if (!binding.threads.has(anchor.threadId)) throw new Error('The selected native thread is not owned by this session; nothing sent');
    if (binding.threadId === anchor.threadId && binding.latestResponseId === responseId(anchor.threadId, anchor.turnId)) {
      binding.rewrite = undefined;
      return;
    }
    if (signal?.aborted) throw new Error('Cancelled before native history fork; nothing sent');
    // A fork changes native history only; no turn/start and no transcript replay.
    const forked = await binding.client.fork({
      threadId: anchor.threadId, lastTurnId: anchor.turnId, cwd: binding.cwd, model: binding.model,
      onThread: threadId => { binding.threads.add(threadId); save(binding); },
    });
    Object.assign(binding, {
      threadId: forked.threadId, turnId: forked.turnId, admitted: true, opaque: undefined,
      latestResponseId: responseId(anchor.threadId, anchor.turnId), rewrite: undefined, failure: undefined,
    });
    binding.threads.add(forked.threadId);
    save(binding);
  }

  // Resolves with the snapshot once `turnId` (or, without one, any active turn) is terminal.
  function settled(client, threadId, turnId, signal) {
    return new Promise(resolveSettled => {
      let unsubscribe = () => {};
      const check = () => {
        const state = client.snapshot(threadId);
        if (!state || (turnId ? state.turnId === turnId && TERMINAL.has(state.status) : state.status !== 'inProgress')) {
          unsubscribe();
          resolveSettled(state);
        }
      };
      unsubscribe = client.subscribe(event => { if (event.threadId === threadId) check(); });
      signal?.addEventListener('abort', unsubscribe, { once: true });
      check();
    });
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
    const selected = parseCodexNativeModelId(model.id);
    if (!selected) return finish('error', `Unknown codex-bridge model ${model.id}; no native turn started. Select codex-bridge/${DEFAULT_MODEL_ID} or a listed native model and start a new task`);
    const { model: nativeModel } = selected;
    // Side requests (/btw, completion probes) branch from a session and would start unowned turns.
    if (options.parentSessionId) return finish('error', 'codex-bridge does not serve side requests; no native turn started');
    if (!options.sessionId) return finish('error', 'codex-bridge requires a stable session id; no native turn started');
    if (!options.cwd) return finish('error', 'codex-bridge requires the session cwd; no native turn started');
    if (signal?.aborted) return finish('aborted', 'Cancelled before submission; no native turn started');
    if (options.onPayload) {
      const payload = { api: CODEX_NATIVE_API, sessionId: options.sessionId };
      const request = { sessionId: options.sessionId, captured: false };
      payloadRequests.set(payload, request);
      try {
        const rewritten = await options.onPayload(payload, model, signal);
        if (signal?.aborted) return finish('aborted', 'Cancelled by provider request hooks; no native turn started');
        if (payload.api !== CODEX_NATIVE_API || payload.sessionId !== options.sessionId
          || rewritten !== undefined && (rewritten?.api !== CODEX_NATIVE_API || rewritten?.sessionId !== options.sessionId)) {
          return finish('error', 'Provider request hooks changed native request identity; no native turn started');
        }
        if (!request.captured) return finish('error', 'Native request hooks did not supply authoritative session context; no native turn started');
      } finally {
        payloadRequests.delete(payload);
      }
    }
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
      const binding = bindings.get(options.sessionId);
      if (binding && output.responseId) {
        binding.latestResponseId = output.responseId;
        save(binding);
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

    const binding = bind(options.sessionId, nativeModel, options);
    // Never upgraded: the earlier turns of a read-only record ran without write access.
    if (binding.sandbox !== SANDBOX) {
      return finish('error', `This session's native thread ran ${binding.sandbox}; read-only Codex threads are not continued; start a new task. No native turn started`);
    }
    if (binding.cwd !== options.cwd) {
      return finish('error', `This session's native thread runs in ${binding.cwd}; start a new task for ${options.cwd}. No native turn started`);
    }
    if (binding.model !== nativeModel) {
      const label = (name) => name ? `native model ${name}` : 'the Codex default model';
      return finish('error', `This session's native thread uses ${label(binding.model)}; start a new task for ${label(nativeModel)}. Native model changes are not applied mid-session; no native turn started`);
    }
    // This transcript already talked to Codex, but no record of what was sent exists (deleted,
    // or a rotated provider session id): replaying could rerun native work, so stop.
    if ((!binding.recorded || !binding.threadId && binding.threads.size > 0) && lastAssistant(context.messages, model.provider)) {
      return finish('error', `No codex-bridge session record for this transcript's earlier Codex turns (${binding.file}); nothing sent to Codex. Start a new task`);
    }
    start();

    const { client } = binding;
    if (binding.inFlight) return finish('error', 'A Codex submission for this session is still in flight; nothing sent');
    // A submission that crashed before any thread was confirmed never reached a turn (no
    // turn/start without a recorded thread), so its inputs are undelivered: send them again.
    if (binding.failure && !binding.threadId) {
      const sent = binding.sent;
      Object.assign(binding, { sent: new Set(), failure: undefined });
      try { save(binding); } catch (error) {
        Object.assign(binding, { sent, failure: 'Codex submission in flight; outcome unknown' });
        return finish('error', `codex-bridge could not write its session record (${error?.message ?? error}); nothing sent to Codex`);
      }
    }
    const pending = nativeInputs(context.messages);
    const fresh = pending.filter(message => !binding.sent.has(inputId(message)));
    if (fresh.length) {
      const visible = anchorOf(lastAssistant(context.messages, model.provider));
      const preserved = contexts.get(options.sessionId);
      if (binding.rewrite !== undefined) await restoreBoundary(binding, binding.rewrite, signal);
      else if (visible && binding.latestResponseId && responseId(visible.threadId, visible.turnId) !== binding.latestResponseId) {
        await restoreBoundary(binding, visible, signal);
      } else if (preserved && !visible && binding.threadId !== preserved.threadId) {
        throw new Error('Compacted native continuation anchor does not match the owned thread; nothing sent');
      }
    }
    if (!pending.length) {
      // OMP housekeeping prompt (yield reminder, budget wrap-up): answer from the last native
      // result without any native request.
      const text = textOf(lastAssistant(context.messages, model.provider) ?? { content: '' });
      if (!text.trim()) return finish('error', 'No new input for Codex and no earlier native result; no native turn started');
      const previous = lastAssistant(context.messages, model.provider);
      return complete(text, anchorOf(previous)?.turnId ?? binding.turnId, {
        threadId: anchorOf(previous)?.threadId ?? binding.threadId,
        finalText: previous?.content?.find?.(block => block.type === 'toolCall' && block.name === 'yield')?.arguments?.data !== undefined
          ? JSON.stringify(previous.content.find(block => block.type === 'toolCall' && block.name === 'yield').arguments.data) : undefined,
      });
    }

    let replayed = false;
    if (fresh.length) {
      // A full record cannot hold these ids; checked before any native request, including reads.
      const ids = fresh.map(inputId);
      if (binding.sent.size + ids.length > SENT_LIMIT) {
        return finish('error', `codex-bridge sent-input record is full (${SENT_LIMIT} inputs); nothing sent. Start a new task`);
      }
      // An interrupted turn may still be winding down; new input starts a turn, never steers it.
      if (binding.threadId && client.snapshot(binding.threadId)?.status === 'inProgress') {
        await settled(client, binding.threadId, undefined, signal);
        if (signal?.aborted) return finish('aborted', 'Cancelled while the previous native turn was ending; no native turn started');
      }
      // New input only follows a turn confirmed finished: after a crash the new client knows
      // nothing, and resume/reconcile would otherwise steer into, or race, a still-running turn.
      // status() is read-only (persisted last turn on a new client, reconcile on a live one).
      // ponytail: a turn a dead server left inProgress in history stops this child for good; start a new task.
      if (binding.threadId) {
        let last;
        try { last = await client.status(binding.threadId); }
        catch (error) { return finish('error', `Previous Codex turn on ${binding.threadId} could not be confirmed finished (${error?.message ?? error}); nothing sent`); }
        if (last?.outcomeUnknown || !['idle', 'completed', 'failed', 'interrupted'].includes(last?.status)) {
          return finish('error', `Previous Codex turn ${last?.turnId ?? binding.turnId ?? '(unconfirmed)'} on ${binding.threadId} is ${last?.status ?? 'unknown'}; not confirmed finished, nothing sent. Interrupt or inspect it with codex_bridge status, or start a new task`);
        }
        // An earlier submission's outcome is unconfirmed (crash or unknown RPC outcome). Only a new,
        // finished native turn proves it was admitted; otherwise its input could be lost or doubled.
        if (binding.failure) {
          if (!last?.turnId || last.turnId === binding.turnId || !['completed', 'failed', 'interrupted'].includes(last.status)) {
            return finish('error', `An earlier input's Codex submission on ${binding.threadId} is unconfirmed (${binding.failure}); not resent, nothing sent. Inspect it with codex_bridge status, or start a new task`);
          }
          Object.assign(binding, { turnId: last.turnId, admitted: true, failure: undefined });
          try { save(binding); } catch (error) {
            return finish('error', `codex-bridge could not write its session record (${error?.message ?? error}); nothing sent to Codex`);
          }
        }
      }
      // Only a fresh native thread gets developerInstructions. Existing records already hold the old user-text delegation.
      const system = !binding.threadId ? (context.systemPrompt ?? []).join('\n\n').trim() : '';
      const input = fresh.flatMap(inputBlocks);
      let effort;
      try { effort = await nativeEffort(client, binding.model, options); }
      catch (error) { return finish('error', error.message); }
      // Recorded before any native mutation: from here on these inputs are never sent again.
      for (const id of ids) binding.sent.add(id);
      // Until admission is confirmed the record says so; the previous turn id stays as the baseline.
      Object.assign(binding, { failure: 'Codex submission in flight; outcome unknown', inFlight: true });
      try { save(binding); } catch (error) {
        for (const id of ids) binding.sent.delete(id);
        Object.assign(binding, { failure: undefined, inFlight: false });
        return finish('error', `codex-bridge could not write its session record (${error?.message ?? error}); nothing sent to Codex`);
      }
      let snapshot;
      try {
        snapshot = await client.run({
          threadId: binding.threadId, input, cwd: options.cwd, model: binding.model,
          effort, outputSchema, developerInstructions: system || undefined,
          // A thread whose ID cannot be recorded gets no turn.
          onThread: (threadId) => {
            if (binding.threadId !== threadId) {
              binding.threadId = threadId;
              binding.threads.add(threadId);
              save(binding);
            }
          },
        });
        binding.inFlight = false;
      } catch (error) {
        binding.inFlight = false;
        binding.threadId ??= typeof error?.threadId === 'string' ? error.threadId : undefined;
        const message = `Codex native submission failed${error?.code ? ` (${error.code})` : ''}: ${error?.message ?? error}`;
        // Without a confirmed thread ID no turn/start was ever sent (an unknown thread/start at most
        // leaves an empty orphan thread), so only then are the inputs definitely undelivered.
        if (error?.outcomeUnknown === true && binding.threadId) {
          // The turn may exist: these inputs stay recorded as sent and are never resubmitted.
          Object.assign(binding, { admitted: true, failure: `${message}; outcome unknown, not resubmitted` });
        } else {
          // Definitely not admitted: the inputs were not delivered and go with the next new message.
          for (const id of ids) binding.sent.delete(id);
          binding.failure = undefined;
        }
        let recordError = '';
        try { save(binding); } catch (saveError) { recordError = `; session record not updated: ${saveError?.message ?? saveError}`; }
        return finish('error', (binding.failure ?? message) + recordError);
      }
      Object.assign(binding, { threadId: snapshot.threadId, turnId: snapshot.turnId, admitted: true, failure: undefined });
      try { save(binding); } catch (error) {
        return finish('error', `Codex admitted turn ${snapshot.turnId} on thread ${snapshot.threadId}, but the session record could not be written (${error?.message ?? error}); the turn keeps running natively and is not observed here. Inspect it with codex_bridge status`);
      }
    } else {
      // Every input was already sent (provider retry, revive after crash/dispose, requeued steer):
      // report the turn that received it; never resubmit.
      replayed = true;
      if (binding.failure) return finish('error', `${binding.failure} (not resubmitted)`);
      if (!binding.threadId || !binding.turnId) {
        return finish('error', 'This input was already submitted to Codex but its native turn was never confirmed; outcome unknown, not resubmitted');
      }
      if (client.snapshot(binding.threadId)?.turnId !== binding.turnId) {
        let state;
        try { state = await client.status(binding.threadId); }
        catch (error) { return finish('error', `Input already sent to Codex turn ${binding.turnId}; its outcome could not be read (${error?.message ?? error}); not resubmitted`); }
        if (state?.turnId !== binding.turnId || !TERMINAL.has(state.status)) {
          return finish('error', `Input already sent to Codex turn ${binding.turnId}; its outcome is unknown and it was not resubmitted`);
        }
        if (state.status === 'completed') return complete(state.text ?? '', binding.turnId, state);
        return finish('error', `This input was already delivered into Codex turn ${binding.turnId}, which ended ${state.status}${state.error ? `: ${state.error}` : ''}; not resubmitted. Send a new message to continue`);
      }
    }
    const { threadId, turnId } = binding;
    if (!threadId || !turnId) return finish('error', 'Codex native turn identity is unknown; not resubmitted');

    // Progress: one thinking block of Codex-origin activity, numbered lines.
    let progress;
    let progressChars = 0;
    let lines = 0;
    const note = (line) => {
      if (!line || progressChars >= PROGRESS_CHARS) return;
      if (!progress) {
        progress = { type: 'thinking', thinking: '' };
        output.content.push(progress);
        stream.push({ type: 'thinking_start', contentIndex: 0, partial: output });
      }
      const delta = `${progress.thinking ? '\n' : ''}[codex ${++lines}] ${clip(line, LINE_CHARS)}`;
      progressChars += delta.length;
      progress.thinking += delta;
      stream.push({ type: 'thinking_delta', contentIndex: 0, delta, partial: output });
    };
    const sink = (method, params) => {
      if ((params?.turnId ?? params?.turn?.id) !== turnId) return;
      try { note(progressLine(method, params)); } catch { /* malformed item: no progress line */ }
    };
    // Events that arrived before admission returned are replayed from the client's bounded
    // retained events; the live sink takes over in the same synchronous step, so none is lost or doubled.
    for (const event of client.snapshot(threadId)?.events ?? []) sink(event.method, event.params);
    binding.sink = sink;
    const initialUsage = client.snapshot(threadId);
    if (initialUsage?.tokenUsageTurnId === turnId && initialUsage.tokenUsage) {
      note(progressLine('thread/tokenUsage/updated', { tokenUsage: initialUsage.tokenUsage }));
    }

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
    // Live steering: user input typed while this turn runs goes into the same native turn.
    void (async () => {
      const steering = options.liveSteering;
      while (steering && !ended.signal.aborted) {
        await steering.wait(ended.signal);
        if (ended.signal.aborted) return;
        const claim = await steering.claim(ended.signal);
        if (!claim) { await new Promise(resolveDelay => setTimeout(resolveDelay, 50)); continue; }
        const ids = claim.messages.map(inputId);
        const input = claim.messages.flatMap(inputBlocks);
        const text = claim.messages.map(textOf).filter(part => part.trim()).join('\n\n');
        // A full record cannot hold the steer: OMP delivers it with the next request, which then stops.
        if (!input.length || ended.signal.aborted || binding.sent.size + ids.length > SENT_LIMIT) { claim.reject(); continue; }
        // Recorded first: if OMP requeues this input after an abort, it is not sent again.
        for (const id of ids) binding.sent.add(id);
        try { save(binding); } catch {
          // Unrecorded input is never steered; OMP delivers it with the next request.
          for (const id of ids) binding.sent.delete(id);
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
            for (const id of ids) binding.sent.delete(id);
            // ponytail: if this rewrite fails, only the on-disk record still lists the unsent steer; a later revive then refuses it as "already submitted" (fail closed, never a duplicate).
            try { save(binding); } catch { /* fail closed: see above */ }
            claim.reject();
          }
        }
      }
    })().catch(() => {});

    try {
      const result = await Promise.race([settled(client, threadId, turnId, ended.signal), interrupted.then(() => undefined)]);
      if (progress) stream.push({ type: 'thinking_end', contentIndex: 0, content: progress.thinking, partial: output });
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
    } finally {
      ended.abort();
      if (binding.sink === sink) binding.sink = undefined;
    }
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
    const owned = [...bindings.values()];
    await Promise.all(owned.map(async binding => {
      if (binding.threadId && binding.client.snapshot(binding.threadId)?.status === 'inProgress') {
        try { await binding.client.cancel(binding.threadId); } catch { /* closing still tears down transport */ }
      }
      await binding.close();
    }));
    await Promise.all(closing.values());
    contexts.clear();
    outputSchemas.clear();
    providerSessionIds.clear();
  };
  streamSimple.close = async sessionId => {
    sessionId = providerSessionIds.get(sessionId) ?? sessionId;
    const binding = bindings.get(sessionId);
    if (binding) {
      if (binding.threadId && binding.client.snapshot(binding.threadId)?.status === 'inProgress') {
        try { await binding.client.cancel(binding.threadId); } catch { /* close still tears down transport */ }
      }
      await binding.close();
    }
    await closing.get(sessionId);
    contexts.delete(sessionId);
    outputSchemas.delete(sessionId);
  };
  streamSimple.clear = async sessionId => {
    sessionId = providerSessionIds.get(sessionId) ?? sessionId;
    await closing.get(sessionId);
    const binding = bindings.get(sessionId);
    contexts.delete(sessionId);
    outputSchemas.delete(sessionId);
    if (binding) await resetBinding(binding);
    else {
      // Load only this session's durable record; never delete old native thread history.
      const file = join(stateDir, `${sha256(sessionId)}.json`);
      let record;
      try { record = JSON.parse(readFileSync(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      const loaded = bind(sessionId, record.model, { cwd: record.cwd });
      await resetBinding(loaded);
    }
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
    if (ctx.model?.provider !== CODEX_NATIVE_PROVIDER || ctx.model.id !== opaque.ompModel) {
      ctx.abort();
      const error = 'This branch contains opaque Codex compaction; use the original codex-bridge model, /clear, or rewind to raw history before switching providers';
      ctx.ui.notify(error, 'error');
      throw new Error(error);
    }
    contexts.set(sessionId, opaque);
    // OMP emits this role before convertToLlm wraps it as user text. Native history already holds it.
    if (_event.messages) return { messages: _event.messages.filter(message => message.role !== 'compactionSummary') };
  }
  streamSimple.context = (event, ctx) => captureContext(event, ctx);
  streamSimple.beforeProviderRequest = (event, ctx) => {
    const request = payloadRequests.get(event.payload);
    if (!request) return;
    if (event.payload.api !== CODEX_NATIVE_API || event.payload.sessionId !== request.sessionId) {
      throw new Error('Native provider request identity changed; no native work admitted');
    }
    captureContext({}, ctx, request.sessionId);
    providerSessionIds.set(ctx.sessionManager.getSessionId(), request.sessionId);
    request.captured = true;
    return event.payload;
  };
  streamSimple.beforeCompact = async (event, ctx) => {
    if (ctx.model?.provider !== CODEX_NATIVE_PROVIDER) {
      try { streamSimple.context(event, ctx); } catch { return { cancel: true }; }
      return;
    }
    let compacting;
    try {
      if (event.customInstructions?.trim()) throw new Error('Native Codex compaction does not accept summary focus instructions');
      await closing.get(sessionIdOf(ctx));
      const binding = lifecycleBinding(ctx);
      if (!binding?.threadId || binding.failure) throw new Error('No confirmed native thread is available to compact');
      if (binding.inFlight) throw new Error('Native turn is still settling; compact after it finishes');
      if (binding.rewrite !== undefined) await restoreBoundary(binding, binding.rewrite, event.signal);
      if (!binding.threadId) throw new Error('The selected history boundary has no native thread to compact');
      const status = await binding.client.status(binding.threadId);
      if (status.outcomeUnknown || !['completed', 'failed', 'interrupted', 'idle'].includes(status.status)) throw new Error('Native turn is not confirmed finished');
      await binding.client.resume({ threadId: binding.threadId, cwd: binding.cwd, model: binding.model });
      compacting = binding;
      binding.failure = 'Native compaction admission is unconfirmed; not replayed';
      save(binding);
      const result = await binding.client.compact({ threadId: binding.threadId, signal: event.signal });
      if (result.status !== 'completed') throw new Error(`Native compaction ended ${result.status}: ${result.error ?? 'no summary exposed'}`);
      const opaque = {
        version: 1, threadId: binding.threadId, turnId: result.turnId, cwd: binding.cwd,
        ompModel: ctx.model.id, visibleResponseId: binding.latestResponseId,
        providerSessionId: sessionIdOf(ctx),
      };
      Object.assign(binding, { turnId: result.turnId, opaque, failure: undefined });
      save(binding);
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
        try { save(compacting); } catch { /* preserve the durable uncertain marker on write failure */ }
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
    if (ctx.model?.provider !== CODEX_NATIVE_PROVIDER) {
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
      if (anchor && !lifecycleBinding(ctx).threads.has(anchor.threadId)) throw new Error('The selected native thread is not owned by this session');
    } catch (error) {
      ctx.ui.notify(error.message, 'error');
      return { cancel: true };
    }
  };
  streamSimple.afterTree = (_event, ctx) => {
    const binding = lifecycleBinding(ctx);
    if (!binding) return;
    binding.rewrite = boundary(branchEntries(ctx));
    save(binding);
    streamSimple.context(_event, ctx);
  };
  return streamSimple;
}
