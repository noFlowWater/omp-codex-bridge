# omp-codex-bridge

Run [Codex app-server](https://learn.chatgpt.com/docs/app-server.md) workers inside [Oh My Pi](https://github.com/can1357/oh-my-pi)'s Agent Hub.

Codex owns inference, native tools, authentication and persistent threads. OMP owns delegation, progress, steering and result delivery. The bridge uses `codex app-server --stdio`.

## Requirements

- OMP with extension and custom-provider support; tested with 18.20.3.
- Codex CLI on `PATH`; tested with 0.167.2. Authenticate with `codex login`.
- Node.js 20.19 or newer. Bun 1.4.2 or newer is needed for development tests.

## Install

```sh
git clone https://github.com/noflowwater/omp-codex-bridge.git
cd omp-codex-bridge
omp install .
mkdir -p "$HOME/.omp/agent/agents"
ln -s "$PWD/agents/codex-bridge.md" "$HOME/.omp/agent/agents/codex-bridge.md"
```

The user-level agent file grants the model selectors listed in its frontmatter. The link command refuses to overwrite an existing file. For a custom OMP agent directory, use that directory instead of `~/.omp/agent`.

Restart OMP after installation or shared JavaScript updates. Keep the checkout at its installed path. Updates use `git pull` followed by an OMP restart.

## Agent Hub

Ask the main assistant to delegate to `codex-bridge`, or use the task tool:

```json
{"context":"Parser review","tasks":[{"name":"ParserReview","agent":"codex-bridge","task":"Review the parser without editing files.","solutionSpace":"Read-only review of parser correctness"}]}
```

Open Agent Hub with `Alt+A` or double left-arrow on an empty editor. Focus the child to inspect its progress and send messages; Hub `x` interrupts it. A follow-up to the same child continues its native thread.

Running-turn steering requires OMP's `providers.openaiLiveSteering` setting. With it disabled, a message is queued for the next native turn. Installation does not enable this setting.

### Model selection

`codex-bridge/default` uses Codex's configured default model. Explicit profiles use `codex-bridge/<native-model>`, for example `codex-bridge/gpt-6.1-sol`.

Per-task selection requires OMP's `task.perCallModel` permission and a matching selector in `agents/codex-bridge.md`. Discovery alone does not grant permission. Installation does not change these settings. A child's model stays fixed for its lifetime; start a new child to change it.

## Direct tool

`codex_bridge` exposes `run`, `status`, `cancel` and `shutdown`. Direct-tool threads do not appear in Agent Hub.

```json
{"action":"run","cwd":"/absolute/project","model":"gpt-6.1-sol","prompt":"Inspect the parser without edits."}
```

A successful `run` acknowledges admission. Terminal results arrive as follow-ups. Inspect retained text, events and usage with:

```json
{"action":"status","threadId":"<returned-thread-id>"}
```

Continue or cancel a thread owned by the current direct-tool server:

```json
{"action":"run","threadId":"<returned-thread-id>","cwd":"/absolute/project","prompt":"Check the error path next."}
{"action":"cancel","threadId":"<returned-thread-id>"}
```

`status` can inspect saved native history after restart without adopting it. Direct `run` cannot continue threads from another server lifecycle; task agents use their saved lineage for revival.

## Inputs and lifecycle

- Text, images, model-supported reasoning effort and object-valued JSON Schema output are forwarded to native APIs. Structured task output is validated before delivery.
- Blocking and asynchronous questions use the main OMP UI. Supported MCP forms require explicit submission. Headless questions, URL flows and unsupported schemas are declined.
- Native token counters and context-window information are reported. Subscription cost remains unknown.
- Navigation to a supported completed answer forks native history through that turn. Compaction creates an opaque native checkpoint; Codex exposes no readable summary. An incompatible model cannot consume it.
- OMP may refuse compaction of a small local transcript before the native hook runs. Focused compaction instructions and unsupported mid-turn branches are rejected.
- Reload preserves confirmed task lineage. Clear starts a fresh conversation. Unknown mutation outcomes and missing lineage stop processing without replaying work.

## State and security

Each worker requests `workspace-write`, parent-cwd writable roots, `networkAccess: false`, excluded `/tmp` and `$TMPDIR`, and approvals `never`. Review and editing use the same policy.

**Codex trusted allow rules, MCP/apps and hooks retain their own execution scope. These settings are not a complete process or network isolation boundary.** Review Codex configuration before running untrusted work.

Delivery receipts live in `codex-bridge-state` under OMP's agent directory. Set `OMP_CODEX_BRIDGE_STATE_DIR` to override it. State is kept outside this checkout; native history remains under Codex's own storage. Do not publish either location or delete receipts for active tasks.

The repository contains no authentication, sessions, model cache or user configuration. Installing it does not change Codex configuration.

## Development

```sh
bun install --frozen-lockfile
bun run test
bun run test:hub
```

Unit tests and Hub smoke tests use a protocol double, isolated homes and temporary state. They do not run model inference or use stored credentials. Hub tests require an installed `omp` executable and exercise actual RPC/TUI behavior. Additional modes are available in `lib/codex-bridge/hub-smoke.mjs`.

## References

- [Codex app-server API](https://learn.chatgpt.com/docs/app-server.md)
- [Codex execution rules](https://learn.chatgpt.com/docs/agent-configuration/rules.md)
- [Official Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp)
- [Native compaction convention](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/session-compaction.md)
- [cmux adapter comparison](https://github.com/manaflow-ai/cmux-codex-acp) — design reference; no code copied.

## License

[MIT](LICENSE), copyright 2026 noflowwater.
