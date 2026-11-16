// TEST-ONLY native OMP package lifecycle. No credentials, model requests, or real user state.
import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const omp = Bun.which("omp");
assert.ok(omp, "test:package requires the supported OMP executable on PATH");
const fix = mkdtempSync(join(tmpdir(), "codex-package-"));
const home = join(fix, "home");
const checkout = join(fix, "checkout");
const work = join(fix, "work");
const agentDir = join(home, ".omp", "agent");
const plugins = join(home, ".omp", "plugins");
const installed = join(plugins, "node_modules", manifest.name);
const env = {
  HOME: home,
  XDG_CONFIG_HOME: join(fix, "xdg", "config"),
  XDG_DATA_HOME: join(fix, "xdg", "data"),
  XDG_STATE_HOME: join(fix, "xdg", "state"),
  XDG_CACHE_HOME: join(fix, "xdg", "cache"),
  TMPDIR: join(fix, "tmp"),
  PATH: `${dirname(omp)}:/usr/bin:/bin`,
  LANG: "C.UTF-8",
  TERM: "dumb",
};
for (const dir of [checkout, work, join(agentDir, "agents"), env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME, env.TMPDIR]) mkdirSync(dir, { recursive: true });
for (const file of ["package.json", ...manifest.files]) cpSync(join(repo, file), join(checkout, file), { recursive: true });
const agentPath = join(agentDir, "agents", "codex-bridge.md");
const unrelated = "---\nname: codex-bridge\ndescription: Operator-owned agent; never overwrite.\n---\nKeep this file.\n";
const configPath = join(agentDir, "config.yml");
const config = "task:\n  perCallModel: off\nproviders:\n  openaiLiveSteering: false\n";
writeFileSync(agentPath, unrelated);
writeFileSync(configPath, config);
const run = (...args) => {
  const result = Bun.spawnSync([omp, "plugin", ...args], { cwd: work, env, timeout: 30000 });
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  assert.equal(result.exitCode, 0, `omp plugin ${args.join(" ")}:\n${output}`);
  assert.equal(readFileSync(agentPath, "utf8"), unrelated, "native package operations must never overwrite an operator agent");
  assert.equal(readFileSync(configPath, "utf8"), config, "native package operations must not change model or steering settings");
  return output;
};

try {
  run("install", checkout);
  assert.ok(lstatSync(installed).isSymbolicLink(), "local installs use OMP's package link");
  assert.equal(realpathSync(installed), realpathSync(checkout));
  assert.equal(readFileSync(join(installed, "agents", "codex-bridge.md"), "utf8"), readFileSync(join(repo, "agents", "codex-bridge.md"), "utf8"));
  let runtime = JSON.parse(readFileSync(join(plugins, "omp-plugins.lock.json"), "utf8"));
  assert.equal(runtime.plugins[manifest.name].enabled, true);
  assert.ok(run("list", "--json").includes(manifest.name));

  // A local install follows its checkout. Source updates need no reinstall or global agent refresh.
  const updated = `${readFileSync(join(checkout, "agents", "codex-bridge.md"), "utf8")}\nPackage update marker.\n`;
  writeFileSync(join(checkout, "agents", "codex-bridge.md"), updated);
  assert.equal(readFileSync(join(installed, "agents", "codex-bridge.md"), "utf8"), updated);
  run("install", checkout); // Idempotent relink retains the current checkout and never copies an agent.
  assert.equal(realpathSync(installed), realpathSync(checkout));

  run("uninstall", manifest.name);
  assert.equal(existsSync(installed), false);
  runtime = JSON.parse(readFileSync(join(plugins, "omp-plugins.lock.json"), "utf8"));
  assert.equal(runtime.plugins[manifest.name], undefined);
  assert.equal(runtime.settings[manifest.name], undefined);
  assert.ok(existsSync(join(checkout, "agents", "codex-bridge.md")), "uninstall must retain the source checkout");
  console.log("package lifecycle: PASS (isolated native install, live checkout update, reinstall, uninstall, operator files preserved)");
  rmSync(fix, { recursive: true, force: true });
} catch (error) {
  console.error(`package lifecycle: FAIL (isolated HOME kept at ${fix})`);
  throw error;
}
