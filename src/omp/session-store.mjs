// Durable delivery ledger. Field names and hashes are part of the on-disk compatibility contract.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const sessionFile = (stateDir, sessionId) => join(stateDir, `${createHash('sha256').update(sessionId).digest('hex')}.json`);

export function readSessionRecord(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`codex-bridge session record ${file} is unreadable (${error.message}); nothing sent to Codex. Inspect or remove it, then start a new task`);
  }
}

export function loadSession(stateDir, sessionId, nativeModel, cwd) {
  const file = sessionFile(stateDir, sessionId);
  const record = readSessionRecord(file);
  if (record !== undefined && (record === null || typeof record !== 'object' || !Array.isArray(record.sent)
    || (record.policy !== 'native-config' && record.sandbox !== 'workspace-write' && record.sandbox !== 'read-only') || typeof record.cwd !== 'string'
    || (record.config !== undefined && (record.config === null || typeof record.config !== 'object' || Array.isArray(record.config)))
    || (record.model != null && (typeof record.model !== 'string' || !record.model)))) {
    throw new Error(`codex-bridge session record ${file} is malformed; nothing sent to Codex. Inspect or remove it, then start a new task`);
  }
  if (record && (record.policy !== 'native-config' || Object.hasOwn(record, 'sandbox'))) {
    throw new Error(`codex-bridge session record ${file} used the previous fixed sandbox policy; start a new task or fresh session to inherit native Codex configuration. Nothing sent to Codex`);
  }
  // Records without a model retain the Codex default.
  return {
    file, recorded: record !== undefined, policy: 'native-config', cwd: record?.cwd ?? cwd,
    config: record?.config ?? {},
    model: record ? record.model ?? undefined : nativeModel,
    threadId: record?.threadId ?? undefined, turnId: record?.turnId ?? undefined, failure: record?.failure ?? undefined,
    // True once Codex admitted (or may have admitted) a turn: the system prompt went with it.
    admitted: record?.admitted === true, sent: new Set(record?.sent ?? []), sink: undefined,
    latestResponseId: record?.latestResponseId, opaque: record?.opaque,
    rewrite: record?.rewrite,
    threads: new Set(record?.threads ?? (record?.threadId ? [record.threadId] : [])),
  };
}

// Throws on any write failure; callers stop before (or report after) the native mutation.
export function saveSession(stateDir, session) {
  const { policy, config, model, cwd, threadId, turnId, admitted, failure, sent, latestResponseId, opaque, rewrite } = session;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${session.file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({
    policy, config, model, cwd, threadId, turnId, admitted, failure, sent: [...sent],
    latestResponseId, opaque, rewrite, threads: [...session.threads],
  }), { mode: 0o600 });
  renameSync(temporary, session.file);
  session.recorded = true;
}
