# omp-codex-bridge

[![CI](https://github.com/noFlowWater/omp-codex-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/noFlowWater/omp-codex-bridge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/noFlowWater/omp-codex-bridge)](https://github.com/noFlowWater/omp-codex-bridge/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Run [Codex](https://github.com/openai/codex) workers in [Oh My Pi](https://github.com/can1357/oh-my-pi)'s Agent Hub.

The bridge connects OMP to `codex app-server --stdio`. Codex handles inference, tools, authentication and persistent threads. OMP handles delegation, live progress, steering and results.

## Features

- Delegate tasks to Codex and inspect each worker in Agent Hub.
- Continue conversations, interrupt work and steer running turns.
- Use native models, reasoning effort, images and structured output.
- Browse saved history and fork a finished turn into a new conversation.
- Keep native Codex configuration and authentication.

## Quick start

Requires **OMP 18.21.0** and an authenticated **Codex CLI 0.169.0** on `PATH`. These are the current compatibility targets.

```sh
codex login
git clone https://github.com/noFlowWater/omp-codex-bridge.git
cd omp-codex-bridge
omp plugin install .
```

Restart OMP, then ask:

```text
Delegate a read-only review of this project's error handling to codex-bridge.
```

Open **Agent Hub with `Alt+A`** to see the worker's transcript and send follow-up messages. A follow-up to the same worker continues its native conversation.

The installed plugin links to this checkout. Keep it in place. For version pinning, updates and removal, see [Installation](docs/installation.md).

## Usage

| Interface | Use it for |
| --- | --- |
| Agent Hub: `codex-bridge` | Delegating tasks with live child transcripts and follow-ups |
| Tool: `codex_bridge` | Starting, inspecting and cancelling direct native threads |
| Command: `/codex` | Diagnostics, saved history, forks and processing tier |

Start with `/codex doctor` to check the connection without model inference. Use `/codex history` to browse saved conversations.

Hub workers use `codex-bridge/default` unless a native model selector is chosen. Per-task model selection requires OMP's operator grants. Running-turn steering requires `providers.openaiLiveSteering`; otherwise messages wait for the next turn. See [Agent Hub](docs/agent-hub.md).

Direct-tool threads stay outside Agent Hub. Codex's own internal subagents are distinct from OMP-delegated Hub workers.

## Configuration and access

Workers start in the parent session's directory and inherit native Codex filesystem, network and approval settings. Define allowed edits in the task; the working directory alone is not an access boundary.

Use `~/.codex/config.toml` or optional bridge-only overrides for permissions and additional writable directories. Review [Configuration and security](docs/configuration.md) before delegating untrusted work.

## Documentation

| Guide | Contents |
| --- | --- |
| [Installation](docs/installation.md) | Requirements, version pinning, upgrades, removal and agent precedence |
| [Agent Hub](docs/agent-hub.md) | Delegation, model selection, tiers, steering and session lifecycle |
| [Direct tool and history](docs/direct-tool.md) | Tool calls, inspection, pagination and native forks |
| [Configuration and security](docs/configuration.md) | Permissions, environment, state and sensitive output |
| [Development](docs/development.md) | Test commands, architecture, compatibility checks and upstream references |

## Development

Requires Node.js 20.19+ and Bun 1.4.2+.

```sh
bun install --frozen-lockfile
bun run test
bun run test:hub
```

Tests use isolated state and protocol doubles. See the [development guide](docs/development.md) for coverage and real-server verification limits.

Report reproducible bugs through [GitHub Issues](https://github.com/noFlowWater/omp-codex-bridge/issues). Include OMP, Codex and bridge versions, steps and redacted errors. Exclude credentials and private session data.

## License

[MIT](LICENSE) · [Changelog](CHANGELOG.md)
