import { isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import { TERMINAL, checkSignal } from '../codex/protocol.mjs';

export const HISTORY_ENTRY = 'codex-bridge-history-fork';

export function historySource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ['threadId', 'lastTurnId', 'cwd'].some(key => typeof value[key] !== 'string' || !value[key].trim())
    || !isAbsolute(value.cwd)) throw new Error('Invalid saved-history continuation; no native input sent');
  return { threadId: value.threadId, lastTurnId: value.lastTurnId, cwd: value.cwd };
}

export function historyEntry(entries) {
  const entry = entries.findLast(entry => entry.type === 'custom' && entry.customType === HISTORY_ENTRY);
  return entry ? historySource(entry.data) : undefined;
}

// This runs only in the new provider session. The inspection client never owns the copy.
export async function bootstrapHistory(session, source, save, signal) {
  const previous = session.historyFork;
  if (previous) {
    if (previous.threadId !== source.threadId || previous.lastTurnId !== source.lastTurnId || previous.cwd !== source.cwd) {
      throw new Error('Saved-history source changed for this child; nothing sent');
    }
    if (!previous.completed) throw new Error(session.failure || 'History fork admission is unconfirmed; not retried');
    return;
  }
  if (session.threadId || session.sent.size) throw new Error('History continuation requires a fresh provider session');
  if (await realpath(session.cwd) !== await realpath(source.cwd)) throw new Error('History continuation must use the source directory; no fork sent');
  const { client } = session;
  let cursor;
  const cursors = new Set();
  for (;;) {
    checkSignal(signal);
    const page = await client.getThreadDetails(source.threadId, { limit: 100, cursor });
    if (page.thread.cwd !== source.cwd) throw new Error('History source directory changed; no fork sent');
    const turn = page.turns.data.find(turn => turn.id === source.lastTurnId);
    if (turn) {
      if (!TERMINAL.has(turn.status)) throw new Error('History continuation requires a finished turn; no fork sent');
      break;
    }
    const next = page.turns.nextCursor;
    if (!next || cursors.has(next)) throw new Error('Finished history boundary was not found; no fork sent');
    cursors.add(next);
    cursor = next;
  }
  checkSignal(signal);
  session.historyFork = { ...source, completed: false };
  session.failure = 'History fork admission in flight; outcome unknown, not retried';
  save(session);
  try {
    const forked = await client.fork({ threadId: source.threadId, lastTurnId: source.lastTurnId,
      cwd: source.cwd, model: session.model,
      onThread(threadId) {
        session.threadId = threadId;
        session.threads.add(threadId);
        save(session);
      },
    });
    const copy = await client.getThreadDetails(forked.threadId, { limit: 1 });
    const boundary = copy.turns.data[0];
    if (!boundary || !TERMINAL.has(boundary.status)) throw new Error('Forked history did not confirm a finished boundary; no input sent');
    Object.assign(session, { turnId: boundary.id, admitted: true, failure: undefined,
      historyFork: { ...source, completed: true, forkedThreadId: forked.threadId, forkedTurnId: boundary.id } });
    save(session);
  } catch (error) {
    session.failure = `History fork could not be confirmed (${error.message}); no input sent, not retried`;
    session.historyFork.completed = false;
    try { save(session); } catch { /* Keep the pre-mutation uncertain receipt if recording fails. */ }
    throw error;
  }
}
