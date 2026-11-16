// Actual OMP print mode with the isolated protocol double; no credentials or inference.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixture.sh', import.meta.url));
for (const cancel of [false, true]) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-print-'));
  try {
    const result = Bun.spawnSync([fixture, '--mode', 'json', '-p', '--wait-async', '--max-time', cancel ? '2' : '10', 'Run the direct print fixture.'], {
      env: { ...process.env, CODEX_HUB_FIXTURE_DIR: dir,
        CODEX_HUB_FIXTURE_OPTIONS: JSON.stringify({ turns: [cancel ? 'hold' : 'rich-output'] }),
        CODEX_HUB_FIXTURE_DIRECT_JSON: JSON.stringify({ action: 'run', prompt: 'Print completion',
          outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }),
      },
      stdout: 'pipe', stderr: 'pipe', timeout: 20000,
    });
    const output = new TextDecoder().decode(result.stdout);
    const errors = new TextDecoder().decode(result.stderr);
    writeFileSync(join(dir, 'stdout.jsonl'), output);
    writeFileSync(join(dir, 'stderr.txt'), errors);
    const frames = output.trim().split('\n').filter(Boolean).map(JSON.parse);
    const trace = readFileSync(join(dir, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const calls = method => trace.filter(entry => entry.message?.method === method);
    const tool = frames.find(frame => frame.type === 'tool_execution_end' && frame.toolName === 'codex_bridge');
    assert.equal(calls('turn/start').length, 1, errors);
    if (cancel) {
      assert.equal(tool?.result.isError, true, 'a cancelled tool must expose an error even when the host exits zero');
      assert.equal(tool.result.details.code, 'ABORT_ERR');
      assert.match(errors, /Codex print call cancelled/);
      assert.equal(calls('turn/interrupt').length, 1, 'deadline cancellation reaches the native turn');
    } else {
      assert.equal(result.exitCode, 0, errors);
      assert.equal(tool?.result.details.status, 'completed', output);
      assert.deepEqual(JSON.parse(tool.result.details.text.split('\n').at(-1)), { ok: true });
      assert.ok(!frames.some(frame => frame.message?.customType === 'codex-bridge-result'), 'terminal output is not duplicated as a follow-up');
      assert.equal(calls('turn/interrupt').length, 0);
    }
    console.log(`print ${cancel ? 'deadline cancellation' : 'terminal completion'}: PASS`);
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    console.error(`print fixture retained at ${dir}`);
    throw error;
  }
}
