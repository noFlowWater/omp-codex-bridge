# omp-codex-bridge

Run [Codex app-server](https://learn.chatgpt.com/docs/app-server.md) workers inside [Oh My Pi](https://github.com/can1357/oh-my-pi)'s Agent Hub.

Codex owns inference, native tools, authentication and persistent threads. OMP owns delegation, progress, steering and result delivery. The bridge uses `codex app-server --stdio`.

## Requirements

- Compatibility target: OMP 18.20.3 and Codex CLI 0.169.0. Protocol doubles exercise native contracts; real-server startup, diagnostics, permissions and naming checks run without model inference. Re-run the checks below after upgrades.
- Codex CLI on `PATH`, authenticated with `codex login`. OMP uses its embedded Bun runtime to load the plugin.
- Development: Node.js 20.19 or newer and Bun 1.4.2 or newer. The standalone client also supports Node.js 20.19+.
- Local lifecycle, branching and `/clear` smoke checks also passed on OMP 18.21.0; the pinned CI target remains 18.20.3.

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

OMP task/session names are copied to native thread names on the next request. Child task identity supplies the name when no session title exists. Naming is metadata-only; a title failure does not replay or reject task input.

Running-turn steering requires OMP's `providers.openaiLiveSteering` setting. With it disabled, a message is queued for the next native turn. Installation does not enable this setting.

### Model selection

`codex-bridge/default` uses Codex's configured default model. Explicit profiles use `codex-bridge/<native-model>`, for example `codex-bridge/gpt-6.1-sol`.

Per-task selection requires the operator's `task.perCallModel: on` and a matching exact selector in the installed agent's frontmatter. A configured `task.perCallModelAllow` further narrows that grant. Project agents and model discovery do not grant permission. A `task.agentModelOverrides` entry for this agent conflicts with a per-call `model`. Installation changes none of these settings. A child's model stays fixed for its lifetime; start a new child to change it.

The shipped native selectors are a compatibility snapshot, not a promise that every account exposes them. Use `codex-bridge/default` for Codex's configured model. Add new exact selectors to an operator-owned agent definition only after reviewing native model discovery; wildcard model entries do not grant per-call permission.

### Processing tier

Use `/codex tier` for a picker or `/codex tier priority` to change OMP's existing OpenAI-family setting for this session. `/codex tier inherit` clears that override. Hub requests use the selected tier for each new native turn; `auto` and omitted selections preserve Codex defaults. This setting also applies to other OpenAI-family models in the same OMP session.

Direct calls can set `"serviceTier":"fast"` or another native tier per `run`; omission inherits native configuration. Availability depends on Codex and the account. Requests use native `serviceTierForTurn`, leaving the thread's future default unchanged. Cards distinguish requested tier from effective tier; an unreported effective tier stays unknown.

Tier selection can change quota consumption or charges. The bridge does not estimate subscription cost.

## Direct tool

`codex_bridge` exposes `run`, `fork`, `status`, `cancel` and `shutdown`. Direct-tool threads do not appear in Agent Hub.

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

Fork saved history into a new locally owned direct thread:

```json
{"action":"fork","threadId":"<saved-source-id>","name":"Parser follow-up"}
```

The response returns the new thread ID and continuation arguments. Forking copies through the latest completed turn, or the explicit `lastTurnId`; it starts no inference and preserves source history and cwd. Optional naming errors appear as `nameWarning` alongside the successful admission.

## Inspect and diagnose

Use OMP's `/codex` command without starting model work:

```text
/codex doctor
/codex status
/codex history {"limit":10,"searchTerm":"parser"}
/codex show THREAD_ID
/codex show THREAD_ID {"includeDiff":true,"limit":10}
/codex history --json {"limit":10}
/codex fork THREAD_ID
/codex tier
```

`doctor` reports native connection, authentication availability, model catalog, supported quota information and readable OMP routing settings. Unavailable checks are labelled; credentials and account identifiers are not displayed. It never logs in, changes settings or consumes credits.

Interactive `history` opens a paged native OMP picker with source name and cwd. Choose details or explicitly confirm a fork into a new direct-tool thread. Headless `history`, `history --json` and direct-tool history return JSON.

`history` supports `cursor`, `limit`, `searchTerm` and `cwd`. `show` supports `includeItems`, `turnId`, `cursor`, `limit` and `includeDiff`. When paging items, retain the returned `turnId` alongside its next cursor. Use small item pages for readable diffs. Inspection does not adopt or resume threads. File changes describe native-reported edits, including rename destinations; shell or generator edits may be absent. Diff content is bounded and returned only when requested. ID-free `status` lists locally loaded direct-tool threads; use history or an explicit thread ID for other saved work.

The direct tool exposes the same operations:

```json
{"action":"diagnose"}
{"action":"history","limit":10,"searchTerm":"parser"}
{"action":"details","threadId":"THREAD_ID","includeDiff":true,"limit":10}
```

The native OMP footer shows `Codex N active · Alt+A`; Agent Hub owns per-worker progress. Execution context, activity and plans remain in the child's transcript and `codex_bridge status`, including updates beyond the transcript log cap. Failed-command output tails can contain sensitive application output; longer command output and file diffs are not automatically dumped.

Native quota events generate one warning on exhaustion and an informational notice on observed recovery, shared across concurrent workers. Reset times appear when reported. Sparse or unavailable fields do not imply recovery; there is no quota polling or automatic retry.

Versioned changes are recorded in [CHANGELOG.md](CHANGELOG.md). Install a reviewed release tag to pin deployment, and restart OMP after changing revisions.


## Inputs and lifecycle

- Text, images, model-supported reasoning effort and object-valued JSON Schema output are forwarded to native APIs. Structured task output is validated before delivery. OMP's `forceReasoningOff` takes precedence over a requested effort.
- Blocking and asynchronous questions use the main OMP UI. Standard and OpenAI extended MCP forms require explicit submission and supported-schema validation. Headless questions, URL flows and unsupported schemas are declined.
- Native token counters and context-window information are reported. Subscription cost remains unknown.
- Tree navigation, entry branches and whole-session forks preserve the source history and fork native history at the selected completed boundary. Compaction creates an opaque native checkpoint; Codex exposes no readable summary. An incompatible model cannot consume it.
- OMP may refuse compaction of a small local transcript before the native hook runs. Focused compaction instructions and unsupported mid-turn branches are rejected.
- Reload preserves confirmed task lineage. Clear starts a fresh conversation. Unknown mutation outcomes and missing lineage stop processing without replaying work.
- Malformed successful mutation replies retain an unknown outcome, preventing automatic replay. Failed pre-send cancellation and confirmed late interrupt refusal release their cancellation slot; unresolved native mutations remain guarded.

## State and security

Workers inherit Codex's native filesystem, network and approval settings. The default cwd is the parent session's directory; cwd does not define which files the task authorizes editing. Specify the permitted output paths in the task.

Configure optional access in `~/.codex/config.toml`, for example:

```toml
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[sandbox_workspace_write]
writable_roots = ["/absolute/path/to/intent"]
```

This keeps the parent cwd while allowing the intent directory. `danger-full-access` is an explicit native option; it removes sandbox restrictions beyond the project. Trusted rules, MCP/apps and hooks retain their native scope. Review configuration before running untrusted work.

The app-server inherits the parent process environment, including configured provider credentials, proxy and MCP variables. Native Codex settings govern which variables its shell tools inherit. The standalone client's optional `env` map overrides individual variables; `null` or `undefined` removes one.

For bridge-only overrides, set a native JSON configuration map before starting OMP:

```sh
export OMP_CODEX_BRIDGE_CONFIG='{"sandbox_mode":"workspace-write","sandbox_workspace_write.writable_roots":["/absolute/path/to/intent"]}'
```

These keys go directly to app-server's thread configuration API; Codex validates them. No config file is modified. Changing bridge overrides requires a fresh task; existing fixed-policy task records also require a fresh task.

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

Runtime responsibilities live under `src/codex/` (native transport, thread/turn ownership and side-effect-free `inspection.mjs`) and `src/omp/` (provider, receipts, operator commands and `presentation.ts` for cards and footer status). Byte budgets and screen-line limits stay separate. Codex owns durable native history outside this package. `extensions/codex-bridge.ts` is the package entrypoint; tests stay under `test/` and are excluded from the package file list.

CI pins OMP 18.20.3 and runs the unit and isolated package/Hub checks without credentials. Release delivery is the reviewed source commit/tag plus the native local install above. No publishing workflow, registry token, generated bundle or preview channel is required. Re-run these gates before changing the compatibility target.

## References

- [Codex app-server API](https://learn.chatgpt.com/docs/app-server.md)
- [Codex native configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
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
