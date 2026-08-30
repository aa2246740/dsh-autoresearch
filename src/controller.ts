// @ts-nocheck
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appendHookLogEntryIfConfigured, runHook, steerMessageFor } from "./hooks.js";
import { hasAutoresearchConfigHeader, reconstructJsonlState } from "./jsonl.js";
import { ensureParentDir, sessionFileCandidates, sessionFilePath } from "./paths.js";
import { CONTINUE_MARKER, CONTINUATION_REQUIRED } from "./types.js";

export const DEFAULT_MAX_AUTORESUME_TURNS = 20;
export const EXPERIMENT_MAX_LINES = 10;
export const EXPERIMENT_MAX_BYTES = 4 * 1024;
const DISPLAY_MAX_LINES = 80;
const DISPLAY_MAX_BYTES = 64 * 1024;
const FULL_OUTPUT_THRESHOLD = 64 * 1024;
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const INITIAL_SCOPE_MAX_FILES = 256;
const INITIAL_SCOPE_MAX_BYTES = 64 * 1024 * 1024;
const INITIAL_SCOPE_MAX_DIRS = 96;
const INITIAL_SCOPE_IGNORED_DIRS = new Set([
  ".auto", ".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build", "coverage", ".next", ".turbo",
]);

function objectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value).replace(/[,_]/g, ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function inferAutoresearchConfigFromPrompt(prompt) {
  const text = String(prompt)
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

  const inferred = {};
  const resumeMatch = text.match(
    /\b(?:for|after|limit(?:ed)?(?: to)?|stop after|only)?\s*(\d[\d,_]*)\s*(?:auto[- ]?resumes?|auto[- ]?resume turns?|resume turns?)\b/,
  );
  if (resumeMatch) inferred.maxAutoResumeTurns = parsePositiveInteger(resumeMatch[1]);

  const runMatch = text.match(
    /\b(?:for|after|limit(?:ed)?(?: to)?|stop after|only)\s+(\d[\d,_]*)\s+(?:runs?|iterations?|experiments?)\b/,
  );
  const chineseRunMatch = text.match(/(?:做|运行|执行|最多|限制|迭代)\s*(\d+)\s*(?:次|轮|个实验)/);
  const runCount = parsePositiveInteger(runMatch?.[1] ?? chineseRunMatch?.[1] ?? "");
  if (runCount !== null) {
    inferred.maxIterations = runCount;
    if (inferred.maxAutoResumeTurns === undefined) inferred.maxAutoResumeTurns = runCount;
  }

  const unlimited =
    /\b(?:run|continue|resume|loop)\s+(?:indefinitely|infinite(?:ly)?|forever|without stopping)\b/.test(text) ||
    /\b(?:indefinitely|forever)\s+(?:run|continue|resume|loop)\b/.test(text) ||
    /\bunlimited\s+auto[- ]?resume\b/.test(text) ||
    /\b(?:no|without)\s+(?:auto[- ]?resume\s+)?limits?\b/.test(text) ||
    /\bnever\s+stopp?ing?\b/.test(text) ||
    /\bdon'?t\s+stop\b/.test(text) ||
    /(?:无限|一直|不停)(?:运行|继续|迭代)|(?:运行|继续|迭代)(?:到永远|不停)/.test(text);
  if (unlimited) {
    inferred.maxAutoResumeTurns = null;
    if (inferred.maxIterations === undefined) inferred.clearMaxIterations = true;
  }

  return Object.keys(inferred).length > 0 ? inferred : null;
}

function readJson(filePath, fallback = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return objectRecord(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value, mode = 0o600) {
  ensureParentDir(filePath);
  const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tempPath, filePath);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function runGit(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const reason = result.error?.message || `${result.stdout || ""}${result.stderr || ""}`.trim();
    throw new Error(`git ${args[0]} failed: ${reason || `exit ${result.status}`}`);
  }
  return result;
}

function normalizeProtectedPaths(workDir, candidates) {
  if (!Array.isArray(candidates)) return [];
  const normalized = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const absolute = path.resolve(workDir, candidate);
    const relative = path.relative(workDir, absolute);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) continue;
    const portable = relative.split(path.sep).join("/");
    if (portable === ".git" || portable.startsWith(".git/")) continue;
    if (portable === ".auto" || portable.startsWith(".auto/")) continue;
    if (portable === "autoresearch.md" || portable.startsWith("autoresearch.")) continue;
    normalized.push(portable);
  }
  return [...new Set(normalized)];
}

function gitPathspecs(paths) {
  return paths.map((value) => `:(literal)${value}`);
}

/**
 * Pick a bounded beginner-friendly starting scope. Small projects are covered
 * automatically. In an umbrella workspace we retain only root files and learn
 * nested files lazily from pre-execute hooks, so startup never scans everything.
 */
function discoverInitialProtectedPaths(workDir) {
  const rootFiles = [];
  const discovered = [];
  const queue = [workDir];
  let directoryCount = 0;
  let totalBytes = 0;
  let overflowed = false;
  while (queue.length && !overflowed) {
    const directory = queue.shift();
    directoryCount += 1;
    if (directoryCount > INITIAL_SCOPE_MAX_DIRS) {
      overflowed = true;
      break;
    }
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === ".DS_Store") continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(workDir, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (!INITIAL_SCOPE_IGNORED_DIRS.has(entry.name)) queue.push(absolute);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      let size = 0;
      try { size = entry.isFile() ? fs.lstatSync(absolute).size : 0; } catch { continue; }
      if (size > INITIAL_SCOPE_MAX_BYTES) {
        overflowed = true;
        break;
      }
      if (directory === workDir) rootFiles.push(relative);
      discovered.push(relative);
      totalBytes += size;
      if (discovered.length > INITIAL_SCOPE_MAX_FILES || totalBytes > INITIAL_SCOPE_MAX_BYTES) {
        overflowed = true;
        break;
      }
    }
  }
  return overflowed ? rootFiles.slice(0, INITIAL_SCOPE_MAX_FILES) : discovered;
}

function trimTail(text, maxLines, maxBytes) {
  const source = String(text);
  const sourceBytes = Buffer.byteLength(source);
  const lines = source.split(/\r?\n/);
  let selected = lines.slice(-maxLines).join("\n");
  let truncatedBy = lines.length > maxLines ? "lines" : null;
  if (Buffer.byteLength(selected) > maxBytes) {
    const buffer = Buffer.from(selected);
    let tail = buffer.subarray(buffer.length - maxBytes);
    const newline = tail.indexOf(0x0a);
    if (newline >= 0) tail = tail.subarray(newline + 1);
    selected = tail.toString("utf8");
    truncatedBy = "bytes";
  }
  return {
    content: selected,
    truncated: sourceBytes > Buffer.byteLength(selected),
    truncatedBy,
    totalLines: lines.length,
    outputLines: selected.split(/\r?\n/).length,
  };
}

function killTree(pid, signal = "SIGTERM") {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process has already exited.
    }
  }
}

function parseMetricLine(line, metrics) {
  const match = /^METRIC\s+([\w.µ]+)=(\S+)\s*$/.exec(line.trim());
  if (!match || DENIED_METRIC_NAMES.has(match[1])) return;
  const value = Number(match[2]);
  if (Number.isFinite(value)) metrics.set(match[1], value);
}

async function runCommand(command, { cwd, timeoutMs, signal, tempPrefix = "dsh-autoresearch" }) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rolling = [];
    let rollingBytes = 0;
    let prefix = [];
    let prefixBytes = 0;
    let totalBytes = 0;
    let fullOutputPath = null;
    let metricCarry = "";
    const parsedMetrics = new Map();
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const add = (chunk) => {
      totalBytes += chunk.length;
      if (!fullOutputPath) {
        prefix.push(chunk);
        prefixBytes += chunk.length;
        if (prefixBytes > FULL_OUTPUT_THRESHOLD) {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${tempPrefix}-`));
          fullOutputPath = path.join(dir, "output.log");
          fs.writeFileSync(fullOutputPath, Buffer.concat(prefix));
          prefix = [];
          prefixBytes = 0;
        }
      } else {
        fs.appendFileSync(fullOutputPath, chunk);
      }

      rolling.push(chunk);
      rollingBytes += chunk.length;
      while (rollingBytes > DISPLAY_MAX_BYTES * 2 && rolling.length > 1) {
        rollingBytes -= rolling.shift().length;
      }

      metricCarry += chunk.toString("utf8");
      const metricLines = metricCarry.split(/\r?\n/);
      metricCarry = metricLines.pop() ?? "";
      for (const line of metricLines) parseMetricLine(line, parsedMetrics);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);

    const timeout = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
      setTimeout(() => child.pid && killTree(child.pid, "SIGKILL"), 2_000).unref();
    }, timeoutMs) : null;

    const onAbort = () => {
      aborted = true;
      if (child.pid) killTree(child.pid);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      parseMetricLine(metricCarry, parsedMetrics);
      if (aborted) {
        reject(new Error("Experiment aborted"));
        return;
      }
      const output = fullOutputPath
        ? Buffer.concat(rolling).toString("utf8")
        : Buffer.concat(prefix).toString("utf8");
      resolve({
        exitCode,
        timedOut,
        output,
        totalBytes,
        fullOutputPath,
        parsedMetrics,
        durationSeconds: (Date.now() - startedAt) / 1000,
      });
    });
  });
}

function isBenchmarkCommand(command) {
  let core = String(command).trim().replace(/^(?:\w+=\S*\s+)+/, "");
  let previous;
  do {
    previous = core;
    core = core.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/, "");
  } while (core !== previous);
  return /^(?:(?:bash|sh|source)\s+(?:-\w+\s+)*)?(?:\/|\.{1,2}\/|[\w.-]+\/)*(?:autoresearch\.sh|\.auto\/measure\.sh)(?:\s|$)/.test(core);
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function confidenceFor(results, segment, direction) {
  const current = results.filter((run) => run.segment === segment && run.metric > 0);
  if (current.length < 3) return null;
  const values = current.map((run) => run.metric);
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center)));
  if (mad === 0) return null;
  const baseline = current[0]?.metric;
  const kept = current.filter((run) => run.status === "keep");
  if (!baseline || kept.length === 0) return null;
  const best = kept.reduce((value, run) => direction === "lower" ? Math.min(value, run.metric) : Math.max(value, run.metric), baseline);
  if (best === baseline) return null;
  return Math.abs(best - baseline) / mad;
}

function defaultPrivateState(cwd, workDir) {
  return {
    version: 3,
    cwd,
    workDir,
    sessionEpoch: 0,
    goal: null,
    pendingNewGoal: false,
    active: false,
    manualOff: false,
    loopState: "idle",
    completionReason: null,
    completedAt: null,
    decisionQuestion: null,
    autoResumeTurns: 0,
    pendingResumeToken: null,
    hintsThisSession: 0,
    lastRunChecks: null,
    lastRunDuration: null,
    protectedPaths: [],
    protectionMode: "pending",
    updatedAt: Date.now(),
  };
}

export function readAutoresearchConfig(cwd) {
  return readJson(sessionFilePath(cwd, "config"), {});
}

export function applyInferredAutoresearchConfig(cwd, inferred) {
  const configPath = sessionFilePath(cwd, "config");
  const config = readAutoresearchConfig(cwd);
  const notes = [];
  if (inferred.clearMaxIterations) {
    delete config.maxIterations;
    notes.push("maxIterations=unlimited");
  }
  if (inferred.maxIterations !== undefined) {
    config.maxIterations = inferred.maxIterations;
    notes.push(`maxIterations=${inferred.maxIterations}`);
  }
  if (inferred.maxAutoResumeTurns !== undefined) {
    config.maxAutoResumeTurns = inferred.maxAutoResumeTurns;
    notes.push(`maxAutoResumeTurns=${inferred.maxAutoResumeTurns === null ? "unlimited" : inferred.maxAutoResumeTurns}`);
  }
  writeJsonAtomic(configPath, config, 0o644);
  return notes;
}

export class AutoresearchController {
  cwd;
  dataDir;
  listeners;
  constructor({
    cwd = process.cwd(),
    dataDir = path.join(os.homedir(), ".dsh", "autoresearch", "state"),
  } = {}) {
    this.cwd = path.resolve(cwd);
    this.dataDir = path.resolve(dataDir);
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyChange() {
    for (const listener of this.listeners) {
      try { listener(this.snapshot()); } catch { /* ignore listener errors */ }
    }
  }

  config() {
    return readAutoresearchConfig(this.cwd);
  }

  workDir() {
    const configured = this.config().workingDir;
    return configured ? path.resolve(this.cwd, configured) : this.cwd;
  }

  protectedPaths(candidates = this.privateState().protectedPaths) {
    return normalizeProtectedPaths(this.workDir(), candidates);
  }

  protectionPathspecs(candidates = this.privateState().protectedPaths) {
    return gitPathspecs(this.protectedPaths(candidates));
  }

  snapshotRoot() {
    return `${this.statePath()}.snapshots`;
  }

  snapshotManifestPath() {
    return path.join(this.snapshotRoot(), "manifest.json");
  }

  snapshotManifest() {
    const value = readJson(this.snapshotManifestPath(), { version: 1, files: {} });
    return {
      version: 1,
      files: objectRecord(value.files) ? value.files : {},
    };
  }

  captureSnapshots(candidates, { overwrite = false } = {}) {
    const paths = this.protectedPaths(candidates);
    const manifest = this.snapshotManifest();
    const warnings = [];
    try {
      fs.mkdirSync(path.join(this.snapshotRoot(), "blobs"), { recursive: true, mode: 0o700 });
      fs.chmodSync(this.snapshotRoot(), 0o700);
    } catch {
      return { ok: false, paths, warnings: paths };
    }
    for (const portable of paths) {
      if (!overwrite && manifest.files[portable]) continue;
      const absolute = path.join(this.workDir(), ...portable.split("/"));
      let stat;
      try {
        stat = fs.lstatSync(absolute);
      } catch (error) {
        if (error?.code === "ENOENT") {
          manifest.files[portable] = { kind: "missing" };
          continue;
        }
        warnings.push(portable);
        continue;
      }
      if (stat.isSymbolicLink()) {
        try {
          manifest.files[portable] = { kind: "symlink", target: fs.readlinkSync(absolute) };
        } catch {
          warnings.push(portable);
        }
        continue;
      }
      if (!stat.isFile()) {
        warnings.push(portable);
        continue;
      }
      const blob = createHash("sha256").update(portable).digest("hex");
      try {
        const blobPath = path.join(this.snapshotRoot(), "blobs", blob);
        fs.copyFileSync(absolute, blobPath);
        fs.chmodSync(blobPath, 0o600);
        manifest.files[portable] = { kind: "file", blob, mode: stat.mode & 0o777 };
      } catch {
        warnings.push(portable);
      }
    }
    try {
      writeJsonAtomic(this.snapshotManifestPath(), manifest);
    } catch {
      return { ok: false, paths, warnings: paths };
    }
    return { ok: warnings.length === 0, paths, warnings };
  }

  restoreSnapshots(candidates = this.privateState().protectedPaths) {
    const paths = this.protectedPaths(candidates);
    const manifest = this.snapshotManifest();
    const warnings = [];
    for (const portable of paths) {
      const entry = manifest.files[portable];
      if (!objectRecord(entry)) {
        warnings.push(portable);
        continue;
      }
      const absolute = path.join(this.workDir(), ...portable.split("/"));
      let current = null;
      try { current = fs.lstatSync(absolute); } catch (error) { if (error?.code !== "ENOENT") warnings.push(portable); }
      if (current?.isDirectory()) {
        warnings.push(portable);
        continue;
      }
      try {
        if (current) fs.unlinkSync(absolute);
        if (entry.kind === "missing") continue;
        ensureParentDir(absolute);
        if (entry.kind === "symlink") {
          fs.symlinkSync(String(entry.target), absolute);
          continue;
        }
        if (entry.kind === "file") {
          const blobPath = path.join(this.snapshotRoot(), "blobs", String(entry.blob));
          fs.copyFileSync(blobPath, absolute);
          if (Number.isInteger(entry.mode)) fs.chmodSync(absolute, entry.mode);
          continue;
        }
        warnings.push(portable);
      } catch {
        warnings.push(portable);
      }
    }
    return { ok: warnings.length === 0, paths, warnings };
  }

  statePath() {
    const key = createHash("sha256")
      .update(JSON.stringify({ cwd: this.cwd, workDir: this.workDir() }))
      .digest("hex")
      .slice(0, 32);
    return path.join(this.dataDir, `${key}.json`);
  }

  privateState() {
    const defaults = defaultPrivateState(this.cwd, this.workDir());
    const stored = readJson(this.statePath(), {});
    const merged = { ...defaults, ...stored };
    if (!stored.loopState) {
      merged.loopState = merged.active ? "active" : merged.manualOff ? "stopped" : "idle";
    }
    return merged;
  }

  savePrivate(patch) {
    const next = { ...this.privateState(), ...patch, version: 3, cwd: this.cwd, workDir: this.workDir(), updatedAt: Date.now() };
    writeJsonAtomic(this.statePath(), next);
    this.notifyChange();
    return next;
  }

  resumeFor(privateState = this.privateState()) {
    const token = privateState.pendingResumeToken;
    if (!token) return { shouldSchedule: false, command: null, token: null };
    return {
      shouldSchedule: true,
      token,
      turn: privateState.autoResumeTurns,
      command: null,
    };
  }

  consumeResumeToken(token) {
    const expected = String(token || "");
    if (!expected) throw new Error("AUTORESEARCH_STALE continuation token is missing");
    const lockPath = `${this.statePath()}.${expected}.lock`;
    let lock;
    try {
      fs.mkdirSync(path.dirname(this.statePath()), { recursive: true });
      lock = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error && error.code === "EEXIST") throw new Error("AUTORESEARCH_STALE duplicate continuation token");
      throw error;
    }
    try {
      const state = this.privateState();
      if (state.active !== true || state.manualOff === true || state.pendingResumeToken !== expected) {
        throw new Error("AUTORESEARCH_STALE continuation was stopped or superseded");
      }
      const next = this.savePrivate({ pendingResumeToken: null, resumedAt: Date.now() });
      return {
        ok: true,
        text: `${CONTINUE_MARKER} turn=${next.autoResumeTurns} cwd=${JSON.stringify(next.cwd)}`,
        turn: next.autoResumeTurns,
      };
    } finally {
      try { if (lock !== undefined) fs.closeSync(lock); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }

  pendingGate(privateState = this.privateState()) {
    const resume = this.resumeFor(privateState);
    if (!resume.shouldSchedule) return null;
    return {
      ok: false,
      code: "continuation-pending",
      active: true,
      resume,
      text: [
        CONTINUATION_REQUIRED,
        "The previous experiment is durably logged. Do not edit files or start another experiment in this turn.",
        "The host will follow up this same session. End this turn. Use /autoresearch off to cancel.",
      ].join("\n"),
    };
  }

  persisted() {
    const jsonlPath = sessionFilePath(this.workDir(), "log");
    try {
      return reconstructJsonlState(fs.readFileSync(jsonlPath, "utf8"));
    } catch {
      return reconstructJsonlState("");
    }
  }

  gitSafety() {
    const workDir = this.workDir();
    let directoryOk = false;
    try { directoryOk = fs.statSync(workDir).isDirectory(); } catch {}
    if (!directoryOk) {
      return {
        ok: false,
        code: "working-dir-missing",
        workDir,
        allowNoGit: false,
        needsDecision: true,
        error: `项目目录不可用，请重新选择一个可写的项目目录：${workDir}`,
      };
    }
    const privateState = this.privateState();
    const allowNoGit = this.config().allowNoGit === true;
    if (allowNoGit || privateState.protectionMode === "snapshot") {
      return {
        ok: true,
        workDir,
        allowNoGit,
        protectionMode: "snapshot",
        protectedPaths: this.protectedPaths(),
      };
    }
    if (privateState.protectionMode === "pending") {
      return {
        ok: true,
        workDir,
        allowNoGit,
        protectionMode: "pending",
        protectedPaths: this.protectedPaths(),
      };
    }
    const result = runGit(workDir, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { allowFailure: true });
    const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
    if (result.error || result.status !== 0 || lines[0] !== "true") {
      return {
        ok: true,
        workDir,
        allowNoGit,
        protectionMode: "snapshot",
        protectedPaths: this.protectedPaths(),
      };
    }
    const head = runGit(workDir, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
    if (head.error || head.status !== 0) {
      return {
        ok: true,
        workDir,
        gitRoot: lines[1],
        allowNoGit,
        protectionMode: "snapshot",
        protectedPaths: this.protectedPaths(),
      };
    }
    return {
      ok: true,
      workDir,
      gitRoot: lines[1],
      allowNoGit,
      protectionMode: "git",
      protectedPaths: this.protectedPaths(),
    };
  }

  prepareGitSafety(proposedProtectedPaths: string[] = []) {
    const workDir = this.workDir();
    let directoryOk = false;
    try { directoryOk = fs.statSync(workDir).isDirectory(); } catch {}
    if (!directoryOk) return this.gitSafety();
    let protectedPaths = this.protectedPaths(proposedProtectedPaths);
    if (protectedPaths.length === 0) {
      const existing = this.protectedPaths();
      protectedPaths = existing.length ? existing : this.protectedPaths(discoverInitialProtectedPaths(workDir));
    }
    const captured = this.captureSnapshots(protectedPaths);
    const fallback = (reason = null) => ({
      ok: true,
      workDir,
      allowNoGit: this.config().allowNoGit === true,
      protectionMode: "snapshot",
      protectedPaths,
      protectionFallback: true,
      internalReason: reason,
      setupText: protectedPaths.length
        ? "已自动保存本地保护点；代码不会上传。"
        : "本地保护已就绪；首次修改文件前会自动保存保护点。",
    });
    if (!captured.ok) {
      return {
        ok: false,
        code: "protection-needs-confirmation",
        needsDecision: true,
        workDir,
        protectedPaths,
        error: `有 ${captured.warnings.length} 个特殊路径无法自动保护。请换到具体项目目录后重试。`,
      };
    }
    const allowNoGit = this.config().allowNoGit === true;
    if (allowNoGit) return fallback("git-disabled-by-config");

    let initialized = false;
    let probe = runGit(workDir, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { allowFailure: true });
    let lines = String(probe.stdout || "").trim().split(/\r?\n/).filter(Boolean);
    if (probe.error || probe.status !== 0 || lines[0] !== "true") {
      const created = runGit(workDir, ["init", "-q"], { allowFailure: true });
      if (created.error || created.status !== 0) {
        const reason = created.error?.message || `${created.stdout || ""}${created.stderr || ""}`.trim();
        return fallback(reason || "local-version-tool-unavailable");
      }
      initialized = true;
      probe = runGit(workDir, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { allowFailure: true });
      lines = String(probe.stdout || "").trim().split(/\r?\n/).filter(Boolean);
      if (probe.error || probe.status !== 0 || lines[0] !== "true") {
        return fallback(probe.error?.message || "local-version-probe-failed");
      }
    }

    const pathspecs = gitPathspecs(protectedPaths);
    const head = runGit(workDir, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
    if (!initialized && !head.error && head.status === 0 && pathspecs.length) {
      const unstaged = runGit(workDir, ["diff", "--quiet", "--", ...pathspecs], { allowFailure: true });
      const stagedExisting = runGit(workDir, ["diff", "--cached", "--quiet", "--", ...pathspecs], { allowFailure: true });
      const untracked = runGit(workDir, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspecs], { allowFailure: true });
      const inspectionFailed = unstaged.error || stagedExisting.error || untracked.error
        || ![0, 1].includes(unstaged.status) || ![0, 1].includes(stagedExisting.status) || untracked.status !== 0;
      if (inspectionFailed) return fallback("existing-project-inspection-failed");
      if (unstaged.status === 1 || stagedExisting.status === 1 || String(untracked.stdout || "").length > 0) {
        return fallback("existing-project-local-work-preserved");
      }
      return {
        ok: true,
        workDir,
        gitRoot: lines[1],
        allowNoGit: false,
        initialized: false,
        baselineCreated: false,
        protectionMode: "git",
        protectedPaths,
        setupText: "本地保护已就绪；代码不会上传。",
      };
    }
    if (!initialized && (head.error || head.status !== 0)) {
      return fallback("existing-project-without-baseline");
    }
    if (pathspecs.length) {
      const staged = runGit(workDir, ["add", "-A", "--", ...pathspecs], { allowFailure: true });
      if (staged.error || staged.status !== 0) {
        const reason = staged.error?.message || `${staged.stdout || ""}${staged.stderr || ""}`.trim();
        return fallback(reason || "local-baseline-stage-failed");
      }
    }
    const diff = pathspecs.length
      ? runGit(workDir, ["diff", "--cached", "--quiet", "--", ...pathspecs], { allowFailure: true })
      : { status: 0, stdout: "", stderr: "", error: null };
    if (diff.error || (diff.status !== 0 && diff.status !== 1)) {
      const reason = diff.error?.message || `${diff.stdout || ""}${diff.stderr || ""}`.trim();
      return fallback(reason || "local-baseline-inspection-failed");
    }
    const hasChanges = diff.status === 1;
    const needsBaseline = head.error || head.status !== 0 || hasChanges;
    if (!needsBaseline) {
      return {
        ok: true,
        workDir,
        gitRoot: lines[1],
        allowNoGit: false,
        initialized,
        baselineCreated: false,
        protectionMode: "git",
        protectedPaths,
        setupText: protectedPaths.length
          ? "本地保护已就绪；代码不会上传。"
          : "本地保护已就绪；首次修改文件前会自动保存保护点。",
      };
    }

    const identity = [
      ["user.name", "DSH Autoresearch"],
      ["user.email", "autoresearch@local.invalid"],
    ];
    const configuredIdentity = [];
    for (const [key, fallbackValue] of identity) {
      const existing = runGit(workDir, ["config", "--get", key], { allowFailure: true });
      if (existing.status === 0 && String(existing.stdout || "").trim()) continue;
      const configured = runGit(workDir, ["config", "--local", key, fallbackValue], { allowFailure: true });
      if (configured.error || configured.status !== 0) {
        const reason = configured.error?.message || `${configured.stdout || ""}${configured.stderr || ""}`.trim();
        return fallback(reason || "local-identity-setup-failed");
      }
      configuredIdentity.push(key);
    }

    const commitArgs = [
      "-c", "commit.gpgSign=false",
      "commit", "--no-verify", "-q",
      "-m", "chore: create autoresearch safety baseline",
    ];
    if (hasChanges) commitArgs.push("--", ...pathspecs);
    else commitArgs.push("--allow-empty");
    const committed = runGit(workDir, commitArgs, { allowFailure: true });
    if (committed.error || committed.status !== 0) {
      const reason = committed.error?.message || `${committed.stdout || ""}${committed.stderr || ""}`.trim();
      return fallback(reason || "local-baseline-commit-failed");
    }

    const committedHead = runGit(workDir, ["rev-parse", "--short=7", "HEAD"], { allowFailure: true });
    if (committedHead.error || committedHead.status !== 0) return fallback("local-baseline-head-failed");
    const commit = String(committedHead.stdout || "").trim();
    return {
      ok: true,
      workDir,
      gitRoot: lines[1],
      allowNoGit: false,
      initialized,
      baselineCreated: true,
      protectionMode: "git",
      protectedPaths,
      configuredIdentity,
      commit,
      setupText: "已自动保存本地保护点；代码不会上传。",
    };
  }

  protectPathsBeforeMutation(candidates: string[] = []) {
    const current = this.privateState();
    if (current.active !== true || current.manualOff === true) {
      return { ok: true, active: false, protectedPaths: this.protectedPaths() };
    }
    const incoming = this.protectedPaths(candidates);
    const known = new Set(this.protectedPaths(current.protectedPaths));
    const added = incoming.filter((portable) => !known.has(portable));
    if (added.length === 0) return { ok: true, active: true, protectedPaths: [...known] };

    const captured = this.captureSnapshots(added);
    if (!captured.ok) {
      return {
        ok: false,
        needsDecision: true,
        code: "protection-needs-confirmation",
        text: `这个修改包含无法自动保护的特殊路径：${captured.warnings.join(", ")}`,
      };
    }
    let protectionMode = current.protectionMode === "git" ? "git" : "snapshot";
    if (protectionMode === "git") {
      const prepared = this.prepareGitSafety(added);
      protectionMode = prepared.protectionMode === "git" ? "git" : "snapshot";
    }
    const protectedPaths = [...known, ...added];
    this.savePrivate({ protectedPaths, protectionMode });
    return { ok: true, active: true, protectedPaths, protectionMode };
  }

  async fireHook(event, extra) {
    const persisted = this.persisted();
    const current = persisted.results.filter((run) => run.segment === persisted.currentSegment);
    const kept = current.filter((run) => run.status === "keep");
    const baseline = current[0]?.metric ?? null;
    const best = kept.length === 0 ? null : kept.reduce((value, run) => {
      return persisted.bestDirection === "lower" ? Math.min(value, run.metric) : Math.max(value, run.metric);
    }, kept[0].metric);
    const payload = {
      event,
      cwd: this.workDir(),
      ...extra,
      session: {
        metric_name: persisted.metricName,
        metric_unit: persisted.metricUnit,
        direction: persisted.bestDirection,
        baseline_metric: baseline,
        best_metric: best,
        run_count: current.length,
        goal: typeof extra?.goal === "string" ? extra.goal : persisted.name ?? "",
      },
    };
    const result = await runHook(payload);
    appendHookLogEntryIfConfigured(sessionFilePath(this.workDir(), "log"), event, result);
    return { result, steer: steerMessageFor(event, result) };
  }

  async finish({ outcome = "complete", reason = "", user_question = "" } = {}) {
    const privateState = this.privateState();
    if (!privateState.active && privateState.loopState !== "awaiting_user") {
      return { ok: false, active: false, text: "Autoresearch is not active." };
    }
    if (!["complete", "needs_user"].includes(outcome)) {
      return { ok: false, active: privateState.active, text: "outcome must be complete or needs_user." };
    }
    const decisionReason = String(reason).trim();
    if (!decisionReason) return { ok: false, active: privateState.active, text: "reason is required." };
    const persisted = this.persisted();
    const current = persisted.results.filter((run) => run.segment === persisted.currentSegment);
    if (outcome === "complete" && !current.some((run) => run.status === "keep")) {
      return { ok: false, active: privateState.active, text: "Cannot complete without a kept result in the current goal." };
    }
    const question = String(user_question).trim();
    if (outcome === "needs_user" && !question) {
      return { ok: false, active: privateState.active, text: "user_question is required when outcome is needs_user." };
    }
    const completed = outcome === "complete";
    this.savePrivate({
      active: false,
      manualOff: false,
      loopState: completed ? "completed" : "awaiting_user",
      completionReason: decisionReason,
      completedAt: completed ? Date.now() : null,
      decisionQuestion: completed ? null : question,
      pendingResumeToken: null,
      lastRunChecks: null,
      lastRunDuration: null,
    });
    return {
      ok: true,
      active: false,
      needsDecision: !completed,
      loopState: completed ? "completed" : "awaiting_user",
      completionReason: decisionReason,
      completedAt: completed ? this.privateState().completedAt : null,
      decisionQuestion: completed ? null : question,
      text: completed
        ? `Autoresearch completed: ${decisionReason}`
        : `Autoresearch is waiting for the user: ${question}\nReason: ${decisionReason}`,
    };
  }

  async control({ args = "", protectedPaths = [] }: { args?: string; protectedPaths?: string[] } = {}) {
    let text = String(args).trim();
    const command = text.toLowerCase();
    if (!text || command === "help") {
      const status = await this.status();
      return {
        ok: true,
        ...status,
        text: [
          "Autoresearch commands:",
          "- /autoresearch <goal> - start a new goal",
          "- /autoresearch resume - resume the persisted loop",
          "- /autoresearch off - stop automatic continuation",
          "- /autoresearch clear - delete the experiment log and stop",
          "- /autoresearch export - open the larger monitor view in the official Web GUI",
          "",
          status.text,
        ].join("\n"),
      };
    }
    if (command === "status") return this.status();
    if (command === "complete" || command.startsWith("complete ")) {
      return this.finish({
        outcome: "complete",
        reason: text.slice("complete".length).trim() || "The verified goal is complete.",
      });
    }
    if (command === "off") {
      this.savePrivate({
        active: false,
        manualOff: true,
        loopState: "stopped",
        completionReason: "Stopped by the user.",
        completedAt: null,
        decisionQuestion: null,
        autoResumeTurns: 0,
        pendingResumeToken: null,
        hintsThisSession: 0,
      });
      return { ok: true, active: false, text: "Autoresearch is off. Any pending automatic continuation was cancelled." };
    }
    if (command === "clear") {
      for (const candidate of Object.values(sessionFileCandidates(this.workDir(), "log"))) {
        try { fs.unlinkSync(candidate); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      this.savePrivate({
        active: false,
        manualOff: false,
        loopState: "idle",
        completionReason: null,
        completedAt: null,
        decisionQuestion: null,
        pendingNewGoal: false,
        goal: null,
        autoResumeTurns: 0,
        pendingResumeToken: null,
        lastRunChecks: null,
        lastRunDuration: null,
        hintsThisSession: 0,
      });
      return { ok: true, active: false, text: "Autoresearch log cleared and automatic continuation stopped." };
    }
    if (command === "export") {
      const status = await this.status();
      return {
        ok: true,
        ...status,
        action: "export",
        text: "Open the Autoresearch monitor dock in the official DeepSeek Harness Web GUI. The larger overlay is optional and does not block Agent output by default.",
      };
    }
    if (command === "finalize") {
      return { ok: true, active: this.privateState().active, action: "finalize", text: "Load and follow the autoresearch-finalize support skill. Do not activate a new loop." };
    }
    if (command === "hooks") {
      return { ok: true, active: this.privateState().active, action: "hooks", text: "Load and follow the autoresearch-hooks support skill. Do not activate a new loop." };
    }

    const explicitResume = /^resume\s*$/i.test(text);
    if (/^start(?:\s|$)/i.test(text)) text = text.replace(/^start\s*/i, "").trim();
    else if (/^resume(?:\s|$)/i.test(text)) text = text.replace(/^resume\s*/i, "").trim();
    const isNewGoal = !explicitResume && text.length > 0;
    const inferred = inferAutoresearchConfigFromPrompt(text);
    const configNotes = inferred ? applyInferredAutoresearchConfig(this.cwd, inferred) : [];
    const safety = this.prepareGitSafety(protectedPaths);
    if (!safety.ok) {
      return {
        ok: true,
        active: false,
        needsDecision: true,
        action: "choose-project-folder",
        text: safety.error,
        details: safety,
      };
    }

    const previousPrivate = this.privateState();
    const beforeNeeded = !previousPrivate.active || isNewGoal;
    const previousPersisted = this.persisted();
    this.savePrivate({
      active: true,
      manualOff: false,
      loopState: "active",
      completionReason: null,
      completedAt: null,
      decisionQuestion: null,
      sessionEpoch: isNewGoal ? previousPrivate.sessionEpoch + 1 : previousPrivate.sessionEpoch,
      goal: isNewGoal ? text : previousPrivate.goal,
      pendingNewGoal: isNewGoal ? true : previousPrivate.pendingNewGoal,
      autoResumeTurns: 0,
      pendingResumeToken: null,
      hintsThisSession: 0,
      protectedPaths: safety.protectedPaths ?? this.protectedPaths(protectedPaths),
      protectionMode: safety.protectionMode ?? "snapshot",
    });
    const before = beforeNeeded ? await this.fireHook("before", {
      goal: isNewGoal ? text : previousPrivate.goal,
      next_run: isNewGoal ? 1 : previousPersisted.results.length + 1,
      last_run: isNewGoal ? null : previousPersisted.results.at(-1) ?? null,
    }) : { steer: null };
    const logPath = sessionFilePath(this.workDir(), "log");
    const hasHeader = fs.existsSync(logPath) && hasAutoresearchConfigHeader(fs.readFileSync(logPath, "utf8"));
    const hasPrompt = fs.existsSync(sessionFilePath(this.workDir(), "prompt"));
    const needsSetup = isNewGoal || this.privateState().pendingNewGoal || !hasHeader || !hasPrompt;
    return {
      ok: true,
      active: true,
      needsSetup,
      configNotes,
      warning: safety.warning ?? null,
      hookMessage: before.steer,
      text: [
        "Autoresearch is active.",
        text ? `Goal: ${text}` : "Resume the persisted goal and next hypothesis.",
        configNotes.length ? `Config: ${configNotes.join(", ")}.` : "",
        safety.setupText ?? "",
        safety.warning ?? "",
        needsSetup
          ? isNewGoal
            ? "This is a new goal. Replace .auto/prompt.md for this goal, prepare its deterministic benchmark, then call init_experiment to start a fresh segment."
            : "Setup is incomplete. Inspect the project, create .auto/prompt.md and a deterministic benchmark, then call init_experiment."
          : "Read .auto/prompt.md and the persisted log, then continue with the next experiment.",
        before.steer ? `Before hook:\n${before.steer}` : "",
      ].filter(Boolean).join("\n"),
    };
  }

  async initExperiment({ name, metric_name = "metric", metric_unit = "", direction = "lower" } = {}) {
    const privateState = this.privateState();
    if (!privateState.active || privateState.manualOff) return { ok: false, text: "Autoresearch is not active. Run /autoresearch <goal> first." };
    const pending = this.pendingGate(privateState);
    if (pending) return pending;
    const safety = this.gitSafety();
    if (!safety.ok) return { ok: false, text: safety.error, details: safety };
    if (!name || !metric_name) return { ok: false, text: "name and metric_name are required." };

    const jsonlPath = sessionFilePath(this.workDir(), "log");
    ensureParentDir(jsonlPath);
    const previous = this.persisted();
    const entry = {
      type: "config",
      name: String(name),
      metricName: String(metric_name),
      metricUnit: String(metric_unit ?? ""),
      bestDirection: direction === "higher" ? "higher" : "lower",
    };
    fs.appendFileSync(jsonlPath, `${JSON.stringify(entry)}\n`);
    this.savePrivate({
      active: true,
      manualOff: false,
      loopState: "active",
      completionReason: null,
      completedAt: null,
      decisionQuestion: null,
      pendingNewGoal: false,
      pendingResumeToken: null,
      lastRunChecks: null,
      lastRunDuration: null,
    });
    this.notifyChange();
    const before = await this.fireHook("before", {
      next_run: previous.results.length + 1,
      last_run: previous.results.at(-1) ?? null,
    });
    return {
      ok: true,
      text: [
        `Experiment initialized: ${name}${previous.results.length ? " (new segment)" : ""}.`,
        `Metric: ${metric_name} (${metric_unit || "unitless"}; ${entry.bestDirection} is better).`,
        "Run the baseline with autoresearch__run_experiment.",
        before.steer ? `Before hook:\n${before.steer}` : "",
      ].filter(Boolean).join("\n"),
      details: { state: this.persisted() },
    };
  }

  async runExperiment({ command, timeout_seconds = 600, checks_timeout_seconds = 300, signal } = {}) {
    const privateState = this.privateState();
    if (!privateState.active || privateState.manualOff) return { ok: false, text: "Autoresearch is not active." };
    const pending = this.pendingGate(privateState);
    if (pending) return pending;
    const safety = this.gitSafety();
    if (!safety.ok) return { ok: false, text: safety.error, details: safety };
    const persisted = this.persisted();
    if (!persisted.name) return { ok: false, text: "Experiment is not initialized. Call init_experiment first." };
    const config = this.config();
    const currentRuns = persisted.results.filter((run) => run.segment === persisted.currentSegment);
    if (Number.isFinite(config.maxIterations) && currentRuns.length >= Math.floor(config.maxIterations)) {
      this.savePrivate({
        active: false,
        manualOff: false,
        loopState: "stopped",
        completionReason: `Maximum experiments reached (${Math.floor(config.maxIterations)}).`,
        completedAt: null,
        decisionQuestion: null,
        pendingResumeToken: null,
      });
      return { ok: false, active: false, text: `Maximum experiments reached (${Math.floor(config.maxIterations)}).` };
    }
    if (!command) return { ok: false, text: "command is required." };
    const benchmarkPath = sessionFilePath(this.workDir(), "measure");
    if (fs.existsSync(benchmarkPath) && !isBenchmarkCommand(command)) {
      return {
        ok: false,
        text: `${path.relative(this.workDir(), benchmarkPath)} exists. Run that stable benchmark instead of a custom command.`,
        details: { command, benchmarkPath },
      };
    }

    const result = await runCommand(command, {
      cwd: this.workDir(),
      timeoutMs: Math.max(0, Number(timeout_seconds) || 0) * 1000,
      signal,
    });
    const benchmarkPassed = result.exitCode === 0 && !result.timedOut;
    let checksPass = null;
    let checksTimedOut = false;
    let checksOutput = "";
    let checksDuration = 0;
    const checksPath = sessionFilePath(this.workDir(), "checks");
    if (benchmarkPassed && fs.existsSync(checksPath)) {
      const checks = await runCommand(`bash ${shellQuote(checksPath)}`, {
        cwd: this.workDir(),
        timeoutMs: Math.max(0, Number(checks_timeout_seconds) || 0) * 1000,
        signal,
        tempPrefix: "dsh-autoresearch-checks",
      });
      checksPass = checks.exitCode === 0 && !checks.timedOut;
      checksTimedOut = checks.timedOut;
      checksOutput = trimTail(checks.output, DISPLAY_MAX_LINES, DISPLAY_MAX_BYTES).content;
      checksDuration = checks.durationSeconds;
    }
    const parsedMetrics = Object.fromEntries(result.parsedMetrics);
    const parsedPrimary = result.parsedMetrics.get(persisted.metricName) ?? null;
    const passed = benchmarkPassed && (checksPass === null || checksPass);
    const privatePatch = {
      lastRunChecks: checksPass === null ? null : { pass: checksPass, output: checksOutput, duration: checksDuration },
      lastRunDuration: result.durationSeconds,
      pendingResumeToken: null,
    };
    this.savePrivate(privatePatch);

    const llmTail = trimTail(result.output, EXPERIMENT_MAX_LINES, EXPERIMENT_MAX_BYTES);
    const displayTail = trimTail(result.output, DISPLAY_MAX_LINES, DISPLAY_MAX_BYTES);
    const details = {
      command,
      exitCode: result.exitCode,
      durationSeconds: result.durationSeconds,
      passed,
      crashed: !passed,
      timedOut: result.timedOut,
      tailOutput: displayTail.content,
      checksPass,
      checksTimedOut,
      checksOutput,
      checksDuration,
      parsedMetrics,
      parsedPrimary,
      metricName: persisted.metricName,
      metricUnit: persisted.metricUnit,
      fullOutputPath: result.fullOutputPath,
      truncation: llmTail.truncated ? llmTail : undefined,
    };
    const summary = result.timedOut
      ? `TIMEOUT after ${result.durationSeconds.toFixed(1)}s`
      : benchmarkPassed ? `Benchmark passed in ${result.durationSeconds.toFixed(1)}s` : `Benchmark failed (exit ${result.exitCode}) in ${result.durationSeconds.toFixed(1)}s`;
    return {
      ok: true,
      text: [
        summary,
        checksPass === true ? `Checks passed in ${checksDuration.toFixed(1)}s.` : "",
        checksPass === false ? `Checks failed in ${checksDuration.toFixed(1)}s. Log status checks_failed.` : "",
        Object.keys(parsedMetrics).length ? `Parsed METRIC values: ${JSON.stringify(parsedMetrics)}` : "",
        llmTail.content,
        llmTail.truncated && result.fullOutputPath ? `Full output: ${result.fullOutputPath}` : "",
        "Always call autoresearch_log_experiment for this run.",
      ].filter(Boolean).join("\n"),
      details,
    };
  }

  async logExperiment({
    commit = "",
    metric,
    metrics = {},
    status,
    description = "",
    asi,
    force = false,
    next_action,
    decision_reason = "",
    user_question = "",
  } = {}) {
    const privateState = this.privateState();
    if (!privateState.active || privateState.manualOff) return { ok: false, text: "Autoresearch is not active." };
    const pending = this.pendingGate(privateState);
    if (pending) return pending;
    const safety = this.gitSafety();
    if (!safety.ok) return { ok: false, text: safety.error, details: safety };
    if (!Number.isFinite(metric)) return { ok: false, text: "metric must be a finite number." };
    if (!["keep", "discard", "crash", "checks_failed"].includes(status)) {
      return { ok: false, text: "status must be keep, discard, crash, or checks_failed." };
    }
    if (!objectRecord(metrics) || Object.values(metrics).some((value) => !Number.isFinite(value))) {
      return { ok: false, text: "metrics must contain only finite numbers." };
    }
    if (!["continue", "complete", "needs_user"].includes(next_action)) {
      return { ok: false, text: "next_action must be continue, complete, or needs_user." };
    }
    const decisionReason = String(decision_reason).trim();
    if (!decisionReason) return { ok: false, text: "decision_reason is required." };
    const userQuestion = String(user_question).trim();
    if (next_action === "needs_user" && !userQuestion) {
      return { ok: false, text: "user_question is required when next_action is needs_user." };
    }
    if (status === "keep" && privateState.lastRunChecks && !privateState.lastRunChecks.pass) {
      return { ok: false, text: `Cannot keep because .auto/checks.sh failed. Log checks_failed instead.\n${String(privateState.lastRunChecks.output).slice(-500)}` };
    }

    const persisted = this.persisted();
    if (!persisted.name) return { ok: false, text: "Experiment is not initialized." };
    const secondaryMetrics = { ...metrics };
    delete secondaryMetrics[persisted.metricName];
    const known = new Set(persisted.secondaryMetrics.map((entry) => entry.name));
    const provided = new Set(Object.keys(secondaryMetrics));
    const missing = [...known].filter((name) => !provided.has(name));
    if (missing.length) return { ok: false, text: `Missing secondary metrics: ${missing.join(", ")}.` };
    const added = [...provided].filter((name) => !known.has(name));
    if (persisted.results.length && added.length && !force) {
      return { ok: false, text: `New secondary metrics require force=true: ${added.join(", ")}.` };
    }

    let resolvedCommit = String(commit).slice(0, 7);
    let gitText = "";
    const pathspecs = this.protectionPathspecs();
    let protectionMode = safety.protectionMode === "git" && privateState.protectionMode === "git" ? "git" : "snapshot";
    if (status === "keep" && protectionMode === "git" && pathspecs.length) {
      const staged = runGit(this.workDir(), ["add", "-A", "--", ...pathspecs], { allowFailure: true });
      const diff = staged.error || staged.status !== 0
        ? staged
        : runGit(this.workDir(), ["diff", "--cached", "--quiet", "--", ...pathspecs], { allowFailure: true });
      if (!diff.error && diff.status === 0) {
        gitText = "本轮没有需要保存的代码变化。";
      } else if (!diff.error && diff.status === 1) {
        const resultData = { status, [persisted.metricName || "metric"]: metric, ...secondaryMetrics };
        const committed = runGit(this.workDir(), [
          "-c", "commit.gpgSign=false",
          "commit", "--no-verify", "-q",
          "-m", `${description}\n\nResult: ${JSON.stringify(resultData)}`,
          "--", ...pathspecs,
        ], { allowFailure: true });
        if (!committed.error && committed.status === 0) {
          const head = runGit(this.workDir(), ["rev-parse", "--short=7", "HEAD"], { allowFailure: true });
          if (!head.error && head.status === 0) resolvedCommit = String(head.stdout || "").trim();
          gitText = "已保存本轮改进。";
        } else {
          protectionMode = "snapshot";
          runGit(this.workDir(), ["reset", "-q", "HEAD", "--", ...pathspecs], { allowFailure: true });
        }
      } else {
        protectionMode = "snapshot";
        runGit(this.workDir(), ["reset", "-q", "HEAD", "--", ...pathspecs], { allowFailure: true });
      }
    }
    if (status === "keep") {
      const refreshed = this.captureSnapshots(this.protectedPaths(), { overwrite: true });
      if (!refreshed.ok) {
        protectionMode = "snapshot";
        gitText = `本轮已保留，但有 ${refreshed.warnings.length} 个特殊路径需要稍后确认。`;
      } else if (!gitText) {
        gitText = this.protectedPaths().length
          ? "已保存本轮改进。"
          : "本轮尚未改动源码，已继续运行。";
      }
      if (protectionMode !== privateState.protectionMode) this.savePrivate({ protectionMode });
    }

    const currentSegmentRuns = persisted.results.filter((run) => run.segment === persisted.currentSegment);
    if (next_action === "complete" && status !== "keep" && !currentSegmentRuns.some((run) => run.status === "keep")) {
      return { ok: false, text: "Cannot complete without a kept result in the current goal." };
    }
    const provisional = {
      run: persisted.results.length + 1,
      commit: resolvedCommit,
      metric,
      metrics: secondaryMetrics,
      status,
      description: String(description),
      timestamp: Date.now(),
      segment: persisted.currentSegment,
      confidence: null,
      ...(objectRecord(asi) && Object.keys(asi).length ? { asi } : {}),
    };
    provisional.confidence = confidenceFor([...persisted.results, provisional], persisted.currentSegment, persisted.bestDirection);
    const jsonlPath = sessionFilePath(this.workDir(), "log");
    ensureParentDir(jsonlPath);
    fs.appendFileSync(jsonlPath, `${JSON.stringify(provisional)}\n`);
    this.notifyChange();

    let rollbackNeedsDecision = false;
    if (status !== "keep") {
      const restored = this.restoreSnapshots();
      if (protectionMode === "git" && pathspecs.length) {
        runGit(this.workDir(), ["reset", "-q", "HEAD", "--", ...pathspecs], { allowFailure: true });
      }
      rollbackNeedsDecision = !restored.ok;
      gitText = restored.ok
        ? "已自动撤销本轮变化，实验记录已保留。"
        : `已撤销普通文件；另有 ${restored.warnings.length} 个特殊路径需要你确认。`;
    }

    const after = await this.fireHook("after", { run_entry: provisional });
    let before = { steer: null };
    const segmentCount = currentSegmentRuns.length + 1;
    const config = this.config();
    const maxIterations = Number.isFinite(config.maxIterations) && config.maxIterations > 0
      ? Math.floor(config.maxIterations)
      : null;
    const maxAutoResumeTurns = config.maxAutoResumeTurns === null || config.maxAutoResumeTurns === 0
      ? null
      : Number.isFinite(config.maxAutoResumeTurns) && config.maxAutoResumeTurns > 0
        ? Math.floor(config.maxAutoResumeTurns)
        : DEFAULT_MAX_AUTORESUME_TURNS;
    let resume = { shouldSchedule: false, command: null, token: null };
    let stopText = "";
    let needsDecision = false;
    let loopState = "active";
    if (rollbackNeedsDecision) {
      needsDecision = true;
      loopState = "awaiting_user";
      this.savePrivate({
        active: false,
        manualOff: false,
        loopState,
        completionReason: "Some protected paths need a user decision before the loop can continue.",
        completedAt: null,
        decisionQuestion: "检测到特殊路径，是否换到具体项目目录后继续？",
        pendingResumeToken: null,
        lastRunChecks: null,
        lastRunDuration: null,
      });
      stopText = "检测到特殊路径，循环已安全暂停；请确认后再继续。";
    } else if (next_action === "complete") {
      loopState = "completed";
      const finished = await this.finish({ outcome: "complete", reason: decisionReason });
      stopText = finished.text;
    } else if (next_action === "needs_user") {
      needsDecision = true;
      loopState = "awaiting_user";
      const waiting = await this.finish({
        outcome: "needs_user",
        reason: decisionReason,
        user_question: userQuestion,
      });
      stopText = waiting.text;
    } else if (maxIterations !== null && segmentCount >= maxIterations) {
      loopState = "stopped";
      this.savePrivate({
        active: false,
        manualOff: false,
        loopState,
        completionReason: `Maximum experiments reached (${maxIterations}).`,
        completedAt: null,
        decisionQuestion: null,
        pendingResumeToken: null,
        lastRunChecks: null,
        lastRunDuration: null,
      });
      stopText = `Maximum experiments reached (${maxIterations}). The loop is stopped.`;
    } else if (maxAutoResumeTurns !== null && privateState.autoResumeTurns >= maxAutoResumeTurns) {
      loopState = "stopped";
      this.savePrivate({
        active: false,
        manualOff: false,
        loopState,
        completionReason: `Automatic continuation safety limit reached (${maxAutoResumeTurns}).`,
        completedAt: null,
        decisionQuestion: null,
        pendingResumeToken: null,
        lastRunChecks: null,
        lastRunDuration: null,
      });
      stopText = `Automatic continuation safety limit reached (${maxAutoResumeTurns}). Run /autoresearch resume to continue.`;
    } else {
      before = await this.fireHook("before", {
        next_run: provisional.run + 1,
        last_run: provisional,
      });
      const token = randomBytes(18).toString("hex");
      const nextPrivate = this.savePrivate({
        active: true,
        manualOff: false,
        loopState: "active",
        completionReason: null,
        completedAt: null,
        decisionQuestion: null,
        pendingResumeToken: token,
        autoResumeTurns: privateState.autoResumeTurns + 1,
        lastRunChecks: null,
        lastRunDuration: null,
      });
      resume = this.resumeFor(nextPrivate);
    }

    return {
      ok: true,
      text: [
        resume.shouldSchedule ? CONTINUATION_REQUIRED : "",
        resume.shouldSchedule
          ? "The host will follow up this same session for the next experiment. End this turn. Do not edit, inspect, or run another experiment first."
          : "",
        `Logged #${provisional.run}: ${status} - ${description}`,
        `${persisted.metricName}: ${metric}${persisted.metricUnit}`,
        Object.keys(secondaryMetrics).length ? `Secondary: ${JSON.stringify(secondaryMetrics)}` : "",
        provisional.confidence === null ? "" : `Confidence: ${provisional.confidence.toFixed(1)}x noise floor.`,
        gitText,
        after.steer ? `After hook:\n${after.steer}` : "",
        before.steer && !stopText ? `Before hook for next run:\n${before.steer}` : "",
        stopText,
      ].filter(Boolean).join("\n"),
      details: { experiment: provisional, state: this.persisted(), wallClockSeconds: privateState.lastRunDuration },
      resume,
      needsDecision,
      loopState,
      completionReason: decisionReason,
      decisionQuestion: needsDecision ? this.privateState().decisionQuestion : null,
    };
  }

  async status() {
    const privateState = this.privateState();
    const persisted = this.persisted();
    const current = privateState.pendingNewGoal
      ? []
      : persisted.results.filter((run) => run.segment === persisted.currentSegment);
    const kept = current.filter((run) => run.status === "keep");
    const bestKeptMetric = kept.length === 0 ? null : kept.reduce((best, run) => {
      return persisted.bestDirection === "lower" ? Math.min(best, run.metric) : Math.max(best, run.metric);
    }, kept[0].metric);
    const active = privateState.active === true && privateState.manualOff !== true;
    const loopState = privateState.loopState ?? (active ? "active" : privateState.manualOff ? "stopped" : "idle");
    const resume = this.resumeFor(privateState);
    return {
      ok: true,
      active,
      manualOff: privateState.manualOff === true,
      loopState,
      completionReason: privateState.completionReason ?? null,
      completedAt: privateState.completedAt ?? null,
      decisionQuestion: privateState.decisionQuestion ?? null,
      pendingNewGoal: privateState.pendingNewGoal === true,
      sessionEpoch: privateState.sessionEpoch,
      currentSegmentRuns: current.length,
      totalRuns: persisted.results.length,
      bestKeptMetric,
      metricName: privateState.pendingNewGoal ? "metric" : persisted.metricName,
      pendingContinuation: Boolean(privateState.pendingResumeToken),
      resume,
      text: loopState === "awaiting_user"
        ? `Autoresearch is waiting for the user: ${privateState.decisionQuestion ?? privateState.completionReason ?? "A decision is required."}`
        : loopState === "completed"
          ? `Autoresearch completed: ${privateState.completionReason ?? "The verified goal is complete."}`
        : privateState.pendingNewGoal && active
        ? `Autoresearch is preparing a fresh segment for the new goal: ${privateState.goal ?? "untitled goal"}.`
        : resume.shouldSchedule
        ? [
            CONTINUATION_REQUIRED,
            "A same-session continuation is pending. End this turn; the host will follow up.",
          ].join("\n")
        : active
          ? `Autoresearch active: ${current.length} run(s), best ${persisted.metricName}: ${bestKeptMetric ?? "n/a"}.`
          : `Autoresearch inactive: ${current.length} persisted run(s).`,
      state: persisted,
    };
  }


  snapshot() {
    const privateState = this.privateState();
    const persisted = this.persisted();
    const nextSegment = persisted.results.length > 0 ? persisted.currentSegment + 1 : persisted.currentSegment;
    const currentSegment = privateState.pendingNewGoal ? nextSegment : persisted.currentSegment;
    const current = privateState.pendingNewGoal
      ? []
      : persisted.results.filter((run) => run.segment === persisted.currentSegment);
    const kept = current.filter((run) => run.status === "keep");
    const bestKeptMetric = kept.length === 0 ? null : kept.reduce((best, run) => {
      return persisted.bestDirection === "lower" ? Math.min(best, run.metric) : Math.max(best, run.metric);
    }, kept[0].metric);
    const config = this.config();
    const safety = this.gitSafety();
    const workDir = this.workDir();
    const logPath = sessionFilePath(workDir, "log");
    const hasHeader = fs.existsSync(logPath) && hasAutoresearchConfigHeader(fs.readFileSync(logPath, "utf8"));
    const hasPrompt = fs.existsSync(sessionFilePath(workDir, "prompt"));
    const maxIterations = Number.isFinite(config.maxIterations) && config.maxIterations > 0
      ? Math.floor(config.maxIterations)
      : null;
    const maxAutoResumeTurns = config.maxAutoResumeTurns === null || config.maxAutoResumeTurns === 0
      ? null
      : Number.isFinite(config.maxAutoResumeTurns) && config.maxAutoResumeTurns > 0
        ? Math.floor(config.maxAutoResumeTurns)
        : DEFAULT_MAX_AUTORESUME_TURNS;
    return {
      cwd: this.cwd,
      workDir,
      active: privateState.active === true && privateState.manualOff !== true,
      manualOff: privateState.manualOff === true,
      loopState: privateState.loopState ?? (privateState.active ? "active" : privateState.manualOff ? "stopped" : "idle"),
      completionReason: privateState.completionReason ?? null,
      completedAt: privateState.completedAt ?? null,
      decisionQuestion: privateState.decisionQuestion ?? null,
      pendingNewGoal: privateState.pendingNewGoal === true,
      needsSetup: privateState.pendingNewGoal === true || !hasHeader || !hasPrompt,
      pendingContinuation: Boolean(privateState.pendingResumeToken),
      gitOk: safety.ok === true,
      gitError: safety.error ?? null,
      allowNoGit: safety.allowNoGit === true,
      protectionMode: safety.protectionMode ?? privateState.protectionMode ?? "pending",
      protectedPathCount: this.protectedPaths().length,
      goal: privateState.goal,
      sessionEpoch: privateState.sessionEpoch,
      name: privateState.pendingNewGoal ? privateState.goal : persisted.name,
      metricName: privateState.pendingNewGoal ? "metric" : persisted.metricName,
      metricUnit: privateState.pendingNewGoal ? "" : persisted.metricUnit,
      direction: privateState.pendingNewGoal ? "lower" : persisted.bestDirection,
      maxIterations,
      maxAutoResumeTurns,
      currentSegment,
      currentSegmentRuns: current.length,
      totalRuns: persisted.results.length,
      baselineMetric: current[0]?.metric ?? null,
      bestKeptMetric,
      lastStatus: current.at(-1)?.status ?? null,
      results: persisted.results,
      promptExists: hasPrompt,
      measureExists: fs.existsSync(sessionFilePath(workDir, "measure")),
      checksExists: fs.existsSync(sessionFilePath(workDir, "checks")),
      updatedAt: privateState.updatedAt,
    };
  }

  async askHint() {
    return { ok: false, text: "Hints are disabled in dsh-autoresearch by default." };
  }

  async close() {
    this.listeners.clear();
  }
}
