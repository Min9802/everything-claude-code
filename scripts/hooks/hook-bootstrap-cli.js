#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { resolveEccRoot } = require('../lib/resolve-ecc-root');

function readStdinRaw() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
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

function main() {
  const [, , mode, relPath, ...args] = process.argv;
  const raw = readStdinRaw();

  if (!mode || !relPath) {
    process.stdout.write(raw);
    process.exit(0);
  }

  const rootDir = resolveEccRoot({ probe: path.join('scripts', 'hooks', 'plugin-hook-bootstrap.js') });
  const bootstrapPath = path.join(rootDir, 'scripts', 'hooks', 'plugin-hook-bootstrap.js');

  if (!fs.existsSync(bootstrapPath)) {
    writeStderr('[Hook] bootstrap CLI could not locate plugin-hook-bootstrap.js; passing through\n');
    process.stdout.write(raw);
    process.exit(0);
  }

  const result = spawnSync(process.execPath, [bootstrapPath, mode, relPath, ...args], {
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

  passthrough(raw, result);
  writeStderr(result.stderr);

  if (result.error || result.signal || result.status === null) {
    const reason = result.error
      ? result.error.message
      : result.signal
        ? `terminated by signal ${result.signal}`
        : 'missing exit status';
    writeStderr(`[Hook] bootstrap CLI execution failed: ${reason}\n`);
    process.exit(0);
  }

  process.exit(Number.isInteger(result.status) ? result.status : 0);
}

main();