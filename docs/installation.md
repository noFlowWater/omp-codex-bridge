# Installation and upgrades

[Home](../README.md)

## Requirements

- Compatibility target: OMP 18.21.0 and Codex CLI 0.169.0. Protocol doubles exercise native contracts; real-server startup, diagnostics, permissions and naming checks run without model inference. Re-run the [development checks](development.md) after upgrades.
- Codex CLI on `PATH`, authenticated with `codex login`. OMP uses its embedded Bun runtime to load the plugin.
- Development: Node.js 20.19 or newer and Bun 1.4.2 or newer. The standalone client also supports Node.js 20.19+.

Command-driven Hub management and saved-history continuation additionally require `ctx.agents`, supplied by the [optional host patch](../patches/README.md). `/codex doctor` reports availability. Without it, `/codex jobs` manages direct workers and existing assistant-driven Hub delegation is unchanged. Installing the plugin does not install or replace OMP.

## Install

The current release is **v0.8.0**. Pin it when installing:

```sh
git clone --branch v0.8.0 https://github.com/noflowwater/omp-codex-bridge.git
cd omp-codex-bridge
omp plugin install .
```

OMP's native package discovery loads both `extensions/codex-bridge.ts` and `agents/codex-bridge.md`. The installed package's agent has user scope, so its exact frontmatter model selectors can grant per-call selection. No separate agent copy, symlink, installer, build, daemon or npm publication is needed.

Local installation links the whole package into OMP's user plugin directory. Keep the checkout at that path. To upgrade a release-pinned checkout, first preserve any local changes, then run:

```sh
git fetch origin --tags
git switch --detach v0.8.0
omp plugin install .
```

Restart OMP after updating. For a checkout tracking `main`, use `git pull --ff-only` instead of switching tags. Local links have nothing for `omp plugin upgrade` to download.

To use command-driven Hub controls, follow the [host patch build and installation steps](../patches/README.md), then start a new session with `omp-codex-hub`. The standard `omp` remains available. `/codex doctor` reports whether the current host exposes Hub controls; the plugin version alone does not establish host support.

Uninstall with `omp plugin uninstall omp-codex-bridge`, then restart OMP. This removes the plugin registration and package link. It keeps the checkout, native Codex history and bridge receipts.

Installation never writes user/project agent files or changes model routing, per-call permissions, steering, authentication or Codex policy. A same-name project or user agent takes precedence over the package agent and remains untouched. If an older installation created a user-level `codex-bridge.md` link, inspect its target and remove only that owned link; unrelated files must be kept or moved deliberately by their owner.
