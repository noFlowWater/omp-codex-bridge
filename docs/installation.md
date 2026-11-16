# Installation and upgrades

[Home](../README.md)

## Requirements

- Compatibility target: OMP 18.21.0 and Codex CLI 0.169.0. Protocol doubles exercise native contracts; real-server startup, diagnostics, permissions and naming checks run without model inference. Re-run the [development checks](development.md) after upgrades.
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
