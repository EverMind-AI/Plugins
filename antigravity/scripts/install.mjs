#!/usr/bin/env node
/**
 * install.mjs — EverOS Antigravity Plugin Unified Installer
 *
 * Supports three deployment modes:
 *   1. Workspace Local Mode: Injects absolute paths into <workspace>/.agents/
 *   2. Global Plugin Bundle Mode: Deploys as standard plugin to ~/.gemini/config/plugins/everos/
 *   3. Native Sidecar Daemon Mode: Registers EverOS as an Antigravity background sidecar
 *
 * Usage:
 *   node scripts/install.mjs [options]
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");

function parseArgs(args) {
  const options = {
    workspace: null,
    global: false,
    sidecar: false,
    python: null,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--workspace" || arg === "-w") {
      options.workspace = path.resolve(args[++i] || process.cwd());
    } else if (arg === "--global" || arg === "-g") {
      options.global = true;
    } else if (arg === "--sidecar" || arg === "-s") {
      options.sidecar = true;
    } else if (arg === "--python" || arg === "-p") {
      options.python = path.resolve(args[++i]);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }

  // Default to workspace mode on cwd if neither global nor sidecar is specified
  if (!options.global && !options.sidecar && !options.workspace) {
    options.workspace = process.cwd();
  }

  return options;
}

function normalizePath(p) {
  return p.replace(/\\/g, "/");
}

function backupFile(targetPath, dryRun) {
  if (fs.existsSync(targetPath)) {
    const bakPath = `${targetPath}.bak`;
    if (!dryRun) {
      fs.copyFileSync(targetPath, bakPath);
    }
    console.log(`[install] Backed up existing file -> ${bakPath}`);
  }
}

/**
 * 1. Install to Workspace (.agents/hooks.json & mcp_config.json with absolute paths)
 */
export function installToWorkspace(targetWorkspace, { dryRun = false } = {}) {
  const targetAgentsDir = path.join(targetWorkspace, ".agents");
  const normalizedRoot = normalizePath(pluginRoot);

  console.log(`\n--- [Workspace Mode] ---`);
  console.log(`[install] Plugin Root: ${pluginRoot}`);
  console.log(`[install] Target Workspace: ${targetWorkspace}`);
  console.log(`[install] Agents Directory: ${targetAgentsDir}`);

  if (!dryRun && !fs.existsSync(targetAgentsDir)) {
    fs.mkdirSync(targetAgentsDir, { recursive: true });
  }

  // Install hooks.json
  const templateHooksPath = path.join(pluginRoot, "hooks.json");
  if (!fs.existsSync(templateHooksPath)) {
    throw new Error(`Template hooks.json not found at ${templateHooksPath}`);
  }

  const rawHooks = fs.readFileSync(templateHooksPath, "utf8");
  const resolvedHooksStr = rawHooks
    .replace(/\$\{PLUGIN_ROOT:-\.?\}/g, normalizedRoot)
    .replace(/\$\{PLUGIN_ROOT\}/g, normalizedRoot)
    .replace(/__PLUGIN_ROOT__/g, normalizedRoot);

  const hooksTemplate = JSON.parse(resolvedHooksStr);
  const targetHooksPath = path.join(targetAgentsDir, "hooks.json");

  let finalHooks = hooksTemplate;
  if (fs.existsSync(targetHooksPath)) {
    backupFile(targetHooksPath, dryRun);
    try {
      const existing = JSON.parse(fs.readFileSync(targetHooksPath, "utf8"));
      finalHooks = {
        ...existing,
        ...hooksTemplate,
      };
    } catch (e) {
      console.warn(`[install] Warning: existing hooks.json was invalid JSON, overwriting: ${e.message}`);
    }
  }

  const hooksContent = JSON.stringify(finalHooks, null, 2) + "\n";
  if (dryRun) {
    console.log(`[install] [dry-run] Would write hooks -> ${targetHooksPath}`);
  } else {
    fs.writeFileSync(targetHooksPath, hooksContent, "utf8");
    console.log(`[install] Successfully wrote hooks -> ${targetHooksPath}`);
  }

  // Install mcp_config.json
  const templateMcpPath = path.join(pluginRoot, "mcp_config.json");
  if (fs.existsSync(templateMcpPath)) {
    const rawMcp = fs.readFileSync(templateMcpPath, "utf8");
    const resolvedMcpStr = rawMcp
      .replace(/\$\{PLUGIN_ROOT:-\.?\}/g, normalizedRoot)
      .replace(/\$\{PLUGIN_ROOT\}/g, normalizedRoot)
      .replace(/__PLUGIN_ROOT__/g, normalizedRoot);

    const mcpTemplate = JSON.parse(resolvedMcpStr);
    const targetMcpPath = path.join(targetAgentsDir, "mcp_config.json");

    let finalMcp = mcpTemplate;
    if (fs.existsSync(targetMcpPath)) {
      backupFile(targetMcpPath, dryRun);
      try {
        const existingMcp = JSON.parse(fs.readFileSync(targetMcpPath, "utf8"));
        finalMcp = {
          ...existingMcp,
          mcpServers: {
            ...(existingMcp.mcpServers || {}),
            ...(mcpTemplate.mcpServers || {}),
          },
        };
      } catch (e) {
        console.warn(`[install] Warning: existing mcp_config.json was invalid JSON, overwriting: ${e.message}`);
      }
    }

    const mcpContent = JSON.stringify(finalMcp, null, 2) + "\n";
    if (dryRun) {
      console.log(`[install] [dry-run] Would write MCP config -> ${targetMcpPath}`);
    } else {
      fs.writeFileSync(targetMcpPath, mcpContent, "utf8");
      console.log(`[install] Successfully wrote MCP config -> ${targetMcpPath}`);
    }
  }

  console.log(`[install] Workspace configuration complete.`);
  return { targetHooksPath, targetAgentsDir };
}

/**
 * 2. Install as Global Plugin Bundle (~/.gemini/config/plugins/everos/)
 */
export function installGlobalPlugin({ dryRun = false } = {}) {
  const globalPluginsDir = path.join(os.homedir(), ".gemini", "config", "plugins");
  const targetPluginDir = path.join(globalPluginsDir, "everos");

  console.log(`\n--- [Global Plugin Bundle Mode] ---`);
  console.log(`[install] Source: ${pluginRoot}`);
  console.log(`[install] Destination: ${targetPluginDir}`);

  if (dryRun) {
    console.log(`[install] [dry-run] Would deploy global plugin to ${targetPluginDir}`);
    return;
  }

  if (!fs.existsSync(targetPluginDir)) {
    fs.mkdirSync(targetPluginDir, { recursive: true });
  }

  // Copy bundle items (excluding tests, fixtures, node_modules)
  const itemsToCopy = [
    "plugin.json",
    "package.json",
    "hooks.json",
    "mcp_config.json",
    "README.md",
    "README_zh.md",
    "hooks",
    "skills",
    "mcp",
    "scripts",
  ];

  for (const item of itemsToCopy) {
    const src = path.join(pluginRoot, item);
    const dest = path.join(targetPluginDir, item);
    if (!fs.existsSync(src)) continue;

    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.cpSync(src, dest, { recursive: true, force: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  console.log(`[install] Successfully deployed global plugin to ${targetPluginDir}`);
  console.log(`[install] Antigravity will automatically load it on next launch with full \${PLUGIN_ROOT} resolution.`);
}

/**
 * 3. Register as Native Antigravity Sidecar (~/.gemini/config/sidecars/everos/sidecar.json)
 */
export function registerSidecar({ pythonPath = null, dryRun = false } = {}) {
  const sidecarDir = path.join(os.homedir(), ".gemini", "config", "sidecars", "everos");
  const sidecarJsonPath = path.join(sidecarDir, "sidecar.json");

  console.log(`\n--- [Native Sidecar Daemon Mode] ---`);
  console.log(`[install] Sidecar Directory: ${sidecarDir}`);

  let resolvedPython = pythonPath;
  if (!resolvedPython) {
    // Probe local venv in EverOS or parent workspace
    const candidateEverosExe = path.resolve(pluginRoot, "..", "..", "EverOS", ".venv", "Scripts", "everos.exe");
    if (fs.existsSync(candidateEverosExe)) {
      resolvedPython = candidateEverosExe;
    } else {
      const candidates = [
        path.resolve(pluginRoot, "..", "..", "EverOS", ".venv", "Scripts", "python.exe"),
        path.resolve(pluginRoot, "..", "..", "EverOS", ".venv", "bin", "python"),
        path.resolve(pluginRoot, "..", "..", ".venv", "Scripts", "python.exe"),
        path.resolve(pluginRoot, "..", "..", ".venv", "bin", "python"),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          resolvedPython = c;
          break;
        }
      }
    }
    if (!resolvedPython) {
      resolvedPython = "everos";
    }
  }

  console.log(`[install] Using Executable: ${resolvedPython}`);

  const isExe = resolvedPython.endsWith("everos.exe") || resolvedPython.endsWith("everos");
  const sidecarConfig = {
    command: normalizePath(resolvedPython),
    args: isExe ? ["server", "start"] : ["-m", "everos.entrypoints.cli.main", "server", "start"],
    restart_policy: "always",
    description: "EverOS Cognitive Memory Engine (Native Antigravity Sidecar)",
  };

  const content = JSON.stringify(sidecarConfig, null, 2) + "\n";
  if (dryRun) {
    console.log(`[install] [dry-run] Would write sidecar.json:\n${content}`);
    return;
  }

  if (!fs.existsSync(sidecarDir)) {
    fs.mkdirSync(sidecarDir, { recursive: true });
  }

  backupFile(sidecarJsonPath, dryRun);
  fs.writeFileSync(sidecarJsonPath, content, "utf8");
  console.log(`[install] Successfully registered EverOS sidecar -> ${sidecarJsonPath}`);
  console.log(`[install] Antigravity engine will automatically supervise EverOS daemon.`);
}

// CLI entrypoint
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(`EverOS Antigravity Plugin Installer
Usage:
  node scripts/install.mjs [options]

Modes & Options:
  -w, --workspace <path>  Install to specific workspace .agents/ (Default: current directory)
  -g, --global            Install as standard Global Plugin Bundle to ~/.gemini/config/plugins/everos/
  -s, --sidecar           Register EverOS as an Antigravity background sidecar daemon
  -p, --python <path>     Explicit python interpreter path for sidecar mode
      --dry-run           Print generated configs without writing files
  -h, --help              Show this help message

Quick AI Agent Install Prompt:
  "Please run: node F:/ArtEmis/EverPlugins/antigravity/scripts/install.mjs -g -s"
`);
    process.exit(0);
  }

  try {
    if (options.global) {
      installGlobalPlugin({ dryRun: options.dryRun });
    }
    if (options.sidecar) {
      registerSidecar({ pythonPath: options.python, dryRun: options.dryRun });
    }
    if (options.workspace) {
      installToWorkspace(options.workspace, { dryRun: options.dryRun });
    }
  } catch (err) {
    console.error(`[install] Error: ${err.message}`);
    process.exit(1);
  }
}
