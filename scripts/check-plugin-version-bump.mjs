#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

const PLUGIN_ROOT = "plugins/codex/";
const PLUGIN_MANIFEST = "plugins/codex/.claude-plugin/plugin.json";
const MARKETPLACE_MANIFEST = ".claude-plugin/marketplace.json";

function usage() {
  return [
    "Usage:",
    "  node scripts/check-plugin-version-bump.mjs --base <ref> [--head <ref>]",
    "",
    "Options:",
    "  --base <ref>  Base git ref to compare against.",
    "  --head <ref>  Head git ref to compare. Defaults to HEAD.",
    "  --root <dir>  Run against a different repository root.",
    "  --help        Print this help."
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    base: null,
    head: "HEAD",
    root: process.cwd()
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--base") {
      options.base = argv[i + 1];
      i += 1;
    } else if (arg === "--head") {
      options.head = argv[i + 1];
      i += 1;
    } else if (arg === "--root") {
      options.root = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }

    if (options.base === undefined || options.head === undefined || options.root === undefined) {
      throw new Error(`${arg} requires a value.`);
    }
  }

  if (!options.help && !options.base) {
    throw new Error(`Missing --base.\n\n${usage()}`);
  }

  return options;
}

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }

  return result.stdout;
}

function changedFiles(root, base, head) {
  return runGit(root, ["diff", "--name-only", "--diff-filter=ACMRD", `${base}...${head}`])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function isPluginSource(file) {
  return file.startsWith(PLUGIN_ROOT) && file !== PLUGIN_MANIFEST;
}

function readJsonAtRef(root, ref, file) {
  return JSON.parse(runGit(root, ["show", `${ref}:${file}`]));
}

function marketplacePluginVersion(json) {
  return json.plugins?.find((entry) => entry?.name === "codex")?.version;
}

function versionValues(jsonByFile) {
  return [
    {
      label: `${PLUGIN_MANIFEST} version`,
      value: jsonByFile.plugin.version
    },
    {
      label: `${MARKETPLACE_MANIFEST} metadata.version`,
      value: jsonByFile.marketplace.metadata?.version
    },
    {
      label: `${MARKETPLACE_MANIFEST} plugins[codex].version`,
      value: marketplacePluginVersion(jsonByFile.marketplace)
    }
  ];
}

function checkVersionBumps(root, base, head) {
  const files = changedFiles(root, base, head);
  const pluginSourceFiles = files.filter(isPluginSource);

  if (pluginSourceFiles.length === 0) {
    return {
      ok: true,
      message: "No plugin source changes found."
    };
  }

  const baseValues = versionValues({
    plugin: readJsonAtRef(root, base, PLUGIN_MANIFEST),
    marketplace: readJsonAtRef(root, base, MARKETPLACE_MANIFEST)
  });
  const headValues = versionValues({
    plugin: readJsonAtRef(root, head, PLUGIN_MANIFEST),
    marketplace: readJsonAtRef(root, head, MARKETPLACE_MANIFEST)
  });

  const missingBumps = headValues
    .map((headValue, index) => ({ baseValue: baseValues[index], headValue }))
    .filter(({ baseValue, headValue }) => baseValue.value === headValue.value)
    .map(({ headValue }) => headValue.label);

  const headVersionSet = new Set(headValues.map(({ value }) => value));
  const inconsistentVersions = headVersionSet.size !== 1;

  if (missingBumps.length === 0 && !inconsistentVersions) {
    return {
      ok: true,
      message: `Plugin source changes include version bumps to ${headValues[0].value}.`
    };
  }

  const details = [
    "Plugin source changed without the required version bump.",
    "",
    "Changed plugin source files:",
    ...pluginSourceFiles.map((file) => `- ${file}`)
  ];

  if (missingBumps.length > 0) {
    details.push("", "Versions that must change from the base ref:", ...missingBumps.map((label) => `- ${label}`));
  }

  if (inconsistentVersions) {
    details.push("", "Head plugin and marketplace versions must match:", ...headValues.map(({ label, value }) => `- ${label}: ${value ?? "<missing>"}`));
  }

  return {
    ok: false,
    message: details.join("\n")
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const result = checkVersionBumps(options.root, options.base, options.head);
  if (!result.ok) {
    throw new Error(result.message);
  }

  console.log(result.message);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
