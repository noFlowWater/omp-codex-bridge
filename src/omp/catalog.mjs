import { CodexAppServerClient } from '../codex/client.mjs';

export const CODEX_BRIDGE_PROVIDER = 'codex-bridge';
export const CODEX_BRIDGE_API = 'codex-bridge-app-server';
// Every codex-bridge thread runs workspace-write: writable only at the session cwd, network and
// temp dirs off, approvals never. The OMP model id selects only the native model, explicitly
// (agent frontmatter or model switch), never inferred from prompt text: `default` runs Codex's
// configured default model; any other id is a native model slug discovered via native model/list.
export const DEFAULT_MODEL_ID = 'default';
// Native slugs OMP selectors cannot express (whitespace, CSV comma, glob characters) are never offered or run.
// Retired `<sandbox>[--<model>]` ids are refused, never mapped onto workspace-write.
const UNSELECTABLE = /[\s,*?{}[\]\0]|^(read-only|workspace-write)(--|$)/;

// { model } for a codex-bridge OMP model id (model undefined = Codex default), else undefined.
export function parseCodexModelId(id) {
  if (id === DEFAULT_MODEL_ID) return { model: undefined };
  if (typeof id !== 'string' || !id || UNSELECTABLE.test(id)) return undefined;
  return { model: id };
}

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
export const CODEX_BRIDGE_MODELS = [profile(DEFAULT_MODEL_ID, 'Codex native (native usage when available; cost unknown)')];

// OMP fetchDynamicModels: the default profile plus one per native model/list entry. One short-lived
// app-server (initialize + model/list only, never a thread), always closed.
export async function fetchCodexModels({ createClient = options => new CodexAppServerClient(options) } = {}) {
  const client = createClient({ timeoutMs: 5000 });
  try {
    const listed = await client.listModels();
    const defaultModel = listed.find(entry => entry.isDefault);
    return [
      profile(DEFAULT_MODEL_ID, CODEX_BRIDGE_MODELS[0].name, defaultModel),
      ...listed.filter(entry => entry.model !== DEFAULT_MODEL_ID && parseCodexModelId(entry.model))
        .map(entry => profile(entry.model, `Codex native on ${entry.model} (cost unknown)`, entry)),
    ];
  } finally {
    await client.close();
  }
}
