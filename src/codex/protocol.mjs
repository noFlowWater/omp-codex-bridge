import { resolve } from 'node:path';

export const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
// Refusals of one thread's effective settings; the transport stays usable.
export const REFUSED_CODES = new Set(['PERMISSION_UNSAFE', 'PERMISSION_STRICTER', 'MODEL_MISMATCH']);
export const MODEL_PAGE_SIZE = 100;
export const MODEL_PAGES = 20;
export const MAX_TEXT = 1024 * 1024;
export const MAX_EVENT_TEXT = 8192;
export const USAGE_KEYS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
export const OPT_OUT = [
  'item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated', 'turn/diff/updated',
];

export function bounded(value, budget = { left: MAX_EVENT_TEXT }, depth = 0) {
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


export function nonempty(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError(`${name} must be a nonempty string without NUL characters`);
  }
  return value;
}
export function jsonValue(value, name) {
  const text = JSON.stringify(value, (_key, entry) => {
    if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol'
      || (typeof entry === 'number' && !Number.isFinite(entry))) throw new TypeError(`${name} must contain only JSON values`);
    return entry;
  });
  if (text === undefined) throw new TypeError(`${name} must be a JSON value`);
  return JSON.parse(text);
}

export function userInput(prompt, input) {
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

export function usageBreakdown(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid native token usage');
  for (const key of USAGE_KEYS) {
    if (key === 'cacheWriteInputTokens' && value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new TypeError(`Invalid native token usage ${key}`);
  }
  return { ...value };
}

export function aborted() {
  return Object.assign(new Error('Codex operation aborted'), { name: 'AbortError' });
}

export function checkSignal(signal) {
  if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
    throw new TypeError('signal must be an AbortSignal');
  }
  if (signal?.aborted) throw aborted();
}


export function validateThreadOptions({ threadId, cwd, model, onThread, sandbox, developerInstructions }) {
  if (threadId !== undefined) nonempty(threadId, 'threadId');
  if (cwd !== undefined) nonempty(cwd, 'cwd');
  if (model !== undefined) nonempty(model, 'model');
  if (developerInstructions !== undefined && typeof developerInstructions !== 'string') throw new TypeError('developerInstructions must be a string');
  if (onThread !== undefined && typeof onThread !== 'function') throw new TypeError('onThread must be a function');
  if (sandbox !== undefined) throw new TypeError('sandbox is not configurable; every Codex thread runs workspace-write in its cwd');
}

export function rpcError(payload) {
  const error = new Error(typeof payload?.message === 'string' ? payload.message.slice(0, MAX_EVENT_TEXT) : 'Codex RPC failed');
  error.code = payload?.code;
  if (payload?.data !== undefined) error.data = bounded(payload.data);
  return error;
}

// Names the thread without mutating an error object shared by coalesced callers.
export function withThread(error, threadId) {
  if (error?.threadId === threadId) return error;
  return Object.assign(new Error(error?.message ?? String(error), { cause: error }), {
    code: error?.code, outcomeUnknown: error?.outcomeUnknown, threadId,
  });
}

// Every thread requests workspace-write at cwd, networkAccess:false and approvals never. The guard
// checks native effective settings; it does not override Codex trusted rules, MCP servers or hooks.
// thread/start, resume and fork accept a sandbox mode; turn/start also excludes temporary roots.
// Effective read-only is refused rather than silently accepting fewer rights than requested.
export const SANDBOX = 'workspace-write';
export function permissionError(result, cwd) {
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
