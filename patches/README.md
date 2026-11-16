# Optional Agent Hub host API

Stock OMP 18.21.0 has no host-bound extension API to create or control Hub workers. The bridge detects this explicitly: `/codex jobs` still manages direct workers, and normal assistant delegation still uses OMP's task tool. Command-driven Hub controls and history continuation require this patch.

`omp-v18.21-hub-api.patch` targets official OMP tag `v18.21.0`, commit `6f03614d761366972e80e84e25d1418ed678d2c7`. It adds `ctx.agents` to an interactive host context and delegates through the native task tool, async manager and Agent Hub lifecycle. The plugin does not install this patch or replace your executable.

The API lists current root-session jobs and supports spawn, focus, send, interrupt and cancel. Callers retain the complete returned job handle. Actions reject stale root, job, session and run identities rather than selecting the latest worker implicitly. Model grants, task policies and live-steering settings still apply. Trusted child initialization is persisted before child extensions start and is not part of the model-facing task schema. Operator-origin child completion remains visible in the Hub and job records without waking the parent model; ordinary model-origin task completion delivery is unchanged. Input admission awaits revival and a stale-handle check, while the child model turn remains asynchronous and later failures stay on the native job record.

Build a separate executable and keep the standard `omp` intact. The following commands target Linux x64 and require Git, Bun **1.4.4 or newer**, and the official stock **OMP 18.21.0** executable on `PATH`. The stock executable contains the matching native addon; a clean RPC startup with only `get_state` extracts it into a dedicated temporary cache. No account, model request, Cargo installation, or existing user cache is needed.

Run from this bridge checkout:

```sh
bridge_root="$PWD"
stock_omp="$(command -v omp)"
build_root="$(mktemp -d)"
host_root="$build_root/source"
mkdir -p "$build_root/home"
printf '%s\n' '{"id":"native-addon-bootstrap","type":"get_state"}' | \
  env -i PATH="$PATH" HOME="$build_root/home" TERM=dumb \
    PI_CODING_AGENT_DIR="$build_root/agent" \
    PI_NATIVES_DIR="$build_root/natives" \
    OPENAI_API_KEY=sk-no-inference-bootstrap \
    "$stock_omp" --mode rpc --no-ui --no-session --no-extensions \
      --model openai/gpt-4o > "$build_root/stock-state.jsonl"
git clone --branch v18.21.0 --depth 1 https://github.com/can1357/oh-my-pi.git "$host_root"
git -C "$host_root" checkout --detach 6f03614d761366972e80e84e25d1418ed678d2c7
git -C "$host_root" apply "$bridge_root/patches/omp-v18.21-hub-api.patch"
cd "$host_root"
bun install --frozen-lockfile
cp "$build_root/natives/18.21.0"/pi_natives.linux-x64*.node packages/natives/native/
bun packages/coding-agent/scripts/build-binary.ts
"$host_root/packages/coding-agent/dist/omp" --version
```

The new executable is `$host_root/packages/coding-agent/dist/omp`; the source checkout and build stay under `$build_root`. Install this plugin through that executable and launch a new session. Stock OMP remains available for existing sessions. For other platforms, use the matching upstream native addon and build instructions.

Give this build a separate command name. The following explicitly installs or replaces your dedicated `omp-codex-hub` build, without replacing `omp`:

```sh
install -D -m755 "$host_root/packages/coding-agent/dist/omp" "$HOME/.local/bin/omp-codex-hub"
"$HOME/.local/bin/omp-codex-hub" plugin install "$bridge_root"
"$HOME/.local/bin/omp-codex-hub"
```

Add `$HOME/.local/bin` to your shell's `PATH` if you want to use the shorter `omp-codex-hub` command. Updating the bridge checkout does not rebuild this separate host; rebuild it if the packaged host patch changes.

CI runs the stock-host checks first, then checks out the pinned source, applies this packaged patch, extracts the exact stock addon, builds the separate host, and runs both patched-host cases below. These cases therefore run in CI rather than relying on the stock-host feature-detection skip.

Validate the patched executable without credentials or model inference:

```sh
CODEX_HUB_API_OMP=/absolute/path/to/patched/omp bun test/hub/jobs.mjs history
CODEX_HUB_API_OMP=/absolute/path/to/patched/omp bun test/hub/jobs.mjs mixed
```

The first case opens history as the first command in a fresh root session. The second also checks direct/Hub isolation. Both run the actual host UI against an isolated native protocol double. They do not prove native model recall; that requires a separate real-server check.
