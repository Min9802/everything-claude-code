'use strict';

const fs = require('fs');
const path = require('path');

const { writeInstallState } = require('../install-state');
const { filterMcpConfig, parseDisabledMcpServers } = require('../mcp-config');

function readJsonObject(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse ${label} at ${filePath}: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label} at ${filePath}: expected a JSON object`);
  }

  return parsed;
}

function normalizeShellScriptLineEndings(filePath) {
  if (path.extname(String(filePath || '')).toLowerCase() !== '.sh') {
    return;
  }

  if (!fs.existsSync(filePath)) {
    return;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const normalized = raw.replace(/\r\n/g, '\n');
  if (normalized !== raw) {
    fs.writeFileSync(filePath, normalized, 'utf8');
  }
}

function replacePluginRootPlaceholders(value, pluginRoot) {
  if (!pluginRoot) {
    return value;
  }

  if (typeof value === 'string') {
    return value.split('${CLAUDE_PLUGIN_ROOT}').join(pluginRoot);
  }

  if (Array.isArray(value)) {
    return value.map(item => replacePluginRootPlaceholders(item, pluginRoot));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        replacePluginRootPlaceholders(nestedValue, pluginRoot),
      ])
    );
  }

  return value;
}

function findHooksSourcePath(plan, hooksDestinationPath) {
  const operation = plan.operations.find(item => item.destinationPath === hooksDestinationPath);
  return operation ? operation.sourcePath : null;
}

function isMcpConfigPath(filePath) {
  const basename = path.basename(String(filePath || ''));
  return basename === '.mcp.json' || basename === 'mcp.json';
}

function buildFilteredMcpWrites(plan) {
  const disabledServers = parseDisabledMcpServers(process.env.ECC_DISABLED_MCPS);
  if (disabledServers.length === 0) {
    return [];
  }

  const writes = [];

  for (const operation of plan.operations) {
    if (!isMcpConfigPath(operation.destinationPath) || !operation.sourcePath || !fs.existsSync(operation.sourcePath)) {
      continue;
    }

    let sourceConfig;
    try {
      sourceConfig = readJsonObject(operation.sourcePath, 'MCP config');
    } catch {
      continue;
    }

    if (!sourceConfig.mcpServers || typeof sourceConfig.mcpServers !== 'object' || Array.isArray(sourceConfig.mcpServers)) {
      continue;
    }

    const filtered = filterMcpConfig(sourceConfig, disabledServers);
    if (filtered.removed.length === 0) {
      continue;
    }

    writes.push({
      destinationPath: operation.destinationPath,
      filteredConfig: filtered.config,
    });
  }

  return writes;
}

function buildResolvedClaudeHooks(plan) {
  if (!plan.adapter || plan.adapter.target !== 'claude') {
    return null;
  }

  const pluginRoot = plan.targetRoot;
  const hooksDestinationPath = path.join(plan.targetRoot, 'hooks', 'hooks.json');
  const hooksSourcePath = findHooksSourcePath(plan, hooksDestinationPath) || hooksDestinationPath;
  if (!fs.existsSync(hooksSourcePath)) {
    return null;
  }

  const hooksConfig = readJsonObject(hooksSourcePath, 'hooks config');
  const resolvedHooks = replacePluginRootPlaceholders(hooksConfig.hooks, pluginRoot);
  if (!resolvedHooks || typeof resolvedHooks !== 'object' || Array.isArray(resolvedHooks)) {
    throw new Error(`Invalid hooks config at ${hooksSourcePath}: expected "hooks" to be a JSON object`);
  }

  return {
    hooksDestinationPath,
    hooksConfig,
    resolvedHooksConfig: {
      ...hooksConfig,
      hooks: resolvedHooks,
    },
  };
}

function listDirectories(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }

  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

function discoverVscodeAgentPluginHookPaths(plan) {
  if (!plan.adapter || plan.adapter.target !== 'claude') {
    return [];
  }

  const claudeRoot = path.basename(plan.targetRoot);
  if (claudeRoot !== '.claude') {
    return [];
  }

  const homeDir = path.dirname(plan.targetRoot);
  const roots = [
    path.join(homeDir, '.vscode', 'agent-plugins'),
    path.join(homeDir, '.vscode-insiders', 'agent-plugins'),
  ];
  const discovered = [];

  for (const agentPluginsRoot of roots) {
    for (const hostName of listDirectories(agentPluginsRoot)) {
      const hostRoot = path.join(agentPluginsRoot, hostName);
      for (const ownerName of listDirectories(hostRoot)) {
        const hooksPath = path.join(hostRoot, ownerName, 'everything-claude-code', 'hooks', 'hooks.json');
        if (fs.existsSync(hooksPath)) {
          discovered.push(hooksPath);
        }
      }
    }
  }

  return discovered;
}

function discoverVscodeAgentPluginRoots(plan) {
  return discoverVscodeAgentPluginHookPaths(plan)
    .map(hooksPath => path.dirname(path.dirname(hooksPath)));
}

function buildAgentPluginHookWrites(plan, hooksConfig) {
  if (!hooksConfig || typeof hooksConfig !== 'object' || Array.isArray(hooksConfig)) {
    return [];
  }

  const writes = [];
  for (const hooksPath of discoverVscodeAgentPluginHookPaths(plan)) {
    writes.push({
      destinationPath: hooksPath,
      resolvedHooksConfig: {
        ...hooksConfig,
        hooks: replacePluginRootPlaceholders(hooksConfig.hooks, plan.targetRoot),
      },
    });
  }

  return writes;
}

function buildAgentPluginScriptCopies(plan) {
  if (!plan.adapter || plan.adapter.target !== 'claude') {
    return [];
  }

  const hooksScriptsDir = path.join(plan.targetRoot, 'scripts', 'hooks');
  const cliDestination = path.join(hooksScriptsDir, 'hook-bootstrap-cli.js');
  const cliOperation = plan.operations.find(item => item.destinationPath === cliDestination);
  const cliSourceDir = cliOperation ? path.dirname(cliOperation.sourcePath) : null;

  function resolveManagedScriptSource(relPath) {
    const destinationPath = path.join(plan.targetRoot, relPath);
    const operation = plan.operations.find(item => item.destinationPath === destinationPath);
    if (operation && operation.sourcePath && fs.existsSync(operation.sourcePath)) {
      return operation.sourcePath;
    }

    if (cliSourceDir) {
      const fallbackSource = path.join(cliSourceDir, path.basename(relPath));
      if (fs.existsSync(fallbackSource)) {
        return fallbackSource;
      }
    }

    return null;
  }

  const managedScriptRelPaths = [
    path.join('scripts', 'hooks', 'hook-bootstrap-cli.js'),
    path.join('scripts', 'hooks', 'plugin-hook-bootstrap.js'),
    path.join('scripts', 'hooks', 'run-with-flags-shell.sh'),
  ];

  const managedScriptOps = managedScriptRelPaths
    .map(relPath => {
      const sourcePath = resolveManagedScriptSource(relPath);
      return sourcePath ? { relPath, sourcePath } : null;
    })
    .filter(Boolean);

  if (managedScriptOps.length === 0) {
    return [];
  }

  const writes = [];
  for (const pluginRoot of discoverVscodeAgentPluginRoots(plan)) {
    for (const scriptOp of managedScriptOps) {
      writes.push({
        sourcePath: scriptOp.sourcePath,
        destinationPath: path.join(pluginRoot, scriptOp.relPath),
      });
    }
  }

  return writes;
}

function buildClaudeSupplementalHookScriptCopies(plan) {
  if (!plan.adapter || plan.adapter.target !== 'claude') {
    return [];
  }

  const hooksScriptsDir = path.join(plan.targetRoot, 'scripts', 'hooks');
  const cliDestination = path.join(hooksScriptsDir, 'hook-bootstrap-cli.js');
  const cliOperation = plan.operations.find(item => item.destinationPath === cliDestination);
  if (!cliOperation || !cliOperation.sourcePath) {
    return [];
  }

  const sourcePath = path.join(path.dirname(cliOperation.sourcePath), 'run-with-flags-shell.sh');
  if (!fs.existsSync(sourcePath)) {
    return [];
  }

  const destinationPath = path.join(hooksScriptsDir, 'run-with-flags-shell.sh');
  const alreadyManaged = plan.operations.some(item => item.destinationPath === destinationPath);
  if (alreadyManaged) {
    return [];
  }

  return [{ sourcePath, destinationPath }];
}

function applyInstallPlan(plan) {
  const resolvedClaudeHooksPlan = buildResolvedClaudeHooks(plan);
  const agentPluginHookWrites = buildAgentPluginHookWrites(
    plan,
    resolvedClaudeHooksPlan ? resolvedClaudeHooksPlan.hooksConfig : null
  );
  const claudeSupplementalScriptCopies = buildClaudeSupplementalHookScriptCopies(plan);
  const agentPluginScriptCopies = buildAgentPluginScriptCopies(plan);
  const filteredMcpWrites = buildFilteredMcpWrites(plan);

  for (const operation of plan.operations) {
    fs.mkdirSync(path.dirname(operation.destinationPath), { recursive: true });
    fs.copyFileSync(operation.sourcePath, operation.destinationPath);
    normalizeShellScriptLineEndings(operation.destinationPath);
  }

  if (resolvedClaudeHooksPlan) {
    fs.mkdirSync(path.dirname(resolvedClaudeHooksPlan.hooksDestinationPath), { recursive: true });
    fs.writeFileSync(
      resolvedClaudeHooksPlan.hooksDestinationPath,
      JSON.stringify(resolvedClaudeHooksPlan.resolvedHooksConfig, null, 2) + '\n',
      'utf8'
    );
  }

  for (const writePlan of agentPluginHookWrites) {
    fs.mkdirSync(path.dirname(writePlan.destinationPath), { recursive: true });
    fs.writeFileSync(
      writePlan.destinationPath,
      JSON.stringify(writePlan.resolvedHooksConfig, null, 2) + '\n',
      'utf8'
    );
  }

  for (const copyPlan of claudeSupplementalScriptCopies) {
    fs.mkdirSync(path.dirname(copyPlan.destinationPath), { recursive: true });
    fs.copyFileSync(copyPlan.sourcePath, copyPlan.destinationPath);
    normalizeShellScriptLineEndings(copyPlan.destinationPath);
  }

  for (const copyPlan of agentPluginScriptCopies) {
    fs.mkdirSync(path.dirname(copyPlan.destinationPath), { recursive: true });
    fs.copyFileSync(copyPlan.sourcePath, copyPlan.destinationPath);
    normalizeShellScriptLineEndings(copyPlan.destinationPath);
  }

  for (const writePlan of filteredMcpWrites) {
    fs.mkdirSync(path.dirname(writePlan.destinationPath), { recursive: true });
    fs.writeFileSync(
      writePlan.destinationPath,
      JSON.stringify(writePlan.filteredConfig, null, 2) + '\n',
      'utf8'
    );
  }

  writeInstallState(plan.installStatePath, plan.statePreview);

  return {
    ...plan,
    applied: true,
  };
}

module.exports = {
  applyInstallPlan,
};
