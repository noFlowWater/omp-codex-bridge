import { stripANSI } from 'bun';

export const LINE_CHARS = 2000;
export const PROGRESS_CHARS = 64 * 1024;
const FAILURE_TAIL_CHARS = 1200;
export const PROGRESS_LIMIT_NOTICE = '\n[codex] 64K-character append log limit reached (65,536 characters). Use codex_bridge status for latest activity and plan, or /codex show THREAD_ID for saved native details.';

export function clip(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function planLine(plan) {
  if (!plan) return undefined;
  const steps = (plan.plan ?? []).slice(0, 12).map(({ step, status }) => `[${status}] ${clip(step, 120)}`);
  if ((plan.plan?.length ?? 0) > steps.length) steps.push(`… ${plan.plan.length - steps.length} more steps`);
  return clip(`plan${plan.explanation ? `: ${clip(plan.explanation, 300)}` : ''}\n${steps.join('\n')}`, LINE_CHARS);
}

export function commandLine(item, failure) {
  const header = `$ ${clip(item.command ?? '', 400)} → ${item.status}${item.exitCode == null ? '' : ` (exit ${item.exitCode})`}`;
  if (item.status !== 'failed' && !(typeof item.exitCode === 'number' && item.exitCode !== 0)) return header;
  const output = failure?.itemId === item.id ? failure.outputTail : item.aggregatedOutput;
  if (!output) return header;
  const truncated = failure?.itemId === item.id ? failure.outputTruncated : item.outputTruncated;
  const tail = stripANSI(output).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  return `${header}\ncommand output tail${truncated || tail.length > FAILURE_TAIL_CHARS ? ' (truncated)' : ''}; may contain sensitive data:\n${tail.slice(-FAILURE_TAIL_CHARS)}`;
}


export const nativeLabel = (value, limit = 120) => typeof value === 'string' && value
  ? clip(stripANSI(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '), limit) : 'unknown';

function delegationLine(item) {
  const prefix = 'Codex internal delegation';
  if (item.type === 'subAgentActivity') {
    return `${prefix}: child ${nativeLabel(item.kind, 32)}; thread ${nativeLabel(item.agentThreadId, 80)}; path ${nativeLabel(item.agentPath, 160)}`
      + (item.model ? `; model ${nativeLabel(item.model)}` : '')
      + (item.reasoningEffort ? `; effort ${nativeLabel(item.reasoningEffort, 32)}` : '');
  }
  const operation = {
    spawnAgent: 'spawn', sendInput: 'send input', resumeAgent: 'resume', wait: 'wait',
    closeAgent: 'close', sendMessage: 'send message', followupTask: 'follow-up',
    interruptAgent: 'interrupt', listAgents: 'list',
  }[item.tool] ?? 'operation unknown';
  const states = item.agentsStates && typeof item.agentsStates === 'object' && !Array.isArray(item.agentsStates)
    ? item.agentsStates : null;
  const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : null;
  const children = new Set([...(receivers ?? []), ...Object.keys(states ?? {})].filter(id => typeof id === 'string' && id));
  const counts = new Map();
  for (const id of children) {
    const status = states?.[id]?.status;
    const label = ['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound'].includes(status) ? status : 'unknown';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const statuses = [...counts].map(([status, count]) => `${count} ${status}`).join(', ');
  return `${prefix}: ${operation} ${nativeLabel(item.status, 32)}; observed children ${states || receivers ? children.size : 'unknown'}${statuses ? ` (${statuses})` : ''}`;
}

export function progressLine(method, params, state) {
  // Native context stays in snapshots and assistant usage, not the append-only activity log.
  if (method === 'thread/tokenUsage/updated') return undefined;
  if (method === 'turn/started') return `turn ${params.turn?.id ?? ''} started`;
  if (method === 'turn/completed') return `turn ${params.turn?.id ?? ''} ${params.turn?.status ?? 'ended'}`;
  if (method === 'turn/plan/updated') return planLine(params);
  if (method === 'error') return `error: ${params.error?.message ?? 'Codex reported an error'}`;
  if (method === 'model/rerouted') return `model rerouted ${params.fromModel} → ${params.toModel} (${params.reason})`;
  const item = params.item;
  if (!item) return undefined;
  if ((method === 'item/started' || method === 'item/completed')
    && (item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall')) return delegationLine(item);
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
    case 'commandExecution': return commandLine(item, state?.commandFailure);
    case 'fileChange': return `files ${item.status}: ${(item.changes ?? []).map(change => change.path).join(', ')}`;
    case 'mcpToolCall': return `mcp ${item.server}.${item.tool} → ${item.status}`;
    case 'userMessage': return undefined;
    default: return `${item.type} done`;
  }
}
