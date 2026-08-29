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
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15_000 });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const reason = result.error?.message || `${result.stdout || ""}${result.stderr || ""}`.trim();
    throw new Error(`git ${args[0]} failed: ${reason || `exit ${result.status}`}`);
  }
  return result;
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
    version: 1,
    cwd,
    workDir,
    active: false,
    manualOff: false,
    autoResumeTurns: 0,
    pendingResumeToken: null,
    hintsThisSession: 0,
    lastRunChecks: null,
    lastRunDuration: null,
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

  statePath() {
    const key = createHash("sha256")
      .update(JSON.stringify({ cwd: this.cwd, workDir: this.workDir() }))
      .digest("hex")
      .slice(0, 32);
    return path.join(this.dataDir, `${key}.json`);
  }

  privateState() {
    const defaults = defaultPrivateState(this.cwd, this.workDir());
    return { ...defaults, ...readJson(this.statePath(), {}) };
  }

  savePrivate(patch) {
    const next = { ...this.privateState(), ...patch, cwd: this.cwd, workDir: this.workDir(), updatedAt: Date.now() };
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
    if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
      return {
        ok: false,
        code: "working-dir-missing",
        workDir,
        allowNoGit: false,
        error: `The selected project folder does not exist or is not a directory: ${workDir}`,
      };
    }
    const allowNoGit = this.config().allowNoGit === true;
    if (allowNoGit) {
      return { ok: true, workDir, allowNoGit, warning: "allowNoGit=true: git keep/discard protection is disabled." };
    }
    const result = runGit(workDir, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { allowFailure: true });
    const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
    if (result.error || result.status !== 0 || lines[0] !== "true") {
      return {
        ok: false,
        code: "git-setup-required",
        workDir,
        allowNoGit,
        error: "Local version protection has not been set up for this project yet.",
      };
    }
    const head = runGit(workDir, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
    if (head.error || head.status !== 0) {
      return {
        ok: false,
        code: "git-baseline-required",
        workDir,
        gitRoot: lines[1],
        allowNoGit,
        error: "Local version protection needs an initial safety baseline.",
      };
    }
    return { ok: true, workDir, gitRoot: lines[1], allowNoGit };
  }

  prepareGitSafety() {
    const workDir = this.workDir();
    if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) return this.gitSafety();
    const allowNoGit = this.config().allowNoGit === true;
    if (allowNoGit) return this.gitSafety();

    let initialized = false;
    let probe = runGit(workDir, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { allowFailure: true });
    let lines = String(probe.stdout || "").trim().split(/\r?\n/).filter(Boolean);
    if (probe.error || probe.status !== 0 || lines[0] !== "true") {
      const created = runGit(workDir, ["init", "-q"], { allowFailure: true });
      if (created.error || created.status !== 0) {
        const reason = created.error?.message || `${created.stdout || ""}${created.stderr || ""}`.trim();
        return {
          ok: false,
          code: "git-setup-failed",
          workDir,
          allowNoGit: false,
          error: `Could not enable local version protection automatically. Check that Git is installed and this folder is writable, then retry.${reason ? ` (${reason})` : ""}`,
        };
      }
      initialized = true;
      probe = runGit(workDir, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"], { allowFailure: true });
      lines = String(probe.stdout || "").trim().split(/\r?\n/).filter(Boolean);
    }

    const head = runGit(workDir, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
    const status = runGit(workDir, ["status", "--porcelain=v1", "--untracked-files=all", "--", "."], { allowFailure: true });
    if (status.error || status.status !== 0) {
      const reason = status.error?.message || `${status.stdout || ""}${status.stderr || ""}`.trim();
      return {
        ok: false,
        code: "git-setup-failed",
        workDir,
        allowNoGit: false,
        error: `Could not inspect the project for local version protection.${reason ? ` (${reason})` : ""}`,
      };
    }
    const needsBaseline = head.error || head.status !== 0 || String(status.stdout || "").trim().length > 0;
    if (!needsBaseline) {
      return { ok: true, workDir, gitRoot: lines[1], allowNoGit: false, initialized, baselineCreated: false };
    }

    const identity = [
      ["user.name", "DSH Autoresearch"],
      ["user.email", "autoresearch@local.invalid"],
    ];
    const configuredIdentity = [];
    for (const [key, fallback] of identity) {
      const existing = runGit(workDir, ["config", "--get", key], { allowFailure: true });
      if (existing.status === 0 && String(existing.stdout || "").trim()) continue;
      const configured = runGit(workDir, ["config", "--local", key, fallback], { allowFailure: true });
      if (configured.error || configured.status !== 0) {
        const reason = configured.error?.message || `${configured.stdout || ""}${configured.stderr || ""}`.trim();
        return {
          ok: false,
          code: "git-identity-setup-failed",
          workDir,
          allowNoGit: false,
          error: `Could not configure a local-only Git identity for Autoresearch.${reason ? ` (${reason})` : ""}`,
        };
      }
      configuredIdentity.push(key);
    }

    const hasChanges = String(status.stdout || "").trim().length > 0;
    if (hasChanges) {
      const staged = runGit(workDir, ["add", "-A", "--", "."], { allowFailure: true });
      if (staged.error || staged.status !== 0) {
        const reason = staged.error?.message || `${staged.stdout || ""}${staged.stderr || ""}`.trim();
        return {
          ok: false,
          code: "git-baseline-failed",
          workDir,
          allowNoGit: false,
          error: `Could not save the project's local safety baseline.${reason ? ` (${reason})` : ""}`,
        };
      }
    }

    const commitArgs = [
      "-c", "commit.gpgSign=false",
      "commit", "--no-verify", "-q",
      "-m", "chore: create autoresearch safety baseline",
    ];
    if (hasChanges) commitArgs.push("--", ".");
    else commitArgs.push("--allow-empty");
    const committed = runGit(workDir, commitArgs, { allowFailure: true });
    if (committed.error || committed.status !== 0) {
      const reason = committed.error?.message || `${committed.stdout || ""}${committed.stderr || ""}`.trim();
      return {
        ok: false,
        code: "git-baseline-failed",
        workDir,
        allowNoGit: false,
        error: `Could not save the project's local safety baseline.${reason ? ` (${reason})` : ""}`,
      };
    }

    const commit = String(runGit(workDir, ["rev-parse", "--short=7", "HEAD"]).stdout).trim();
    return {
      ok: true,
      workDir,
      gitRoot: lines[1],
      allowNoGit: false,
      initialized,
      baselineCreated: true,
      configuredIdentity,
      commit,
      setupText: `Git: local Git safety baseline created (${commit}); nothing was uploaded.`,
    };
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
        goal: persisted.name ?? "",
      },
    };
    const result = await runHook(payload);
    appendHookLogEntryIfConfigured(sessionFilePath(this.workDir(), "log"), event, result);
    return { result, steer: steerMessageFor(event, result) };
  }

  async control({ args = "" } = {}) {
    let text = String(args).trim();
    const command = text.toLowerCase();
    if (!text || command === "help") {
      const status = await this.status();
      return {
        ok: true,
        ...status,
        text: [
          "Autoresearch commands:",
          "- /autoresearch <goal> - start or update a loop",
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
    if (command === "off") {
      this.savePrivate({ active: false, manualOff: true, autoResumeTurns: 0, pendingResumeToken: null, hintsThisSession: 0 });
      return { ok: true, active: false, text: "Autoresearch is off. Any pending automatic continuation was cancelled." };
    }
    if (command === "clear") {
      for (const candidate of Object.values(sessionFileCandidates(this.workDir(), "log"))) {
        try { fs.unlinkSync(candidate); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      this.savePrivate({ active: false, manualOff: false, autoResumeTurns: 0, pendingResumeToken: null, lastRunChecks: null, lastRunDuration: null, hintsThisSession: 0 });
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

    if (/^(start|resume)(?:\s|$)/i.test(text)) text = text.replace(/^(start|resume)\s*/i, "").trim();
    const inferred = inferAutoresearchConfigFromPrompt(text);
    const configNotes = inferred ? applyInferredAutoresearchConfig(this.cwd, inferred) : [];
    const safety = this.prepareGitSafety();
    if (!safety.ok) return { ok: false, active: false, text: safety.error, details: safety };

    const before = this.privateState().active ? { steer: null } : await this.fireHook("before", {
      next_run: this.persisted().results.length + 1,
      last_run: this.persisted().results.at(-1) ?? null,
    });
    this.savePrivate({ active: true, manualOff: false, autoResumeTurns: 0, pendingResumeToken: null, hintsThisSession: 0 });
    const logPath = sessionFilePath(this.workDir(), "log");
    const hasHeader = fs.existsSync(logPath) && hasAutoresearchConfigHeader(fs.readFileSync(logPath, "utf8"));
    const hasPrompt = fs.existsSync(sessionFilePath(this.workDir(), "prompt"));
    const needsSetup = !hasHeader || !hasPrompt;
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
          ? "Setup is incomplete. Inspect the project, create .auto/prompt.md and a deterministic benchmark, then call init_experiment."
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
    this.savePrivate({ active: true, manualOff: false, pendingResumeToken: null, lastRunChecks: null, lastRunDuration: null });
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
      this.savePrivate({ active: false, pendingResumeToken: null });
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

  async logExperiment({ commit = "", metric, metrics = {}, status, description = "", asi, force = false } = {}) {
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
    if (!safety.allowNoGit && status === "keep") {
      runGit(this.workDir(), ["add", "-A", "--", "."]);
      const diff = runGit(this.workDir(), ["diff", "--cached", "--quiet", "--", "."], { allowFailure: true });
      if (diff.status === 0) {
        gitText = "Git: nothing to commit.";
      } else {
        const resultData = { status, [persisted.metricName || "metric"]: metric, ...secondaryMetrics };
        runGit(this.workDir(), ["commit", "-m", `${description}\n\nResult: ${JSON.stringify(resultData)}`, "--", "."]);
        resolvedCommit = String(runGit(this.workDir(), ["rev-parse", "--short=7", "HEAD"]).stdout).trim();
        gitText = `Git: committed ${resolvedCommit}.`;
      }
    } else if (safety.allowNoGit) {
      gitText = "Git protection disabled by allowNoGit=true.";
    }

    const currentSegmentRuns = persisted.results.filter((run) => run.segment === persisted.currentSegment);
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

    if (!safety.allowNoGit && status !== "keep") {
      runGit(this.workDir(), [
        "checkout", "--", ".",
        ":(exclude,glob)**/.auto", ":(exclude,glob)**/.auto/**",
        ":(exclude,glob)**/autoresearch.*", ":(exclude,glob)**/autoresearch.*/**",
      ]);
      runGit(this.workDir(), [
        "clean", "-fd", "-e", ".auto", "-e", "**/.auto/**", "-e", "autoresearch.*", "-e", "**/autoresearch.*/**",
      ]);
      gitText = `Git: reverted ${status} changes; autoresearch artifacts were preserved.`;
    }

    const after = await this.fireHook("after", { run_entry: provisional });
    const before = await this.fireHook("before", {
      next_run: provisional.run + 1,
      last_run: provisional,
    });
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
    if (maxIterations !== null && segmentCount >= maxIterations) {
      this.savePrivate({ active: false, pendingResumeToken: null, lastRunChecks: null, lastRunDuration: null });
      stopText = `Maximum experiments reached (${maxIterations}). The loop is stopped.`;
    } else if (maxAutoResumeTurns !== null && privateState.autoResumeTurns >= maxAutoResumeTurns) {
      this.savePrivate({ active: false, pendingResumeToken: null, lastRunChecks: null, lastRunDuration: null });
      stopText = `Automatic continuation safety limit reached (${maxAutoResumeTurns}). Run /autoresearch resume to continue.`;
    } else {
      const token = randomBytes(18).toString("hex");
      const nextPrivate = this.savePrivate({
        active: true,
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
    };
  }

  async status() {
    const privateState = this.privateState();
    const persisted = this.persisted();
    const current = persisted.results.filter((run) => run.segment === persisted.currentSegment);
    const kept = current.filter((run) => run.status === "keep");
    const bestKeptMetric = kept.length === 0 ? null : kept.reduce((best, run) => {
      return persisted.bestDirection === "lower" ? Math.min(best, run.metric) : Math.max(best, run.metric);
    }, kept[0].metric);
    const active = privateState.active === true && privateState.manualOff !== true;
    const resume = this.resumeFor(privateState);
    return {
      ok: true,
      active,
      manualOff: privateState.manualOff === true,
      currentSegmentRuns: current.length,
      totalRuns: persisted.results.length,
      bestKeptMetric,
      metricName: persisted.metricName,
      pendingContinuation: Boolean(privateState.pendingResumeToken),
      resume,
      text: resume.shouldSchedule
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
    const current = persisted.results.filter((run) => run.segment === persisted.currentSegment);
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
      needsSetup: !hasHeader || !hasPrompt,
      pendingContinuation: Boolean(privateState.pendingResumeToken),
      gitOk: safety.ok === true,
      gitError: safety.error ?? null,
      allowNoGit: safety.allowNoGit === true,
      name: persisted.name,
      metricName: persisted.metricName,
      metricUnit: persisted.metricUnit,
      direction: persisted.bestDirection,
      maxIterations,
      maxAutoResumeTurns,
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
