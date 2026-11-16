# omp-codex-bridge

Run [Codex app-server](https://learn.chatgpt.com/docs/app-server.md) workers inside [Oh My Pi](https://github.com/can1357/oh-my-pi)'s Agent Hub.

Codex owns inference, native tools, authentication and persistent threads. OMP owns delegation, progress, steering and result delivery. The bridge uses `codex app-server --stdio`.

## Requirements

- Compatibility target: OMP 18.20.3 and Codex CLI 0.167.2. Other versions require the protocol and Hub checks below.
- Codex CLI on `PATH`, authenticated with `codex login`. OMP uses its embedded Bun runtime to load the plugin.
- Development: Node.js 20.19 or newer and Bun 1.4.2 or newer. The standalone client also supports Node.js 20.19+.

## Install

```sh
git clone https://github.com/noflowwater/omp-codex-bridge.git
cd omp-codex-bridge
omp plugin install .
```

OMP's native package discovery loads both `extensions/codex-bridge.ts` and `agents/codex-bridge.md`. The installed package's agent has user scope, so its exact frontmatter model selectors can grant per-call selection. No separate agent copy, symlink, installer, build, daemon or npm publication is needed.

Local installation links the whole package into OMP's user plugin directory. Keep the checkout at that path. To pin a deployment, check out a reviewed Git commit or tag before installing. Update with `git pull --ff-only` (or check out another reviewed revision), then restart OMP. Local links have nothing for `omp plugin upgrade` to download.

Uninstall with `omp plugin uninstall omp-codex-bridge`, then restart OMP. This removes the plugin registration and package link. It keeps the checkout, native Codex history and bridge receipts.

Installation never writes user/project agent files or changes model routing, per-call permissions, steering, authentication or Codex policy. A same-name project or user agent takes precedence over the package agent and remains untouched. If an older installation created a user-level `codex-bridge.md` link, inspect its target and remove only that owned link; unrelated files must be kept or moved deliberately by their owner.

## Agent Hub

Ask the main assistant to delegate to `codex-bridge`, or use the task tool:

```json
{"context":"Parser review","tasks":[{"name":"ParserReview","agent":"codex-bridge","task":"Review the parser without editing files.","solutionSpace":"Read-only review of parser correctness"}]}
```

Open Agent Hub with `Alt+A` or double left-arrow on an empty editor. Focus the child to inspect its progress and send messages; Hub `x` interrupts it. A follow-up to the same child continues its native thread.

Running-turn steering requires OMP's `providers.openaiLiveSteering` setting. With it disabled, a message is queued for the next native turn. Installation does not enable this setting.

### Model selection

`codex-bridge/default` uses Codex's configured default model. Explicit profiles use `codex-bridge/<native-model>`, for example `codex-bridge/gpt-6.1-sol`.

Per-task selection requires the operator's `task.perCallModel: on` and a matching exact selector in the installed agent's frontmatter. A configured `task.perCallModelAllow` further narrows that grant. Project agents and model discovery do not grant permission. A `task.agentModelOverrides` entry for this agent conflicts with a per-call `model`. Installation changes none of these settings. A child's model stays fixed for its lifetime; start a new child to change it.

The shipped native selectors are a compatibility snapshot, not a promise that every account exposes them. Use `codex-bridge/default` for Codex's configured model. Add new exact selectors to an operator-owned agent definition only after reviewing native model discovery; wildcard model entries do not grant per-call permission.

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

- Text, images, model-supported reasoning effort and object-valued JSON Schema output are forwarded to native APIs. Structured task output is validated before delivery. OMP's `forceReasoningOff` takes precedence over a requested effort.
- Blocking and asynchronous questions use the main OMP UI. Standard and OpenAI extended MCP forms require explicit submission and supported-schema validation. Headless questions, URL flows and unsupported schemas are declined.
- Native token counters and context-window information are reported. Subscription cost remains unknown.
- Tree navigation, entry branches and whole-session forks preserve the source history and fork native history at the selected completed boundary. Compaction creates an opaque native checkpoint; Codex exposes no readable summary. An incompatible model cannot consume it.
- OMP may refuse compaction of a small local transcript before the native hook runs. Focused compaction instructions and unsupported mid-turn branches are rejected.
- Reload preserves confirmed task lineage. Clear starts a fresh conversation. Unknown mutation outcomes and missing lineage stop processing without replaying work.
- Malformed successful mutation replies retain an unknown outcome, preventing automatic replay. Failed pre-send cancellation and confirmed late interrupt refusal release their cancellation slot; unresolved native mutations remain guarded.

## State and security

Each worker requests `workspace-write`, parent-cwd writable roots, `networkAccess: false`, excluded `/tmp` and `$TMPDIR`, and approvals `never`. Review and editing use the same policy.

**Codex trusted allow rules, MCP/apps and hooks retain their own execution scope. These settings are not a complete process or network isolation boundary.** Review Codex configuration before running untrusted work.

Delivery receipts live in `codex-bridge-state` under OMP's agent directory. Set `OMP_CODEX_BRIDGE_STATE_DIR` to override it. State is kept outside this checkout; native history remains under Codex's own storage. Do not publish either location or delete receipts for active tasks.

The repository contains no authentication, sessions, model cache or user configuration. Installing it does not change Codex configuration.

## Development

```sh
bun install --frozen-lockfile
bun run test
bun run test:hub # native install, agent grants, branch/fork, dialogs, reload and real TUI /clear
```

`bun run test:package` checks native local install, live-checkout updates, idempotent reinstall and uninstall under a fresh HOME. It verifies that existing operator agent files and permission/steering settings remain unchanged.

Unit tests and Hub smoke tests use a protocol double, isolated homes and temporary state. They do not run model inference or use stored credentials. Each Hub fixture installs this checkout with the real `omp plugin install` command, then exercises actual RPC/TUI and child-agent behavior without a copied user agent. Hub tests require the supported `omp` executable on `PATH`. Additional modes live in `test/hub/smoke.mjs`; `test/hub/fixture.sh` opens an isolated manual fixture.

Runtime responsibilities live under `src/codex/` (native app-server transport and thread/turn state) and `src/omp/` (OMP provider, tools, delivery receipts and lifecycle). Codex owns durable native history outside this package. `extensions/codex-bridge.ts` is the package entrypoint; tests stay under `test/` and are excluded from the package file list.

CI pins OMP 18.20.3 and runs the unit and isolated package/Hub checks without credentials. Release delivery is the reviewed source commit/tag plus the native local install above. No publishing workflow, registry token, generated bundle or preview channel is required. Re-run these gates before changing the compatibility target.

## References

- [Codex app-server API](https://learn.chatgpt.com/docs/app-server.md)
- [OMP package install/update/remove contracts](https://github.com/can1357/oh-my-pi/blob/v18.20.3/docs/plugin-manager-installer-plumbing.md)
- [OMP agent discovery and per-call grants](https://github.com/can1357/oh-my-pi/blob/v18.20.3/docs/task-agent-discovery.md)
- [Current OMP extension loading guide](https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md)
- [Codex execution rules](https://learn.chatgpt.com/docs/agent-configuration/rules.md)
- [Official Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp)
- [Native compaction convention](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/session-compaction.md)
- [cmux adapter comparison](https://github.com/manaflow-ai/cmux-codex-acp) — design reference; no code copied.
- [Codex ACP CI](https://github.com/agentclientprotocol/codex-acp/blob/main/.github/workflows/ci.yml) and [release process](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/RELEASES.md) — verification gates and pinned dependencies inform this package; its publishing infrastructure is not needed here.

## License

[MIT](LICENSE), copyright 2026 noflowwater.
