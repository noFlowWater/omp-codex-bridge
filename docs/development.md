# Development

[Home](../README.md) · [Changelog](../CHANGELOG.md)

```sh
bun install --frozen-lockfile
bun run test
bun run test:hub # native install, agent grants, branch/fork, dialogs, reload and real TUI /clear
CODEX_HUB_FIXTURE_COLS=80 bun test/hub/smoke.mjs tui-operator
```

`bun run test:package` checks native local install, live-checkout updates, idempotent reinstall and uninstall under a fresh HOME. It verifies that existing operator agent files and permission/steering settings remain unchanged.

Unit tests and Hub smoke tests use a protocol double, isolated homes and temporary state. They do not run model inference or use stored credentials. Each Hub fixture installs this checkout with the real `omp plugin install` command, then exercises actual RPC/TUI and child-agent behavior without a copied user agent. Hub tests require the supported `omp` executable on `PATH`. Additional modes live in `test/hub/smoke.mjs`; `test/hub/fixture.sh` opens an isolated manual fixture.

Runtime responsibilities live under `src/codex/` (native transport, thread/turn ownership and side-effect-free `inspection.mjs`) and `src/omp/` (provider, receipts, operator commands and `presentation.ts` for cards and footer status). Byte budgets and screen-line limits stay separate. Codex owns durable native history outside this package. `extensions/codex-bridge.ts` is the package entrypoint; tests stay under `test/` and are excluded from the package file list.

CI pins OMP 18.21.0 and runs the unit and isolated package/Hub checks without credentials. Release delivery is the reviewed source commit/tag plus the native local install above. No publishing workflow, registry token, generated bundle or preview channel is required. Re-run these gates before changing the compatibility target.

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
