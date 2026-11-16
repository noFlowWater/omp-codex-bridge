import { fileURLToPath } from 'node:url';

const smoke = fileURLToPath(new URL('./smoke.mjs', import.meta.url));
const packageCheck = fileURLToPath(new URL('../package.mjs', import.meta.url));
const printCheck = fileURLToPath(new URL('./print.mjs', import.meta.url));
const jobsCheck = fileURLToPath(new URL('./jobs.mjs', import.meta.url));
const modes = [
  'rpc', 'rpc-model', 'rpc-lifecycle', 'rpc-branches', 'rpc-elicitation',
  'tui-question', 'tui-clear', 'tui-operator', 'tui-progress', 'tui-execution', 'tui-approval', 'tui-form',
  'tui-progress-many', 'tui-question-secret', 'rpc-question-secret',
];

for (const args of [[packageCheck], [printCheck], ...modes.map(mode => [smoke, mode]), [jobsCheck], [jobsCheck, 'mixed']]) {
  const child = Bun.spawn([process.execPath, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
