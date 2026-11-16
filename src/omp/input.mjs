import { createHash } from 'node:crypto';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export const textOf = (message) => typeof message.content === 'string' ? message.content
  : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');

export function inputBlocks(message) {
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

export const responseId = (threadId, turnId) => `codex-bridge:${encodeURIComponent(threadId)}:${encodeURIComponent(turnId)}`;
export function anchorOf(message) {
  if (message?.stopReason !== 'stop' && message?.stopReason !== 'toolUse') return undefined;
  const match = /^codex-bridge:([^:]+):([^:]+)$/.exec(message.responseId ?? '');
  return match ? { threadId: decodeURIComponent(match[1]), turnId: decodeURIComponent(match[2]) } : undefined;
}

export async function nativeEffort(client, selectedModel, options) {
  const effort = options.forceReasoningOff || options.disableReasoning || options.reasoning === 'off' ? 'none' : options.reasoning;
  if (effort === undefined) return undefined;
  const models = await client.listModels();
  const configured = selectedModel ?? await client.defaultModel();
  const selected = models.find(entry => configured ? entry.model === configured : entry.isDefault);
  const supported = selected?.supportedReasoningEfforts?.map(entry => typeof entry === 'string' ? entry : entry.reasoningEffort);
  if (!supported?.includes(effort)) throw new Error(`Native model ${selectedModel ?? '(default)'} does not advertise reasoning effort ${effort}; no native turn started`);
  return effort;
}

export function nativeOutputSchema(raw) {
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
