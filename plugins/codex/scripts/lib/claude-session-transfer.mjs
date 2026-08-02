import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";

export const TRANSCRIPT_PATH_ENV = "CODEX_COMPANION_TRANSCRIPT_PATH";

function resolveClaudeProjectsDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

function findSessionCandidates(projects, sessionId) {
  let entries;
  try {
    entries = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return [];
  }

  const filename = `${sessionId}.jsonl`;
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .flatMap((entry) => {
      const candidate = path.join(projects, entry.name, filename);
      try {
        const source = fs.realpathSync(candidate);
        return fs.statSync(source).isFile() ? [source] : [];
      } catch {
        return [];
      }
    });
  return [...new Set(candidates)];
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  const requestedPath = options.source || process.env[TRANSCRIPT_PATH_ENV];
  const sourceFromEnvironment = !options.source && Boolean(requestedPath);
  if (!requestedPath) {
    throw new Error("Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.");
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  let source;
  let projects;
  const projectsDir = resolveClaudeProjectsDir();
  try {
    projects = fs.realpathSync(projectsDir);
  } catch {
    throw new Error(`Claude session file not found: ${sourcePath}`);
  }
  try {
    source = fs.realpathSync(sourcePath);
  } catch {
    if (!sourceFromEnvironment) {
      throw new Error(`Claude session file not found: ${sourcePath}`);
    }

    const sessionId = path.basename(sourcePath, ".jsonl");
    const candidates = findSessionCandidates(projects, sessionId);
    if (candidates.length === 0) {
      throw new Error(`Claude session file not found: ${sourcePath}`);
    }
    if (candidates.length > 1) {
      throw new Error(
        `Claude session id "${sessionId}" matched several transcripts:\n${candidates.join("\n")}\nRe-run with --source <path> to disambiguate.`
      );
    }
    source = candidates[0];
  }
  const relative = path.relative(projects, source);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Codex can import Claude sessions only from ${projectsDir}: ${source}`);
  }
  return source;
}
