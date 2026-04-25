#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function readStdinRaw() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_error) {
    return '';
  }
}

function writeStderr(stderr) {
  if (typeof stderr === 'string' && stderr.length > 0) {
    process.stderr.write(stderr);
  }
}

function passthrough(raw, result) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  if (stdout) {
    process.stdout.write(stdout);
    return;
  }

  if (!Number.isInteger(result?.status) || result.status === 0) {
    process.stdout.write(raw);
  }
}

function resolveTarget(rootDir, relPath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(rootDir, relPath);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(`Path traversal rejected: ${relPath}`);
  }
  return resolvedTarget;
}

function toBashScriptPath(filePath) {
  if (process.platform !== 'win32') {
    return filePath;
  }

  const normalized = String(filePath || '').replace(/\\/g, '/');
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!driveMatch) {
    return normalized;
  }

  return `/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
}

function findShellBinary() {
  const candidates = [];
  if (process.env.BASH && process.env.BASH.trim()) {
    candidates.push(process.env.BASH.trim());
  }

  if (process.platform === 'win32') {
    candidates.push('bash.exe', 'bash');
  } else {
    candidates.push('bash', 'sh');
  }

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', ':'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (!probe.error) {
      return candidate;
    }
  }

  return null;
}

function spawnNode(rootDir, relPath, raw, args) {
  return spawnSync(process.execPath, [resolveTarget(rootDir, relPath), ...args], {
    input: raw,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: rootDir,
      ECC_PLUGIN_ROOT: rootDir,
    },
    cwd: process.cwd(),
    timeout: 30000,
    windowsHide: true,
  });
}

function spawnShell(rootDir, relPath, raw, args) {
  const shell = findShellBinary();
  if (!shell) {
    return {
      status: 0,
      stdout: '',
      stderr: '[Hook] shell runtime unavailable; skipping shell-backed hook\n',
    };
  }

  const resolvedRoot = path.resolve(rootDir);
  const resolvedScript = resolveTarget(rootDir, relPath);

  let executableScript = resolvedScript;
  let tempScript = null;
  try {
    const source = fs.readFileSync(resolvedScript, 'utf8');
    const normalized = source.replace(/\r\n/g, '\n');
    if (normalized !== source) {
      tempScript = `${resolvedScript}.ecc-tmp-${process.pid}-${Date.now()}.sh`;
      fs.writeFileSync(tempScript, normalized, 'utf8');
      executableScript = tempScript;
    }
  } catch {
    // Continue with the original script path; execution phase will surface issues.
  }

  const relativeScript = path.relative(resolvedRoot, executableScript);
  const shellScriptPath = relativeScript.replace(/\\/g, '/');

  const result = spawnSync(shell, [shellScriptPath, ...args], {
    input: raw,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: rootDir,
      ECC_PLUGIN_ROOT: rootDir,
    },
    cwd: resolvedRoot,
    timeout: 30000,
    windowsHide: true,
  });

  if (tempScript) {
    try {
      fs.unlinkSync(tempScript);
    } catch {
      // Best-effort cleanup.
    }
  }

  return result;
}

function main() {
  const [, , mode, relPath, ...args] = process.argv;
  const raw = readStdinRaw();
  const rootDir = process.env.CLAUDE_PLUGIN_ROOT || process.env.ECC_PLUGIN_ROOT;

  if (!mode || !relPath || !rootDir) {
    process.stdout.write(raw);
    process.exit(0);
  }

  let result;
  try {
    if (mode === 'node') {
      result = spawnNode(rootDir, relPath, raw, args);
    } else if (mode === 'shell') {
      result = spawnShell(rootDir, relPath, raw, args);
    } else {
      writeStderr(`[Hook] unknown bootstrap mode: ${mode}\n`);
      process.stdout.write(raw);
      process.exit(0);
    }
  } catch (error) {
    writeStderr(`[Hook] bootstrap resolution failed: ${error.message}\n`);
    process.stdout.write(raw);
    process.exit(0);
  }

  passthrough(raw, result);
  writeStderr(result.stderr);

  if (result.error || result.signal || result.status === null) {
    const reason = result.error
      ? result.error.message
      : result.signal
        ? `terminated by signal ${result.signal}`
        : 'missing exit status';
    writeStderr(`[Hook] bootstrap execution failed: ${reason}\n`);
    process.exit(0);
  }

  process.exit(Number.isInteger(result.status) ? result.status : 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  resolveTarget,
  toBashScriptPath,
};
