# Development

[Home](../README.md) · [Changelog](../CHANGELOG.md)

```sh
bun install --frozen-lockfile
bun run test
bun run test:hub # native install, agent grants, branch/fork, dialogs, reload and real TUI /clear
CODEX_HUB_FIXTURE_COLS=80 bun test/hub/smoke.mjs tui-operator
CODEX_HUB_API_OMP=/absolute/path/to/patched/omp bun test/hub/jobs.mjs
CODEX_HUB_API_OMP=/absolute/path/to/patched/omp bun test/hub/jobs.mjs mixed
```

`bun run test:package` checks native local install, live-checkout updates, idempotent reinstall and uninstall under a fresh HOME. It verifies that existing operator agent files and permission/steering settings remain unchanged.

The jobs/continuation TUI fixture requires an explicit patched-host path and otherwise reports SKIP. It uses its own temporary PATH and home. The `history` case begins with `/codex history` in a fresh session before any model turn; `mixed` also checks that interrupting a Hub worker leaves a direct worker running. Both use a protocol double, so they prove host wiring and ownership rather than model recall. `test:hub` includes both when the environment variable is set.

Unit tests and Hub smoke tests use a protocol double, isolated homes and temporary state. They do not run model inference or use stored credentials. Each Hub fixture installs this checkout with the real `omp plugin install` command, then exercises actual RPC/TUI and child-agent behavior without a copied user agent. Hub tests require the supported `omp` executable on `PATH`. Additional modes live in `test/hub/smoke.mjs`; `test/hub/fixture.sh` opens an isolated manual fixture.

`bun test/hub/print.mjs` checks real OMP print completion and deadline cancellation against the isolated protocol double; it is included in `test:hub`. Print calls wait inside the tool because OMP 18.21's public extension API exposes async job snapshots but no external-job registration. Interactive TUI/RPC admission remains asynchronous.

Runtime responsibilities live under `src/codex/` (native transport, thread/turn ownership and side-effect-free `inspection.mjs`) and `src/omp/`. The provider keeps one session table and separates input admission, native-turn observation and live steering. `progress.mjs` formats native activity; `forms.ts` owns MCP form parsing and interaction; `dialogs.ts` owns root UI routing and approvals; `presentation.ts` builds cards and footer status. Byte budgets and screen-line limits stay separate. Codex owns durable native history outside this package. `extensions/codex-bridge.ts` is the package entrypoint; tests stay under `test/` and are excluded from the package file list.

`jobs.ts` owns picker interaction, `job-actions.ts` routes direct versus Hub ownership, and `hub.ts` adapts the optional public host controls. `history-picker.ts` owns history selection; `history.mjs` admits a native fork only inside its new provider session. Durable fork receipts share the existing session store rather than a second ownership registry.

CI pins OMP 18.21.0 and runs the unit and isolated package/Hub checks without credentials. Release delivery is the reviewed source commit/tag plus the native local install above. No publishing workflow, registry token, generated bundle or preview channel is required. Re-run these gates before changing the compatibility target.

## JavaScript maintenance conventions

Use named functions for stable operations and modules with one concrete responsibility. Keep the session owner and its mutable maps together; extract formatting and independent form interactions. Prefer guard clauses and ordinary control flow over nested conditionals. Build display tables from structured fields, keeping native payloads separate from their rendering.

Retain the existing per-file syntax and public contracts. Refactoring must preserve receipt fields, ownership checks, error classification, cancellation and the rule against replaying uncertain work. Keep complete schema validation after field-level feedback. Reuse the platform UI and existing validation dependency. Add focused regressions for consumer-visible behavior and run the unit, package and Hub gates before handoff.

These conventions follow the current [Google TS/JS guide](https://google.github.io/styleguide/tsguide.html), [MDN module guidance](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules) and [ESLint complexity guidance](https://eslint.org/docs/latest/rules/complexity). Function complexity informs responsibility boundaries; this project does not introduce a new formatter, lint dependency or arbitrary line-count gate.

## References

- [Codex app-server API](https://learn.chatgpt.com/docs/app-server.md)
- [Codex native configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
- [OMP package install/update/remove contracts](https://github.com/can1357/oh-my-pi/blob/v18.21.0/docs/plugin-manager-installer-plumbing.md)
- [OMP agent discovery and per-call grants](https://github.com/can1357/oh-my-pi/blob/v18.21.0/docs/task-agent-discovery.md)
- [Current OMP extension loading guide](https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md)
- [Codex execution rules](https://learn.chatgpt.com/docs/agent-configuration/rules.md)
- [Official Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp)
- [Native compaction convention](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/session-compaction.md)
- [cmux adapter comparison](https://github.com/manaflow-ai/cmux-codex-acp) — design reference; no code copied.
- [Codex ACP CI](https://github.com/agentclientprotocol/codex-acp/blob/main/.github/workflows/ci.yml) and [release process](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/RELEASES.md) — verification gates and pinned dependencies inform this package; its publishing infrastructure is not needed here.

The Codex ACP and cmux adapters informed the documentation structure: quick start in the README, detailed integration contracts in focused guides. No adapter code was copied.
