import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const venv = resolve(root, '.venv');
const isWindows = process.platform === 'win32';
const venvPython = resolve(venv, isWindows ? 'Scripts/python.exe' : 'bin/python');
const setup = process.argv[2] === 'setup';

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (setup) {
  if (!existsSync(venvPython)) {
    const candidates = isWindows ? ['python', 'py'] : ['python3', 'python'];
    let created = false;
    for (const candidate of candidates) {
      const result = spawnSync(candidate, ['-m', 'venv', venv], {
        cwd: root,
        stdio: 'inherit',
        windowsHide: true,
      });
      if (!result.error && result.status === 0) {
        created = true;
        break;
      }
    }
    if (!created) {
      throw new Error('Python 3 was not found. Install Python 3.10+ and retry.');
    }
  }
  run(venvPython, ['-m', 'pip', 'install', '-r', 'desktop/requirements.txt']);
} else {
  if (!existsSync(venvPython)) {
    throw new Error('Desktop environment missing. Run "npm run desktop:setup" first.');
  }
  run(venvPython, ['desktop/main.py', ...process.argv.slice(2)]);
}
