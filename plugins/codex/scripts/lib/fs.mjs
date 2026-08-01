import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "codex-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeJsonFileAtomic(filePath, value) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  // Creating the temp file exclusively before the try block is what makes the
  // cleanup below safe: a failure here means the path was never ours to remove.
  const handle = fs.openSync(tempPath, "wx");

  try {
    fs.writeFileSync(handle, contents, "utf8");
    fs.closeSync(handle);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.closeSync(handle);
    } catch {
      // Already closed; the unlink below is the cleanup that matters.
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Best effort cleanup; preserve the original write error.
    }
    throw error;
  }
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return fs.readFileSync(0, "utf8");
}
