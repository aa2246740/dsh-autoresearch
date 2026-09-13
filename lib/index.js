import fs, { readFileSync, writeFileSync } from "node:fs";
import path, { dirname, join } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";
//#region lib/types/jsonl.js
function isObjectRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function inferMetricUnit(name) {
	if (name.endsWith("µs")) return "µs";
	if (name.endsWith("_ms")) return "ms";
	if (name.endsWith("_s") || name.endsWith("_sec")) return "s";
	if (name.endsWith("_kb")) return "kb";
	if (name.endsWith("_mb")) return "mb";
	return "";
}
function metricMapFrom(value) {
	if (!isObjectRecord(value)) return {};
	return Object.fromEntries(Object.entries(value).filter(([, metric]) => typeof metric === "number" && Number.isFinite(metric)));
}
function statusFrom(value) {
	return value === "discard" || value === "crash" || value === "checks_failed" ? value : "keep";
}
function freshState() {
	return {
		name: null,
		metricName: "metric",
		metricUnit: "",
		bestDirection: "lower",
		currentSegment: 0,
		results: [],
		secondaryMetrics: []
	};
}
function parseJsonlEntry(line) {
	try {
		const parsed = JSON.parse(line);
		return isObjectRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
function isAutoresearchConfigEntry(entry) {
	return isObjectRecord(entry) && entry.type === "config";
}
function isAutoresearchRunEntry(entry) {
	return isObjectRecord(entry) && typeof entry.run === "number";
}
function entries(jsonlContent) {
	return String(jsonlContent).split("\n").filter(Boolean).map(parseJsonlEntry).filter((entry) => entry !== null);
}
function hasAutoresearchConfigHeader(jsonlContent) {
	return entries(jsonlContent).some(isAutoresearchConfigEntry);
}
function reconstructJsonlState(jsonlContent) {
	const state = freshState();
	let segment = 0;
	for (const entry of entries(jsonlContent)) {
		if (isAutoresearchConfigEntry(entry)) {
			if (state.results.length > 0) {
				segment += 1;
				state.secondaryMetrics = [];
			}
			if (typeof entry.name === "string") state.name = entry.name;
			if (typeof entry.metricName === "string") state.metricName = entry.metricName;
			if (typeof entry.metricUnit === "string") state.metricUnit = entry.metricUnit;
			state.bestDirection = entry.bestDirection === "higher" ? "higher" : "lower";
			state.currentSegment = segment;
			continue;
		}
		if (!isAutoresearchRunEntry(entry)) continue;
		const metrics = metricMapFrom(entry.metrics);
		const run = {
			run: entry.run,
			commit: typeof entry.commit === "string" ? entry.commit : "",
			metric: typeof entry.metric === "number" ? entry.metric : 0,
			metrics,
			status: statusFrom(entry.status),
			description: typeof entry.description === "string" ? entry.description : "",
			timestamp: typeof entry.timestamp === "number" ? entry.timestamp : 0,
			segment,
			confidence: typeof entry.confidence === "number" ? entry.confidence : null,
			...isObjectRecord(entry.asi) ? { asi: entry.asi } : {}
		};
		state.results.push(run);
		for (const name of Object.keys(metrics)) {
			if (name === state.metricName) continue;
			if (!state.secondaryMetrics.some((metric) => metric.name === name)) state.secondaryMetrics.push({
				name,
				unit: inferMetricUnit(name)
			});
		}
	}
	return state;
}
//#endregion
//#region lib/types/paths.js
const AUTO_DIR = ".auto";
const CURRENT_HOOKS_DIR = "hooks";
const LEGACY_HOOKS_DIR = "autoresearch.hooks";
const SESSION_FILE_NAMES = {
	log: {
		current: "log.jsonl",
		legacy: "autoresearch.jsonl"
	},
	prompt: {
		current: "prompt.md",
		legacy: "autoresearch.md"
	},
	ideas: {
		current: "ideas.md",
		legacy: "autoresearch.ideas.md"
	},
	checks: {
		current: "checks.sh",
		legacy: "autoresearch.checks.sh"
	},
	measure: {
		current: "measure.sh",
		legacy: "autoresearch.sh"
	},
	config: {
		current: "config.json",
		legacy: "autoresearch.config.json"
	}
};
function currentSessionPath(dir, kind) {
	return path.join(dir, AUTO_DIR, SESSION_FILE_NAMES[kind].current);
}
function legacySessionPath(dir, kind) {
	return path.join(dir, SESSION_FILE_NAMES[kind].legacy);
}
function currentLayoutExists(dir) {
	for (const kind of Object.keys(SESSION_FILE_NAMES)) if (fs.existsSync(currentSessionPath(dir, kind))) return true;
	return fs.existsSync(path.join(dir, AUTO_DIR, CURRENT_HOOKS_DIR));
}
function sessionFileCandidates(dir, kind) {
	if (!SESSION_FILE_NAMES[kind]) throw new Error(`Unknown autoresearch session file kind: ${kind}`);
	return {
		current: currentSessionPath(dir, kind),
		legacy: legacySessionPath(dir, kind)
	};
}
function sessionFilePath(dir, kind) {
	const candidates = sessionFileCandidates(dir, kind);
	if (currentLayoutExists(dir)) return candidates.current;
	return fs.existsSync(candidates.legacy) ? candidates.legacy : candidates.current;
}
function hookScriptPath(workDir, stage) {
	if (stage !== "before" && stage !== "after") throw new Error(`Unknown autoresearch hook stage: ${stage}`);
	const current = path.join(workDir, AUTO_DIR, CURRENT_HOOKS_DIR, `${stage}.sh`);
	const legacy = path.join(workDir, LEGACY_HOOKS_DIR, `${stage}.sh`);
	if (currentLayoutExists(workDir)) return current;
	return fs.existsSync(legacy) ? legacy : current;
}
function ensureParentDir(filePath) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
//#endregion
//#region lib/types/hooks.js
const HOOK_TIMEOUT_MS = 3e4;
const HOOK_STDOUT_MAX_BYTES = 8192;
const TRUNCATION_MARKER = "\n...[truncated: hook stdout exceeded 8KB]";
function executable(filePath) {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}
function truncateUtf8(buffer, maxBytes) {
	if (buffer.length <= maxBytes) return buffer;
	let kept = buffer.subarray(0, maxBytes);
	const newline = kept.lastIndexOf(10);
	if (newline >= 0) return kept.subarray(0, newline + 1);
	while (kept.length > 0 && (kept[kept.length - 1] & 192) === 128) kept = kept.subarray(0, kept.length - 1);
	if (kept.length > 0 && (kept[kept.length - 1] & 192) === 192) kept = kept.subarray(0, kept.length - 1);
	return kept;
}
async function runHook(payload, { timeoutMs = HOOK_TIMEOUT_MS } = {}) {
	const script = hookScriptPath(payload.cwd, payload.event);
	if (!executable(script)) return {
		fired: false,
		stdout: "",
		stderr: "",
		exitCode: null,
		timedOut: false,
		durationMs: 0
	};
	const startedAt = Date.now();
	return new Promise((resolve) => {
		const child = spawn("bash", [script], {
			cwd: payload.cwd,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		const stdout = [];
		const stderr = [];
		let stdoutBytes = 0;
		let truncated = false;
		let timedOut = false;
		let settled = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			if (truncated) return;
			const remaining = HOOK_STDOUT_MAX_BYTES - stdoutBytes;
			if (chunk.length <= remaining) {
				stdout.push(chunk);
				stdoutBytes += chunk.length;
			} else {
				stdout.push(truncateUtf8(chunk, Math.max(0, remaining)));
				truncated = true;
			}
		});
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		const finish = (exitCode, extraError = "") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			let out = Buffer.concat(stdout).toString("utf8");
			if (truncated) out += TRUNCATION_MARKER;
			const err = Buffer.concat(stderr).toString("utf8");
			resolve({
				fired: true,
				stdout: out,
				stderr: extraError ? [err, extraError].filter(Boolean).join("\n") : err,
				exitCode,
				timedOut,
				durationMs: Date.now() - startedAt
			});
		};
		child.on("error", (error) => finish(null, error.message));
		child.on("close", (code) => finish(code));
		child.stdin.end(JSON.stringify(payload));
	});
}
function steerMessageFor(stage, result) {
	if (!result.fired) return null;
	if (result.timedOut) return `[${stage} hook timed out after ${HOOK_TIMEOUT_MS / 1e3}s]`;
	if (result.exitCode !== 0) return [
		`[${stage} hook exited ${result.exitCode}]`,
		result.stderr.trim(),
		result.stdout.trim()
	].filter(Boolean).join("\n");
	return result.stdout.trim() || null;
}
function hookLogEntry(stage, result) {
	return {
		type: "hook",
		stage,
		exit_code: result.exitCode,
		duration_ms: result.durationMs,
		stdout_bytes: Buffer.byteLength(result.stdout, "utf8"),
		timed_out: result.timedOut
	};
}
function appendHookLogEntryIfConfigured(jsonlPath, stage, result) {
	if (!result.fired || !fs.existsSync(jsonlPath)) return false;
	try {
		if (!hasAutoresearchConfigHeader(fs.readFileSync(jsonlPath, "utf8"))) return false;
		fs.appendFileSync(jsonlPath, `${JSON.stringify(hookLogEntry(stage, result))}\n`);
		return true;
	} catch {
		return false;
	}
}
//#endregion
//#region lib/types/types.js
const CONTINUE_MARKER = "AUTORESEARCH_CONTINUE";
const CONTINUATION_REQUIRED = "AUTORESEARCH_CONTINUATION_REQUIRED";
/** Drop undefined keys and non-finite numbers so tool results pass harness JSON snapshotting. */
function toJsonValue(value) {
	return JSON.parse(JSON.stringify(value));
}
const EXPERIMENT_MAX_BYTES = 4096;
const DISPLAY_MAX_LINES = 80;
const DISPLAY_MAX_BYTES = 65536;
const FULL_OUTPUT_THRESHOLD = 65536;
const DENIED_METRIC_NAMES = /* @__PURE__ */ new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
const INITIAL_SCOPE_MAX_FILES = 256;
const INITIAL_SCOPE_MAX_BYTES = 67108864;
const INITIAL_SCOPE_MAX_DIRS = 96;
const INITIAL_SCOPE_IGNORED_DIRS = /* @__PURE__ */ new Set([
	".auto",
	".git",
	".hg",
	".svn",
	"node_modules",
	"vendor",
	"dist",
	"build",
	"coverage",
	".next",
	".turbo"
]);
function objectRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parsePositiveInteger(value) {
	const parsed = Number.parseInt(String(value).replace(/[,_]/g, ""), 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function inferAutoresearchConfigFromPrompt(prompt) {
	const text = String(prompt).toLowerCase().replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ").trim();
	if (!text) return null;
	const inferred = {};
	const resumeMatch = text.match(/\b(?:for|after|limit(?:ed)?(?: to)?|stop after|only)?\s*(\d[\d,_]*)\s*(?:auto[- ]?resumes?|auto[- ]?resume turns?|resume turns?)\b/);
	if (resumeMatch) inferred.maxAutoResumeTurns = parsePositiveInteger(resumeMatch[1]);
	const runMatch = text.match(/\b(?:for|after|limit(?:ed)?(?: to)?|stop after|only)\s+(\d[\d,_]*)\s+(?:runs?|iterations?|experiments?)\b/);
	const chineseRunMatch = text.match(/(?:做|运行|执行|最多|限制|迭代)\s*(\d+)\s*(?:次|轮|个实验)/);
	const runCount = parsePositiveInteger(runMatch?.[1] ?? chineseRunMatch?.[1] ?? "");
	if (runCount !== null) {
		inferred.maxIterations = runCount;
		if (inferred.maxAutoResumeTurns === void 0) inferred.maxAutoResumeTurns = runCount;
	}
	if (/\b(?:run|continue|resume|loop)\s+(?:indefinitely|infinite(?:ly)?|forever|without stopping)\b/.test(text) || /\b(?:indefinitely|forever)\s+(?:run|continue|resume|loop)\b/.test(text) || /\bunlimited\s+auto[- ]?resume\b/.test(text) || /\b(?:no|without)\s+(?:auto[- ]?resume\s+)?limits?\b/.test(text) || /\bnever\s+stopp?ing?\b/.test(text) || /\bdon'?t\s+stop\b/.test(text) || /(?:无限|一直|不停)(?:运行|继续|迭代)|(?:运行|继续|迭代)(?:到永远|不停)/.test(text)) {
		inferred.maxAutoResumeTurns = null;
		if (inferred.maxIterations === void 0) inferred.clearMaxIterations = true;
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
function writeJsonAtomic(filePath, value, mode = 384) {
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
		timeout: 15e3,
		maxBuffer: 16777216
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
			try {
				size = entry.isFile() ? fs.lstatSync(absolute).size : 0;
			} catch {
				continue;
			}
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
		const newline = tail.indexOf(10);
		if (newline >= 0) tail = tail.subarray(newline + 1);
		selected = tail.toString("utf8");
		truncatedBy = "bytes";
	}
	return {
		content: selected,
		truncated: sourceBytes > Buffer.byteLength(selected),
		truncatedBy,
		totalLines: lines.length,
		outputLines: selected.split(/\r?\n/).length
	};
}
function killTree(pid, signal = "SIGTERM") {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {}
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
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		const rolling = [];
		let rollingBytes = 0;
		let prefix = [];
		let prefixBytes = 0;
		let totalBytes = 0;
		let fullOutputPath = null;
		let metricCarry = "";
		const parsedMetrics = /* @__PURE__ */ new Map();
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
			} else fs.appendFileSync(fullOutputPath, chunk);
			rolling.push(chunk);
			rollingBytes += chunk.length;
			while (rollingBytes > DISPLAY_MAX_BYTES * 2 && rolling.length > 1) rollingBytes -= rolling.shift().length;
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
			setTimeout(() => child.pid && killTree(child.pid, "SIGKILL"), 2e3).unref();
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
				reject(/* @__PURE__ */ new Error("Experiment aborted"));
				return;
			}
			const output = fullOutputPath ? Buffer.concat(rolling).toString("utf8") : Buffer.concat(prefix).toString("utf8");
			resolve({
				exitCode,
				timedOut,
				output,
				totalBytes,
				fullOutputPath,
				parsedMetrics,
				durationSeconds: (Date.now() - startedAt) / 1e3
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
		updatedAt: Date.now()
	};
}
function readAutoresearchConfig(cwd) {
	return readJson(sessionFilePath(cwd, "config"), {});
}
function applyInferredAutoresearchConfig(cwd, inferred) {
	const configPath = sessionFilePath(cwd, "config");
	const config = readAutoresearchConfig(cwd);
	const notes = [];
	if (inferred.clearMaxIterations) {
		delete config.maxIterations;
		notes.push("maxIterations=unlimited");
	}
	if (inferred.maxIterations !== void 0) {
		config.maxIterations = inferred.maxIterations;
		notes.push(`maxIterations=${inferred.maxIterations}`);
	}
	if (inferred.maxAutoResumeTurns !== void 0) {
		config.maxAutoResumeTurns = inferred.maxAutoResumeTurns;
		notes.push(`maxAutoResumeTurns=${inferred.maxAutoResumeTurns === null ? "unlimited" : inferred.maxAutoResumeTurns}`);
	}
	writeJsonAtomic(configPath, config, 420);
	return notes;
}
var AutoresearchController = class {
	cwd;
	dataDir;
	listeners;
	constructor({ cwd = process.cwd(), dataDir = path.join(os.homedir(), ".dsh", "autoresearch", "state") } = {}) {
		this.cwd = path.resolve(cwd);
		this.dataDir = path.resolve(dataDir);
		this.listeners = /* @__PURE__ */ new Set();
	}
	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	notifyChange() {
		for (const listener of this.listeners) try {
			listener(this.snapshot());
		} catch {}
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
		const value = readJson(this.snapshotManifestPath(), {
			version: 1,
			files: {}
		});
		return {
			version: 1,
			files: objectRecord(value.files) ? value.files : {}
		};
	}
	captureSnapshots(candidates, { overwrite = false } = {}) {
		const paths = this.protectedPaths(candidates);
		const manifest = this.snapshotManifest();
		const warnings = [];
		try {
			fs.mkdirSync(path.join(this.snapshotRoot(), "blobs"), {
				recursive: true,
				mode: 448
			});
			fs.chmodSync(this.snapshotRoot(), 448);
		} catch {
			return {
				ok: false,
				paths,
				warnings: paths
			};
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
					manifest.files[portable] = {
						kind: "symlink",
						target: fs.readlinkSync(absolute)
					};
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
				fs.chmodSync(blobPath, 384);
				manifest.files[portable] = {
					kind: "file",
					blob,
					mode: stat.mode & 511
				};
			} catch {
				warnings.push(portable);
			}
		}
		try {
			writeJsonAtomic(this.snapshotManifestPath(), manifest);
		} catch {
			return {
				ok: false,
				paths,
				warnings: paths
			};
		}
		return {
			ok: warnings.length === 0,
			paths,
			warnings
		};
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
			try {
				current = fs.lstatSync(absolute);
			} catch (error) {
				if (error?.code !== "ENOENT") warnings.push(portable);
			}
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
		return {
			ok: warnings.length === 0,
			paths,
			warnings
		};
	}
	statePath() {
		const key = createHash("sha256").update(JSON.stringify({
			cwd: this.cwd,
			workDir: this.workDir()
		})).digest("hex").slice(0, 32);
		return path.join(this.dataDir, `${key}.json`);
	}
	privateState() {
		const defaults = defaultPrivateState(this.cwd, this.workDir());
		const stored = readJson(this.statePath(), {});
		const merged = {
			...defaults,
			...stored
		};
		if (!stored.loopState) merged.loopState = merged.active ? "active" : merged.manualOff ? "stopped" : "idle";
		return merged;
	}
	savePrivate(patch) {
		const next = {
			...this.privateState(),
			...patch,
			version: 3,
			cwd: this.cwd,
			workDir: this.workDir(),
			updatedAt: Date.now()
		};
		writeJsonAtomic(this.statePath(), next);
		this.notifyChange();
		return next;
	}
	resumeFor(privateState = this.privateState()) {
		const token = privateState.pendingResumeToken;
		if (!token) return {
			shouldSchedule: false,
			command: null,
			token: null
		};
		return {
			shouldSchedule: true,
			token,
			turn: privateState.autoResumeTurns,
			command: null
		};
	}
	consumeResumeToken(token) {
		const expected = String(token || "");
		if (!expected) throw new Error("AUTORESEARCH_STALE continuation token is missing");
		const lockPath = `${this.statePath()}.${expected}.lock`;
		let lock;
		try {
			fs.mkdirSync(path.dirname(this.statePath()), { recursive: true });
			lock = fs.openSync(lockPath, "wx", 384);
		} catch (error) {
			if (error && error.code === "EEXIST") throw new Error("AUTORESEARCH_STALE duplicate continuation token");
			throw error;
		}
		try {
			const state = this.privateState();
			if (state.active !== true || state.manualOff === true || state.pendingResumeToken !== expected) throw new Error("AUTORESEARCH_STALE continuation was stopped or superseded");
			const next = this.savePrivate({
				pendingResumeToken: null,
				resumedAt: Date.now()
			});
			return {
				ok: true,
				text: `${CONTINUE_MARKER} turn=${next.autoResumeTurns} cwd=${JSON.stringify(next.cwd)}`,
				turn: next.autoResumeTurns
			};
		} finally {
			try {
				if (lock !== void 0) fs.closeSync(lock);
			} catch {}
			try {
				fs.unlinkSync(lockPath);
			} catch {}
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
				"The host will follow up this same session. End this turn. Use /autoresearch off to cancel."
			].join("\n")
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
		try {
			directoryOk = fs.statSync(workDir).isDirectory();
		} catch {}
		if (!directoryOk) return {
			ok: false,
			code: "working-dir-missing",
			workDir,
			allowNoGit: false,
			needsDecision: true,
			error: `项目目录不可用，请重新选择一个可写的项目目录：${workDir}`
		};
		const privateState = this.privateState();
		const allowNoGit = this.config().allowNoGit === true;
		if (allowNoGit || privateState.protectionMode === "snapshot") return {
			ok: true,
			workDir,
			allowNoGit,
			protectionMode: "snapshot",
			protectedPaths: this.protectedPaths()
		};
		if (privateState.protectionMode === "pending") return {
			ok: true,
			workDir,
			allowNoGit,
			protectionMode: "pending",
			protectedPaths: this.protectedPaths()
		};
		const result = runGit(workDir, [
			"rev-parse",
			"--is-inside-work-tree",
			"--show-toplevel"
		], { allowFailure: true });
		const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
		if (result.error || result.status !== 0 || lines[0] !== "true") return {
			ok: true,
			workDir,
			allowNoGit,
			protectionMode: "snapshot",
			protectedPaths: this.protectedPaths()
		};
		const head = runGit(workDir, [
			"rev-parse",
			"--verify",
			"HEAD"
		], { allowFailure: true });
		if (head.error || head.status !== 0) return {
			ok: true,
			workDir,
			gitRoot: lines[1],
			allowNoGit,
			protectionMode: "snapshot",
			protectedPaths: this.protectedPaths()
		};
		return {
			ok: true,
			workDir,
			gitRoot: lines[1],
			allowNoGit,
			protectionMode: "git",
			protectedPaths: this.protectedPaths()
		};
	}
	prepareGitSafety(proposedProtectedPaths = []) {
		const workDir = this.workDir();
		let directoryOk = false;
		try {
			directoryOk = fs.statSync(workDir).isDirectory();
		} catch {}
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
			setupText: protectedPaths.length ? "已自动保存本地保护点；代码不会上传。" : "本地保护已就绪；首次修改文件前会自动保存保护点。"
		});
		if (!captured.ok) return {
			ok: false,
			code: "protection-needs-confirmation",
			needsDecision: true,
			workDir,
			protectedPaths,
			error: `有 ${captured.warnings.length} 个特殊路径无法自动保护。请换到具体项目目录后重试。`
		};
		if (this.config().allowNoGit === true) return fallback("git-disabled-by-config");
		let initialized = false;
		let probe = runGit(workDir, [
			"rev-parse",
			"--is-inside-work-tree",
			"--show-toplevel"
		], { allowFailure: true });
		let lines = String(probe.stdout || "").trim().split(/\r?\n/).filter(Boolean);
		if (probe.error || probe.status !== 0 || lines[0] !== "true") {
			const created = runGit(workDir, ["init", "-q"], { allowFailure: true });
			if (created.error || created.status !== 0) return fallback(created.error?.message || `${created.stdout || ""}${created.stderr || ""}`.trim() || "local-version-tool-unavailable");
			initialized = true;
			probe = runGit(workDir, [
				"rev-parse",
				"--is-inside-work-tree",
				"--show-toplevel"
			], { allowFailure: true });
			lines = String(probe.stdout || "").trim().split(/\r?\n/).filter(Boolean);
			if (probe.error || probe.status !== 0 || lines[0] !== "true") return fallback(probe.error?.message || "local-version-probe-failed");
		}
		const pathspecs = gitPathspecs(protectedPaths);
		const head = runGit(workDir, [
			"rev-parse",
			"--verify",
			"HEAD"
		], { allowFailure: true });
		if (!initialized && !head.error && head.status === 0 && pathspecs.length) {
			const unstaged = runGit(workDir, [
				"diff",
				"--quiet",
				"--",
				...pathspecs
			], { allowFailure: true });
			const stagedExisting = runGit(workDir, [
				"diff",
				"--cached",
				"--quiet",
				"--",
				...pathspecs
			], { allowFailure: true });
			const untracked = runGit(workDir, [
				"ls-files",
				"--others",
				"--exclude-standard",
				"-z",
				"--",
				...pathspecs
			], { allowFailure: true });
			if (unstaged.error || stagedExisting.error || untracked.error || ![0, 1].includes(unstaged.status) || ![0, 1].includes(stagedExisting.status) || untracked.status !== 0) return fallback("existing-project-inspection-failed");
			if (unstaged.status === 1 || stagedExisting.status === 1 || String(untracked.stdout || "").length > 0) return fallback("existing-project-local-work-preserved");
			return {
				ok: true,
				workDir,
				gitRoot: lines[1],
				allowNoGit: false,
				initialized: false,
				baselineCreated: false,
				protectionMode: "git",
				protectedPaths,
				setupText: "本地保护已就绪；代码不会上传。"
			};
		}
		if (!initialized && (head.error || head.status !== 0)) return fallback("existing-project-without-baseline");
		if (pathspecs.length) {
			const staged = runGit(workDir, [
				"add",
				"-A",
				"--",
				...pathspecs
			], { allowFailure: true });
			if (staged.error || staged.status !== 0) return fallback(staged.error?.message || `${staged.stdout || ""}${staged.stderr || ""}`.trim() || "local-baseline-stage-failed");
		}
		const diff = pathspecs.length ? runGit(workDir, [
			"diff",
			"--cached",
			"--quiet",
			"--",
			...pathspecs
		], { allowFailure: true }) : {
			status: 0,
			stdout: "",
			stderr: "",
			error: null
		};
		if (diff.error || diff.status !== 0 && diff.status !== 1) return fallback(diff.error?.message || `${diff.stdout || ""}${diff.stderr || ""}`.trim() || "local-baseline-inspection-failed");
		const hasChanges = diff.status === 1;
		if (!(head.error || head.status !== 0 || hasChanges)) return {
			ok: true,
			workDir,
			gitRoot: lines[1],
			allowNoGit: false,
			initialized,
			baselineCreated: false,
			protectionMode: "git",
			protectedPaths,
			setupText: protectedPaths.length ? "本地保护已就绪；代码不会上传。" : "本地保护已就绪；首次修改文件前会自动保存保护点。"
		};
		const identity = [["user.name", "DSH Autoresearch"], ["user.email", "autoresearch@local.invalid"]];
		const configuredIdentity = [];
		for (const [key, fallbackValue] of identity) {
			const existing = runGit(workDir, [
				"config",
				"--get",
				key
			], { allowFailure: true });
			if (existing.status === 0 && String(existing.stdout || "").trim()) continue;
			const configured = runGit(workDir, [
				"config",
				"--local",
				key,
				fallbackValue
			], { allowFailure: true });
			if (configured.error || configured.status !== 0) return fallback(configured.error?.message || `${configured.stdout || ""}${configured.stderr || ""}`.trim() || "local-identity-setup-failed");
			configuredIdentity.push(key);
		}
		const commitArgs = [
			"-c",
			"commit.gpgSign=false",
			"commit",
			"--no-verify",
			"-q",
			"-m",
			"chore: create autoresearch safety baseline"
		];
		if (hasChanges) commitArgs.push("--", ...pathspecs);
		else commitArgs.push("--allow-empty");
		const committed = runGit(workDir, commitArgs, { allowFailure: true });
		if (committed.error || committed.status !== 0) return fallback(committed.error?.message || `${committed.stdout || ""}${committed.stderr || ""}`.trim() || "local-baseline-commit-failed");
		const committedHead = runGit(workDir, [
			"rev-parse",
			"--short=7",
			"HEAD"
		], { allowFailure: true });
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
			setupText: "已自动保存本地保护点；代码不会上传。"
		};
	}
	protectPathsBeforeMutation(candidates = []) {
		const current = this.privateState();
		if (current.active !== true || current.manualOff === true) return {
			ok: true,
			active: false,
			protectedPaths: this.protectedPaths()
		};
		const incoming = this.protectedPaths(candidates);
		const known = new Set(this.protectedPaths(current.protectedPaths));
		const added = incoming.filter((portable) => !known.has(portable));
		if (added.length === 0) return {
			ok: true,
			active: true,
			protectedPaths: [...known]
		};
		const captured = this.captureSnapshots(added);
		if (!captured.ok) return {
			ok: false,
			needsDecision: true,
			code: "protection-needs-confirmation",
			text: `这个修改包含无法自动保护的特殊路径：${captured.warnings.join(", ")}`
		};
		let protectionMode = current.protectionMode === "git" ? "git" : "snapshot";
		if (protectionMode === "git") protectionMode = this.prepareGitSafety(added).protectionMode === "git" ? "git" : "snapshot";
		const protectedPaths = [...known, ...added];
		this.savePrivate({
			protectedPaths,
			protectionMode
		});
		return {
			ok: true,
			active: true,
			protectedPaths,
			protectionMode
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
		const result = await runHook({
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
				goal: typeof extra?.goal === "string" ? extra.goal : persisted.name ?? ""
			}
		});
		appendHookLogEntryIfConfigured(sessionFilePath(this.workDir(), "log"), event, result);
		return {
			result,
			steer: steerMessageFor(event, result)
		};
	}
	async finish({ outcome = "complete", reason = "", user_question = "" } = {}) {
		const privateState = this.privateState();
		if (!privateState.active && privateState.loopState !== "awaiting_user") return {
			ok: false,
			active: false,
			text: "Autoresearch is not active."
		};
		if (!["complete", "needs_user"].includes(outcome)) return {
			ok: false,
			active: privateState.active,
			text: "outcome must be complete or needs_user."
		};
		const decisionReason = String(reason).trim();
		if (!decisionReason) return {
			ok: false,
			active: privateState.active,
			text: "reason is required."
		};
		const persisted = this.persisted();
		const current = persisted.results.filter((run) => run.segment === persisted.currentSegment);
		if (outcome === "complete" && !current.some((run) => run.status === "keep")) return {
			ok: false,
			active: privateState.active,
			text: "Cannot complete without a kept result in the current goal."
		};
		const question = String(user_question).trim();
		if (outcome === "needs_user" && !question) return {
			ok: false,
			active: privateState.active,
			text: "user_question is required when outcome is needs_user."
		};
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
			lastRunDuration: null
		});
		return {
			ok: true,
			active: false,
			needsDecision: !completed,
			loopState: completed ? "completed" : "awaiting_user",
			completionReason: decisionReason,
			completedAt: completed ? this.privateState().completedAt : null,
			decisionQuestion: completed ? null : question,
			text: completed ? `Autoresearch completed: ${decisionReason}` : `Autoresearch is waiting for the user: ${question}\nReason: ${decisionReason}`
		};
	}
	async control({ args = "", protectedPaths = [] } = {}) {
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
					status.text
				].join("\n")
			};
		}
		if (command === "status") return this.status();
		if (command === "complete" || command.startsWith("complete ")) return this.finish({
			outcome: "complete",
			reason: text.slice(8).trim() || "The verified goal is complete."
		});
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
				hintsThisSession: 0
			});
			return {
				ok: true,
				active: false,
				text: "Autoresearch is off. Any pending automatic continuation was cancelled."
			};
		}
		if (command === "clear") {
			for (const candidate of Object.values(sessionFileCandidates(this.workDir(), "log"))) try {
				fs.unlinkSync(candidate);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
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
				hintsThisSession: 0
			});
			return {
				ok: true,
				active: false,
				text: "Autoresearch log cleared and automatic continuation stopped."
			};
		}
		if (command === "export") return {
			ok: true,
			...await this.status(),
			action: "export",
			text: "Open the Autoresearch monitor dock in the official DeepSeek Harness Web GUI. The larger overlay is optional and does not block Agent output by default."
		};
		if (command === "finalize") return {
			ok: true,
			active: this.privateState().active,
			action: "finalize",
			text: "Load and follow the autoresearch-finalize support skill. Do not activate a new loop."
		};
		if (command === "hooks") return {
			ok: true,
			active: this.privateState().active,
			action: "hooks",
			text: "Load and follow the autoresearch-hooks support skill. Do not activate a new loop."
		};
		const explicitResume = /^resume\s*$/i.test(text);
		if (/^start(?:\s|$)/i.test(text)) text = text.replace(/^start\s*/i, "").trim();
		else if (/^resume(?:\s|$)/i.test(text)) text = text.replace(/^resume\s*/i, "").trim();
		const isNewGoal = !explicitResume && text.length > 0;
		const inferred = inferAutoresearchConfigFromPrompt(text);
		const configNotes = inferred ? applyInferredAutoresearchConfig(this.cwd, inferred) : [];
		const safety = this.prepareGitSafety(protectedPaths);
		if (!safety.ok) return {
			ok: true,
			active: false,
			needsDecision: true,
			action: "choose-project-folder",
			text: safety.error,
			details: safety
		};
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
			protectionMode: safety.protectionMode ?? "snapshot"
		});
		const before = beforeNeeded ? await this.fireHook("before", {
			goal: isNewGoal ? text : previousPrivate.goal,
			next_run: isNewGoal ? 1 : previousPersisted.results.length + 1,
			last_run: isNewGoal ? null : previousPersisted.results.at(-1) ?? null
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
				needsSetup ? isNewGoal ? "This is a new goal. Replace .auto/prompt.md for this goal, prepare its deterministic benchmark, then call init_experiment to start a fresh segment." : "Setup is incomplete. Inspect the project, create .auto/prompt.md and a deterministic benchmark, then call init_experiment." : "Read .auto/prompt.md and the persisted log, then continue with the next experiment.",
				before.steer ? `Before hook:\n${before.steer}` : ""
			].filter(Boolean).join("\n")
		};
	}
	async initExperiment({ name, metric_name = "metric", metric_unit = "", direction = "lower" } = {}) {
		const privateState = this.privateState();
		if (!privateState.active || privateState.manualOff) return {
			ok: false,
			text: "Autoresearch is not active. Run /autoresearch <goal> first."
		};
		const pending = this.pendingGate(privateState);
		if (pending) return pending;
		const safety = this.gitSafety();
		if (!safety.ok) return {
			ok: false,
			text: safety.error,
			details: safety
		};
		if (!name || !metric_name) return {
			ok: false,
			text: "name and metric_name are required."
		};
		const jsonlPath = sessionFilePath(this.workDir(), "log");
		ensureParentDir(jsonlPath);
		const previous = this.persisted();
		const entry = {
			type: "config",
			name: String(name),
			metricName: String(metric_name),
			metricUnit: String(metric_unit ?? ""),
			bestDirection: direction === "higher" ? "higher" : "lower"
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
			lastRunDuration: null
		});
		this.notifyChange();
		const before = await this.fireHook("before", {
			next_run: previous.results.length + 1,
			last_run: previous.results.at(-1) ?? null
		});
		return {
			ok: true,
			text: [
				`Experiment initialized: ${name}${previous.results.length ? " (new segment)" : ""}.`,
				`Metric: ${metric_name} (${metric_unit || "unitless"}; ${entry.bestDirection} is better).`,
				"Run the baseline with autoresearch__run_experiment.",
				before.steer ? `Before hook:\n${before.steer}` : ""
			].filter(Boolean).join("\n"),
			details: { state: this.persisted() }
		};
	}
	async runExperiment({ command, timeout_seconds = 600, checks_timeout_seconds = 300, signal } = {}) {
		const privateState = this.privateState();
		if (!privateState.active || privateState.manualOff) return {
			ok: false,
			text: "Autoresearch is not active."
		};
		const pending = this.pendingGate(privateState);
		if (pending) return pending;
		const safety = this.gitSafety();
		if (!safety.ok) return {
			ok: false,
			text: safety.error,
			details: safety
		};
		const persisted = this.persisted();
		if (!persisted.name) return {
			ok: false,
			text: "Experiment is not initialized. Call init_experiment first."
		};
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
				pendingResumeToken: null
			});
			return {
				ok: false,
				active: false,
				text: `Maximum experiments reached (${Math.floor(config.maxIterations)}).`
			};
		}
		if (!command) return {
			ok: false,
			text: "command is required."
		};
		const benchmarkPath = sessionFilePath(this.workDir(), "measure");
		if (fs.existsSync(benchmarkPath) && !isBenchmarkCommand(command)) return {
			ok: false,
			text: `${path.relative(this.workDir(), benchmarkPath)} exists. Run that stable benchmark instead of a custom command.`,
			details: {
				command,
				benchmarkPath
			}
		};
		const result = await runCommand(command, {
			cwd: this.workDir(),
			timeoutMs: Math.max(0, Number(timeout_seconds) || 0) * 1e3,
			signal
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
				timeoutMs: Math.max(0, Number(checks_timeout_seconds) || 0) * 1e3,
				signal,
				tempPrefix: "dsh-autoresearch-checks"
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
			lastRunChecks: checksPass === null ? null : {
				pass: checksPass,
				output: checksOutput,
				duration: checksDuration
			},
			lastRunDuration: result.durationSeconds,
			pendingResumeToken: null
		};
		this.savePrivate(privatePatch);
		const llmTail = trimTail(result.output, 10, EXPERIMENT_MAX_BYTES);
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
			truncation: llmTail.truncated ? llmTail : void 0
		};
		return {
			ok: true,
			text: [
				result.timedOut ? `TIMEOUT after ${result.durationSeconds.toFixed(1)}s` : benchmarkPassed ? `Benchmark passed in ${result.durationSeconds.toFixed(1)}s` : `Benchmark failed (exit ${result.exitCode}) in ${result.durationSeconds.toFixed(1)}s`,
				checksPass === true ? `Checks passed in ${checksDuration.toFixed(1)}s.` : "",
				checksPass === false ? `Checks failed in ${checksDuration.toFixed(1)}s. Log status checks_failed.` : "",
				Object.keys(parsedMetrics).length ? `Parsed METRIC values: ${JSON.stringify(parsedMetrics)}` : "",
				llmTail.content,
				llmTail.truncated && result.fullOutputPath ? `Full output: ${result.fullOutputPath}` : "",
				"Always call autoresearch_log_experiment for this run."
			].filter(Boolean).join("\n"),
			details
		};
	}
	async logExperiment({ commit = "", metric, metrics = {}, status, description = "", asi, force = false, next_action, decision_reason = "", user_question = "" } = {}) {
		const privateState = this.privateState();
		if (!privateState.active || privateState.manualOff) return {
			ok: false,
			text: "Autoresearch is not active."
		};
		const pending = this.pendingGate(privateState);
		if (pending) return pending;
		const safety = this.gitSafety();
		if (!safety.ok) return {
			ok: false,
			text: safety.error,
			details: safety
		};
		if (!Number.isFinite(metric)) return {
			ok: false,
			text: "metric must be a finite number."
		};
		if (![
			"keep",
			"discard",
			"crash",
			"checks_failed"
		].includes(status)) return {
			ok: false,
			text: "status must be keep, discard, crash, or checks_failed."
		};
		if (!objectRecord(metrics) || Object.values(metrics).some((value) => !Number.isFinite(value))) return {
			ok: false,
			text: "metrics must contain only finite numbers."
		};
		if (![
			"continue",
			"complete",
			"needs_user"
		].includes(next_action)) return {
			ok: false,
			text: "next_action must be continue, complete, or needs_user."
		};
		const decisionReason = String(decision_reason).trim();
		if (!decisionReason) return {
			ok: false,
			text: "decision_reason is required."
		};
		const userQuestion = String(user_question).trim();
		if (next_action === "needs_user" && !userQuestion) return {
			ok: false,
			text: "user_question is required when next_action is needs_user."
		};
		if (status === "keep" && privateState.lastRunChecks && !privateState.lastRunChecks.pass) return {
			ok: false,
			text: `Cannot keep because .auto/checks.sh failed. Log checks_failed instead.\n${String(privateState.lastRunChecks.output).slice(-500)}`
		};
		const persisted = this.persisted();
		if (!persisted.name) return {
			ok: false,
			text: "Experiment is not initialized."
		};
		const secondaryMetrics = { ...metrics };
		delete secondaryMetrics[persisted.metricName];
		const known = new Set(persisted.secondaryMetrics.map((entry) => entry.name));
		const provided = new Set(Object.keys(secondaryMetrics));
		const missing = [...known].filter((name) => !provided.has(name));
		if (missing.length) return {
			ok: false,
			text: `Missing secondary metrics: ${missing.join(", ")}.`
		};
		const added = [...provided].filter((name) => !known.has(name));
		if (persisted.results.length && added.length && !force) return {
			ok: false,
			text: `New secondary metrics require force=true: ${added.join(", ")}.`
		};
		let resolvedCommit = String(commit).slice(0, 7);
		let gitText = "";
		const pathspecs = this.protectionPathspecs();
		let protectionMode = safety.protectionMode === "git" && privateState.protectionMode === "git" ? "git" : "snapshot";
		if (status === "keep" && protectionMode === "git" && pathspecs.length) {
			const staged = runGit(this.workDir(), [
				"add",
				"-A",
				"--",
				...pathspecs
			], { allowFailure: true });
			const diff = staged.error || staged.status !== 0 ? staged : runGit(this.workDir(), [
				"diff",
				"--cached",
				"--quiet",
				"--",
				...pathspecs
			], { allowFailure: true });
			if (!diff.error && diff.status === 0) gitText = "本轮没有需要保存的代码变化。";
			else if (!diff.error && diff.status === 1) {
				const resultData = {
					status,
					[persisted.metricName || "metric"]: metric,
					...secondaryMetrics
				};
				const committed = runGit(this.workDir(), [
					"-c",
					"commit.gpgSign=false",
					"commit",
					"--no-verify",
					"-q",
					"-m",
					`${description}\n\nResult: ${JSON.stringify(resultData)}`,
					"--",
					...pathspecs
				], { allowFailure: true });
				if (!committed.error && committed.status === 0) {
					const head = runGit(this.workDir(), [
						"rev-parse",
						"--short=7",
						"HEAD"
					], { allowFailure: true });
					if (!head.error && head.status === 0) resolvedCommit = String(head.stdout || "").trim();
					gitText = "已保存本轮改进。";
				} else {
					protectionMode = "snapshot";
					runGit(this.workDir(), [
						"reset",
						"-q",
						"HEAD",
						"--",
						...pathspecs
					], { allowFailure: true });
				}
			} else {
				protectionMode = "snapshot";
				runGit(this.workDir(), [
					"reset",
					"-q",
					"HEAD",
					"--",
					...pathspecs
				], { allowFailure: true });
			}
		}
		if (status === "keep") {
			const refreshed = this.captureSnapshots(this.protectedPaths(), { overwrite: true });
			if (!refreshed.ok) {
				protectionMode = "snapshot";
				gitText = `本轮已保留，但有 ${refreshed.warnings.length} 个特殊路径需要稍后确认。`;
			} else if (!gitText) gitText = this.protectedPaths().length ? "已保存本轮改进。" : "本轮尚未改动源码，已继续运行。";
			if (protectionMode !== privateState.protectionMode) this.savePrivate({ protectionMode });
		}
		const currentSegmentRuns = persisted.results.filter((run) => run.segment === persisted.currentSegment);
		if (next_action === "complete" && status !== "keep" && !currentSegmentRuns.some((run) => run.status === "keep")) return {
			ok: false,
			text: "Cannot complete without a kept result in the current goal."
		};
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
			...objectRecord(asi) && Object.keys(asi).length ? { asi } : {}
		};
		provisional.confidence = confidenceFor([...persisted.results, provisional], persisted.currentSegment, persisted.bestDirection);
		const jsonlPath = sessionFilePath(this.workDir(), "log");
		ensureParentDir(jsonlPath);
		fs.appendFileSync(jsonlPath, `${JSON.stringify(provisional)}\n`);
		this.notifyChange();
		let rollbackNeedsDecision = false;
		if (status !== "keep") {
			const restored = this.restoreSnapshots();
			if (protectionMode === "git" && pathspecs.length) runGit(this.workDir(), [
				"reset",
				"-q",
				"HEAD",
				"--",
				...pathspecs
			], { allowFailure: true });
			rollbackNeedsDecision = !restored.ok;
			gitText = restored.ok ? "已自动撤销本轮变化，实验记录已保留。" : `已撤销普通文件；另有 ${restored.warnings.length} 个特殊路径需要你确认。`;
		}
		const after = await this.fireHook("after", { run_entry: provisional });
		let before = { steer: null };
		const segmentCount = currentSegmentRuns.length + 1;
		const config = this.config();
		const maxIterations = Number.isFinite(config.maxIterations) && config.maxIterations > 0 ? Math.floor(config.maxIterations) : null;
		const maxAutoResumeTurns = config.maxAutoResumeTurns === null || config.maxAutoResumeTurns === 0 ? null : Number.isFinite(config.maxAutoResumeTurns) && config.maxAutoResumeTurns > 0 ? Math.floor(config.maxAutoResumeTurns) : 20;
		let resume = {
			shouldSchedule: false,
			command: null,
			token: null
		};
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
				lastRunDuration: null
			});
			stopText = "检测到特殊路径，循环已安全暂停；请确认后再继续。";
		} else if (next_action === "complete") {
			loopState = "completed";
			stopText = (await this.finish({
				outcome: "complete",
				reason: decisionReason
			})).text;
		} else if (next_action === "needs_user") {
			needsDecision = true;
			loopState = "awaiting_user";
			stopText = (await this.finish({
				outcome: "needs_user",
				reason: decisionReason,
				user_question: userQuestion
			})).text;
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
				lastRunDuration: null
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
				lastRunDuration: null
			});
			stopText = `Automatic continuation safety limit reached (${maxAutoResumeTurns}). Run /autoresearch resume to continue.`;
		} else {
			before = await this.fireHook("before", {
				next_run: provisional.run + 1,
				last_run: provisional
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
				lastRunDuration: null
			});
			resume = this.resumeFor(nextPrivate);
		}
		return {
			ok: true,
			text: [
				resume.shouldSchedule ? CONTINUATION_REQUIRED : "",
				resume.shouldSchedule ? "The host will follow up this same session for the next experiment. End this turn. Do not edit, inspect, or run another experiment first." : "",
				`Logged #${provisional.run}: ${status} - ${description}`,
				`${persisted.metricName}: ${metric}${persisted.metricUnit}`,
				Object.keys(secondaryMetrics).length ? `Secondary: ${JSON.stringify(secondaryMetrics)}` : "",
				provisional.confidence === null ? "" : `Confidence: ${provisional.confidence.toFixed(1)}x noise floor.`,
				gitText,
				after.steer ? `After hook:\n${after.steer}` : "",
				before.steer && !stopText ? `Before hook for next run:\n${before.steer}` : "",
				stopText
			].filter(Boolean).join("\n"),
			details: {
				experiment: provisional,
				state: this.persisted(),
				wallClockSeconds: privateState.lastRunDuration
			},
			resume,
			needsDecision,
			loopState,
			completionReason: decisionReason,
			decisionQuestion: needsDecision ? this.privateState().decisionQuestion : null
		};
	}
	async status() {
		const privateState = this.privateState();
		const persisted = this.persisted();
		const current = privateState.pendingNewGoal ? [] : persisted.results.filter((run) => run.segment === persisted.currentSegment);
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
			text: loopState === "awaiting_user" ? `Autoresearch is waiting for the user: ${privateState.decisionQuestion ?? privateState.completionReason ?? "A decision is required."}` : loopState === "completed" ? `Autoresearch completed: ${privateState.completionReason ?? "The verified goal is complete."}` : privateState.pendingNewGoal && active ? `Autoresearch is preparing a fresh segment for the new goal: ${privateState.goal ?? "untitled goal"}.` : resume.shouldSchedule ? [CONTINUATION_REQUIRED, "A same-session continuation is pending. End this turn; the host will follow up."].join("\n") : active ? `Autoresearch active: ${current.length} run(s), best ${persisted.metricName}: ${bestKeptMetric ?? "n/a"}.` : `Autoresearch inactive: ${current.length} persisted run(s).`,
			state: persisted
		};
	}
	snapshot() {
		const privateState = this.privateState();
		const persisted = this.persisted();
		const nextSegment = persisted.results.length > 0 ? persisted.currentSegment + 1 : persisted.currentSegment;
		const currentSegment = privateState.pendingNewGoal ? nextSegment : persisted.currentSegment;
		const current = privateState.pendingNewGoal ? [] : persisted.results.filter((run) => run.segment === persisted.currentSegment);
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
		const maxIterations = Number.isFinite(config.maxIterations) && config.maxIterations > 0 ? Math.floor(config.maxIterations) : null;
		const maxAutoResumeTurns = config.maxAutoResumeTurns === null || config.maxAutoResumeTurns === 0 ? null : Number.isFinite(config.maxAutoResumeTurns) && config.maxAutoResumeTurns > 0 ? Math.floor(config.maxAutoResumeTurns) : 20;
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
			updatedAt: privateState.updatedAt
		};
	}
	async askHint() {
		return {
			ok: false,
			text: "Hints are disabled in dsh-autoresearch by default."
		};
	}
	async close() {
		this.listeners.clear();
	}
};
//#endregion
//#region lib/types/compaction.js
function read(filePath) {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return "";
	}
}
function metric(value) {
	if (!Number.isFinite(value)) return "-";
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
function delta(value, baseline) {
	if (!baseline || value === baseline) return "";
	const percent = (value - baseline) / baseline * 100;
	return ` (${percent > 0 ? "+" : ""}${percent.toFixed(1)}%)`;
}
function relative(workDir, filePath) {
	const result = path.relative(workDir, filePath);
	return !result || result.startsWith("..") || path.isAbsolute(result) ? filePath : result;
}
function autoresearchSummaryPathsFor(workDir) {
	return {
		workDir,
		jsonlPath: sessionFilePath(workDir, "log"),
		mdPath: sessionFilePath(workDir, "prompt"),
		ideasPath: sessionFilePath(workDir, "ideas")
	};
}
function buildAutoresearchCompactionSummary(paths) {
	const state = reconstructJsonlState(read(paths.jsonlPath));
	const current = state.results.filter((run) => run.segment === state.currentSegment);
	const baseline = current[0] ?? null;
	const best = current.filter((run) => run.status === "keep" && Number.isFinite(run.metric)).reduce((winner, run) => {
		if (!winner) return run;
		return (state.bestDirection === "lower" ? run.metric < winner.metric : run.metric > winner.metric) ? run : winner;
	}, null);
	const counts = Object.fromEntries([
		"keep",
		"discard",
		"crash",
		"checks_failed"
	].map((key) => [key, 0]));
	for (const run of current) counts[run.status] += 1;
	const sections = [[
		"# Autoresearch Compaction Summary",
		"",
		"Conversation history was compacted. Persisted autoresearch artifacts below are the source of truth."
	].join("\n"), [
		"## Session",
		"",
		`Goal: ${state.name ?? "-"}`,
		`Metric: ${state.metricName} - ${state.bestDirection} is better`,
		`Runs so far: ${current.length} (${Object.entries(counts).filter(([, count]) => count).map(([name, count]) => `${count} ${name}`).join("; ") || "none"})`,
		...baseline ? [`Baseline (#${baseline.run}): ${metric(baseline.metric)}${state.metricUnit}`] : [],
		...best && best.run !== baseline?.run ? [`Best (#${best.run}): ${metric(best.metric)}${state.metricUnit}${delta(best.metric, baseline.metric)}`] : []
	].join("\n")];
	const rules = read(paths.mdPath).trim();
	if (rules) sections.push(`## Experiment Rules (${relative(paths.workDir, paths.mdPath)})\n\n${rules}`);
	const ideas = read(paths.ideasPath).trim();
	if (ideas) sections.push(`## Ideas Backlog (${relative(paths.workDir, paths.ideasPath)})\n\n${ideas}`);
	const recent = state.results.slice(-50);
	sections.push(recent.length === 0 ? "## Recent Runs\n\nNo runs yet - start with the first hypothesis." : [
		`## Recent Runs (last ${recent.length})`,
		"",
		...recent.map((run) => {
			const segmentBaseline = state.results.find((other) => other.segment === run.segment)?.metric ?? null;
			const asi = run.asi ?? {};
			return [
				`#${run.run} ${run.status.padEnd(13)} ${metric(run.metric)}${delta(run.metric, segmentBaseline)}`,
				run.description ? `desc: ${run.description}` : "",
				typeof asi.hypothesis === "string" ? `hyp: ${asi.hypothesis}` : "",
				typeof asi.next_action_hint === "string" ? `next: ${asi.next_action_hint}` : "",
				typeof asi.rollback_reason === "string" ? `rollback: ${asi.rollback_reason}` : ""
			].filter(Boolean).join(" | ");
		}),
		"",
		`Read ${relative(paths.workDir, paths.jsonlPath)} for full history.`
	].join("\n"));
	sections.push([
		"## Next Step",
		"",
		"Choose the most promising remaining hypothesis, run it with autoresearch_run_experiment, and always record it with autoresearch_log_experiment."
	].join("\n"));
	return sections.join("\n\n");
}
//#endregion
//#region lib/types/guard.js
const CONTROL_OK = /(?:^|_)autoresearch_control$/;
const READ_OK = /(?:^|_)autoresearch_(?:status|compaction_summary)$/;
const FINISH_OK = /(?:^|_)autoresearch_finish$/;
function controlArgsAllowWhilePending(args) {
	const raw = String(args?.args ?? "").trim().toLowerCase();
	return raw === "" || /^(help|status|off|complete|clear|export|finalize|hooks)\b/.test(raw);
}
function evaluatePendingGuard(input) {
	const pending = input.pending;
	if (!pending || pending.active !== true || pending.manualOff === true || !pending.pendingResumeToken) return { decision: "allow" };
	const toolName = String(input.toolName || "");
	if (CONTROL_OK.test(toolName) && controlArgsAllowWhilePending(input.args)) return { decision: "allow" };
	if (READ_OK.test(toolName)) return { decision: "allow" };
	if (FINISH_OK.test(toolName)) return { decision: "allow" };
	return {
		decision: "deny",
		reason: "Autoresearch has a pending same-session continuation. End this turn and wait for the host follow-up, or run /autoresearch off to cancel it."
	};
}
//#endregion
//#region lib/types/recovery.js
function record$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
/**
* Mark only the exact legacy state snapshot event written by this plugin as
* ignorable. DSH deliberately treats every out-of-repo event type as unknown;
* this envelope flag makes old sessions portable without discarding the event
* when Autoresearch is installed. No seq, time, data, or unrelated line moves.
*/
function markAutoresearchStateEventsIgnorable(input) {
	const trailingNewline = input.endsWith("\n");
	const lines = input.split("\n");
	if (trailingNewline) lines.pop();
	if (lines.length === 0) throw new Error("session JSONL is empty");
	const parsed = lines.map((line, index) => {
		try {
			return JSON.parse(line);
		} catch {
			throw new Error(`session JSONL line ${index + 1} is not valid JSON`);
		}
	});
	const header = record$1(parsed[0]);
	const sessionId = typeof header?.id === "string" && header.id ? header.id : null;
	if (!sessionId) throw new Error("session JSONL header has no id");
	const markedEventSeqs = [];
	for (const value of parsed.slice(1)) {
		const event = record$1(value);
		if (event?.type !== "autoresearch/state") continue;
		const seq = Number(event.seq);
		const snapshot = record$1(record$1(event.data)?.snapshot);
		if (!Number.isSafeInteger(seq) || seq < 0 || !snapshot || typeof snapshot.cwd !== "string" || !Array.isArray(snapshot.results)) throw new Error("refusing an autoresearch/state event that does not match the published snapshot envelope");
		if (event.ignorable === true) continue;
		if (event.ignorable !== void 0) throw new Error(`refusing autoresearch/state seq ${seq} with an invalid ignorable marker`);
		event.ignorable = true;
		markedEventSeqs.push(seq);
	}
	const changed = new Set(markedEventSeqs);
	return {
		jsonl: parsed.map((value, index) => changed.has(Number(record$1(value)?.seq)) ? JSON.stringify(value) : lines[index]).join("\n") + (trailingNewline ? "\n" : ""),
		sessionId,
		markedEventSeqs
	};
}
//#endregion
//#region lib/types/legacy-session-migration.js
function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
function statIdentity(filePath) {
	const stat = fs.statSync(filePath, { bigint: true });
	return [
		stat.dev,
		stat.ino,
		stat.size,
		stat.mtimeNs
	].join(":");
}
function configuredCwds(dshHome) {
	const root = path.join(dshHome, "autoresearch", "state");
	const result = /* @__PURE__ */ new Set();
	let entries;
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return result;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		try {
			const value = JSON.parse(fs.readFileSync(path.join(root, entry.name), "utf8"));
			if (typeof value.cwd === "string" && value.cwd) result.add(path.resolve(value.cwd));
		} catch {}
	}
	return result;
}
function encodeCandidate(content, targetPath) {
	if (!targetPath.endsWith(".zstd")) return Buffer.from(content);
	const boundary = content.indexOf("\n");
	if (boundary < 0) throw new Error("session JSONL has no header boundary");
	const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
	const header = Buffer.from(content.slice(0, boundary + 1));
	const body = Buffer.from(content.slice(boundary + 1));
	const headerFrame = zstdCompressSync(header, options);
	const bodyFrame = zstdCompressSync(body, options);
	if (Buffer.concat([zstdDecompressSync(headerFrame), zstdDecompressSync(bodyFrame)]).toString("utf8") !== content) throw new Error("Zstandard candidate did not round-trip exactly");
	return Buffer.concat([headerFrame, bodyFrame]);
}
function writeAtomic(filePath, bytes) {
	const dir = path.dirname(filePath);
	const temp = path.join(dir, `.${path.basename(filePath)}.autoresearch-${process.pid}-${Date.now()}.tmp`);
	let fd;
	try {
		fd = fs.openSync(temp, "wx", 384);
		fs.writeFileSync(fd, bytes);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = void 0;
		fs.renameSync(temp, filePath);
		const dirFd = fs.openSync(dir, "r");
		try {
			fs.fsyncSync(dirFd);
		} finally {
			fs.closeSync(dirFd);
		}
	} finally {
		if (fd !== void 0) fs.closeSync(fd);
		try {
			fs.unlinkSync(temp);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
}
function ensureBackup(targetPath, original) {
	const backupPath = `${targetPath}.autoresearch-state-v1-${sha256(original).slice(0, 12)}.bak`;
	try {
		fs.copyFileSync(targetPath, backupPath, fs.constants.COPYFILE_EXCL);
		fs.chmodSync(backupPath, 384);
		const backupFd = fs.openSync(backupPath, "r");
		try {
			fs.fsyncSync(backupFd);
		} finally {
			fs.closeSync(backupFd);
		}
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		if (!fs.readFileSync(backupPath).equals(original)) throw new Error(`existing migration backup does not match ${targetPath}`);
	}
	return backupPath;
}
function writeMarker(markerPath, report) {
	fs.mkdirSync(path.dirname(markerPath), {
		recursive: true,
		mode: 448
	});
	writeAtomic(markerPath, Buffer.from(`${JSON.stringify({
		version: 1,
		completedAt: Date.now(),
		scanned: report.scanned,
		repaired: report.repaired
	}, null, 2)}\n`));
}
/**
* One-time, fail-closed migration for the plugin's two historical custom
* state events. Every modified raw log gets a byte-exact backup, an atomic
* replacement, and a full validation through the active DSH persistence
* implementation. Future versions never write this custom event again.
*/
async function migrateLegacyAutoresearchSessions(persistence, options = {}) {
	const dshHome = path.resolve(options.dshHome ?? (process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh")));
	const markerPath = path.resolve(options.markerPath ?? path.join(dshHome, "autoresearch", "migrations", "ignorable-state-v1.json"));
	const report = {
		alreadyComplete: fs.existsSync(markerPath),
		scanned: 0,
		repaired: [],
		failures: [],
		markerPath
	};
	if (report.alreadyComplete) return report;
	if (!persistence.supportsRawArtifacts) {
		report.failures.push({
			sessionId: "*",
			error: "active persistence backend has no per-session raw artifacts"
		});
		return report;
	}
	const cwds = options.candidateCwds ?? configuredCwds(dshHome);
	const headers = (await persistence.list()).filter((header) => typeof header.cwd === "string" && cwds.has(path.resolve(header.cwd)));
	for (const header of headers) {
		report.scanned += 1;
		try {
			const location = persistence.locate(header);
			if (location?.kind !== "jsonl") throw new Error("session is not backed by a JSONL artifact");
			const beforeRead = statIdentity(location.path);
			const artifact = await persistence.readRaw(header.id);
			if (!artifact) continue;
			const afterRead = statIdentity(location.path);
			if (beforeRead !== afterRead) throw new Error("session changed while the migration was reading it");
			const transformed = markAutoresearchStateEventsIgnorable(artifact.content);
			if (transformed.sessionId !== header.id) throw new Error("session identity changed while reading the raw artifact");
			if (transformed.markedEventSeqs.length === 0) continue;
			const original = fs.readFileSync(location.path);
			if (afterRead !== statIdentity(location.path)) throw new Error("session changed before the migration could publish");
			const candidate = encodeCandidate(transformed.jsonl, location.path);
			const backupPath = ensureBackup(location.path, original);
			try {
				writeAtomic(location.path, candidate);
				await persistence.inspect(header.id);
			} catch (error) {
				writeAtomic(location.path, original);
				throw new Error(`official DSH validation rejected the migrated session: ${error instanceof Error ? error.message : String(error)}`);
			}
			report.repaired.push({
				sessionId: header.id,
				eventSeqs: transformed.markedEventSeqs,
				backupPath
			});
		} catch (error) {
			report.failures.push({
				sessionId: header.id,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}
	if (report.failures.length === 0) writeMarker(markerPath, report);
	return report;
}
//#endregion
//#region lib/types/playbook.js
const here = dirname(fileURLToPath(import.meta.url));
function readSkill(name) {
	try {
		return readFileSync(join(here, "..", "skills", name, "SKILL.md"), "utf8");
	} catch {
		return "";
	}
}
const CREATE_PLAYBOOK = `Autoresearch is active for this session. Ordinary chat must not start a new loop.

Before doing anything, call autoresearch_status. If it is inactive, stop.

Tools:
- autoresearch_init_experiment — configure name, metric_name, metric_unit, direction. Call again for a new baseline.
- autoresearch_run_experiment — run the stable benchmark, parse METRIC lines, run optional .auto/checks.sh.
- autoresearch_log_experiment — record one run and atomically set next_action=continue|complete|needs_user. Always include an evidence-based decision_reason. needs_user also requires user_question. keep commits; discard/crash/checks_failed revert code but preserve .auto/.
- autoresearch_finish — after later read-only verification, mark complete or needs_user before claiming the loop is finished. Never leave active=true after saying the goal is achieved.
- autoresearch_compaction_summary — rebuild context from the ledger after compaction.

Session files live in .auto/: prompt.md, measure.sh (emits METRIC name=number), log.jsonl, optional ideas.md, checks.sh, config.json, hooks/before.sh, hooks/after.sh.

Loop rules:
1. Change one coherent variable per run.
2. Primary metric decides keep vs discard. Secondary metrics are guardrails.
3. Never invent a result. Never manually commit or revert — log_experiment owns local protection.
4. Modify source through file edit/write tools, not shell redirection, sed -i, rm, or generated overwrite commands. The pre-execute hook snapshots each file before its first mutation. Bash is for inspection, builds, tests, and benchmarks.
5. After every run, always call autoresearch_log_experiment with exactly one next_action. Use complete only when the explicit goal and guardrails are verified; use needs_user when the next step needs a product or tradeoff decision; otherwise use continue.
6. Never tell the user the goal is complete while durable state is active. If completion becomes clear after the last log, call autoresearch_finish first.
7. For needs_user, ask the exact user_question through the host decision-question UI and stop automatic work. Resume only after the user's answer.
8. Continue until a structured transition completes/pauses the loop, a tool reports a limit, the user runs /autoresearch off, the work is blocked, or the user interrupts.
9. When the host follows up after a logged run, call autoresearch_status, then run the next experiment.

If setup is incomplete, inspect the project, write .auto/prompt.md and a deterministic .auto/measure.sh, then init_experiment and log a baseline.`;
const CONTINUE_PLAYBOOK = `${CREATE_PLAYBOOK}

AUTORESEARCH_CONTINUE. The previous experiment is already logged. Call autoresearch_status, re-read .auto/prompt.md and .auto/ideas.md if needed, then perform the next experiment.`;
function skillBodies() {
	return {
		create: readSkill("autoresearch-create") || CREATE_PLAYBOOK,
		finalize: readSkill("autoresearch-finalize"),
		hooks: readSkill("autoresearch-hooks")
	};
}
//#endregion
//#region lib/types/projection.js
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function snapshotFromMeta(meta) {
	if (!isRecord(meta)) return null;
	if (Array.isArray(meta.results) && typeof meta.metricName === "string") return meta;
	if (meta.snapshot) return snapshotFromMeta(meta.snapshot);
	return null;
}
/** Identity schema: host registry requires `.parse`; values are already JSON snapshots. */
const autoresearchProjectionSchema = { parse(value) {
	if (value == null) return null;
	return snapshotFromMeta(value);
} };
const autoresearchProjectionStateSchema = { parse(value) {
	if (!isRecord(value)) throw new Error("autoresearch projection state must be an object");
	const snapshot = autoresearchProjectionSchema.parse(value.snapshot);
	if (!isRecord(value.pendingCommands)) throw new Error("autoresearch pending commands must be an object");
	if (typeof value.boardReady !== "boolean") throw new Error("autoresearch boardReady must be a boolean");
	const pendingCommands = {};
	for (const [id, args] of Object.entries(value.pendingCommands)) {
		if (typeof args !== "string") throw new Error(`autoresearch pending command ${id} must be a string`);
		pendingCommands[id] = args;
	}
	return {
		snapshot,
		pendingCommands,
		boardReady: value.boardReady
	};
} };
function initialAutoresearchProjectionState() {
	return {
		snapshot: null,
		pendingCommands: {},
		boardReady: false
	};
}
function ledgerLength(snapshot) {
	return snapshot?.results?.length ?? 0;
}
/** Keep the longer ledger; equal length prefers the later `updatedAt`. */
function longerSnapshot(current, next) {
	if (!next) return current ?? null;
	if (!current) return next;
	const nextEpoch = next.sessionEpoch ?? 0;
	const currentEpoch = current.sessionEpoch ?? 0;
	if (nextEpoch > currentEpoch) return next;
	if (nextEpoch < currentEpoch) return current;
	const nextSegment = next.currentSegment ?? next.results.at(-1)?.segment ?? 0;
	const currentSegment = current.currentSegment ?? current.results.at(-1)?.segment ?? 0;
	if (nextSegment > currentSegment) return next;
	if (nextSegment < currentSegment) return current;
	const nextLen = ledgerLength(next);
	const currentLen = ledgerLength(current);
	if (nextLen > currentLen) return next;
	if (nextLen < currentLen) return current;
	if ((next.updatedAt ?? 0) >= (current.updatedAt ?? 0)) return next;
	return current;
}
/**
* Host session projection fold. Later tool/result metas with a longer ledger
* replace earlier ones so the GUI can follow .auto/log.jsonl without polling
* /autoresearch status into the transcript.
*/
function foldAutoresearchSnapshot(state, event) {
	if (event.type === "autoresearch/state") return snapshotFromMeta(event.data) ?? state;
	if (event.type === "tool/result") {
		const snapshot = snapshotFromMeta(isRecord(event.data) ? event.data.meta : void 0);
		if (!snapshot) return state;
		const next = longerSnapshot(state, snapshot);
		return next === state ? state : next;
	}
	return state;
}
function commandData(event) {
	return isRecord(event.data) ? event.data : null;
}
function containsLoggedMarker(value) {
	if (typeof value === "string") return /(?:^|\n)Logged #\d+:/.test(value);
	if (Array.isArray(value)) return value.some(containsLoggedMarker);
	if (!isRecord(value)) return false;
	return Object.values(value).some(containsLoggedMarker);
}
function commandStartsNewBoard(rawArgs) {
	const raw = rawArgs.trim().toLowerCase();
	if (!raw || /^(help|status|off|complete|clear|export|finalize|hooks)\b/.test(raw)) return false;
	return !/^resume\s*$/.test(raw);
}
function commandLifecycleSnapshot(snapshot, rawArgs, eventTime) {
	if (!snapshot) return null;
	const raw = rawArgs.trim();
	const lower = raw.toLowerCase();
	const updatedAt = Number.isFinite(eventTime) ? Number(eventTime) : snapshot.updatedAt + 1;
	if (!raw || /^(help|status|export|finalize|hooks)\b/.test(lower)) return snapshot;
	if (lower === "clear") return null;
	if (lower === "off") return {
		...snapshot,
		active: false,
		manualOff: true,
		loopState: "stopped",
		completionReason: "Stopped by the user.",
		completedAt: null,
		decisionQuestion: null,
		pendingContinuation: false,
		updatedAt
	};
	if (lower === "complete" || lower.startsWith("complete ")) return {
		...snapshot,
		active: false,
		manualOff: false,
		loopState: "completed",
		completionReason: raw.slice(8).trim() || "The verified goal is complete.",
		completedAt: updatedAt,
		decisionQuestion: null,
		pendingContinuation: false,
		updatedAt
	};
	if (/^resume\s*$/.test(lower)) return {
		...snapshot,
		active: true,
		manualOff: false,
		loopState: "active",
		completionReason: null,
		completedAt: null,
		decisionQuestion: null,
		pendingContinuation: false,
		updatedAt
	};
	const goal = raw.replace(/^start\s*/i, "").trim();
	if (!goal) return snapshot;
	return {
		...snapshot,
		active: true,
		manualOff: false,
		loopState: "active",
		completionReason: null,
		completedAt: null,
		decisionQuestion: null,
		pendingContinuation: false,
		pendingNewGoal: true,
		goal,
		sessionEpoch: snapshot.sessionEpoch + 1,
		currentSegment: snapshot.currentSegment + 1,
		currentSegmentRuns: 0,
		baselineMetric: null,
		bestKeptMetric: null,
		lastStatus: null,
		updatedAt
	};
}
/**
* External plugins cannot add required custom event types to DSH's closed
* persistence vocabulary. Fold official command lifecycle events instead;
* legacy autoresearch/state records remain readable only after the migration
* marks their envelopes ignorable.
*/
function foldAutoresearchProjection(state, event) {
	const snapshot = foldAutoresearchSnapshot(state.snapshot, event);
	if (snapshot !== state.snapshot) {
		const legacyBoard = event.type === "autoresearch/state" && (snapshot?.results.length ?? 0) > 0;
		const loggedBoard = event.type === "tool/result" && containsLoggedMarker(commandData(event)?.message);
		return {
			...state,
			snapshot,
			boardReady: state.boardReady || legacyBoard || loggedBoard
		};
	}
	const data = commandData(event);
	if (event.type === "command/run" && data?.name === "autoresearch" && typeof data.commandId === "string") {
		const args = typeof data.args === "string" ? data.args : "";
		return {
			snapshot: state.snapshot,
			pendingCommands: {
				...state.pendingCommands,
				[data.commandId]: args
			},
			boardReady: state.boardReady
		};
	}
	if (event.type !== "command/done" || typeof data?.commandId !== "string") return state;
	const rawArgs = state.pendingCommands[data.commandId];
	if (rawArgs === void 0) return state;
	const pendingCommands = { ...state.pendingCommands };
	delete pendingCommands[data.commandId];
	return {
		snapshot: data.kind === "success" ? commandLifecycleSnapshot(state.snapshot, rawArgs, event.time) : state.snapshot,
		pendingCommands,
		boardReady: data.kind === "success" && (rawArgs.trim().toLowerCase() === "clear" || commandStartsNewBoard(rawArgs)) ? false : state.boardReady
	};
}
//#endregion
//#region lib/types/index.js
/**
* DeepSeek Harness host plugin: durable auto-research experiment loop.
* Named `apply` only — no default export (dshx function/client contract).
*/
const name = "dsh-autoresearch";
const inject = ["tools", "sessionPersistence"];
const NS = "autoresearch";
const Config = z.object({
	maxIterations: z.number().step(1).min(0).default(20),
	maxAutoResumeTurns: z.number().step(1).min(0).default(20),
	hintsEnabled: z.boolean().default(false)
});
const MARKER = "[dsh-autoresearch] loaded";
const controllers = /* @__PURE__ */ new Map();
function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function portableWorkspacePath(cwd, changedPath) {
	if (typeof changedPath !== "string" || !changedPath.trim()) return null;
	const absolute = path.resolve(cwd, changedPath);
	const relative = path.relative(cwd, absolute);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
	const portable = relative.split(path.sep).join("/");
	if (portable === ".git" || portable.startsWith(".git/")) return null;
	if (portable === ".auto" || portable.startsWith(".auto/")) return null;
	return portable;
}
/** Extract file targets before a mutating tool runs, so protection is lazy and exact. */
function mutationPathsFromToolCall(name, rawArgs, cwd) {
	const toolName = String(name || "").toLowerCase();
	if (!/(?:^|_)(?:write|edit|search_replace|replace|apply_patch|delete|remove|move|rename)(?:_|$)/.test(toolName)) return [];
	let args = record(rawArgs);
	if (!args && typeof rawArgs === "string") try {
		args = record(JSON.parse(rawArgs));
	} catch {}
	const selected = /* @__PURE__ */ new Set();
	const add = (value) => {
		if (Array.isArray(value)) {
			for (const item of value) add(item);
			return;
		}
		const portable = portableWorkspacePath(cwd, value);
		if (portable) selected.add(portable);
	};
	for (const key of [
		"file_path",
		"filePath",
		"path",
		"paths",
		"old_path",
		"new_path",
		"source_path",
		"destination_path"
	]) add(args?.[key]);
	const patchText = String(args?.patch ?? args?.input ?? (typeof rawArgs === "string" ? rawArgs : ""));
	for (const match of patchText.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) add(match[1].trim());
	for (const match of patchText.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)) add(match[1].trim());
	return [...selected];
}
/**
* Find files this conversation already changed so an umbrella workspace can
* receive narrow local version protection without staging sibling projects.
*/
function protectedPathsFromSession(session, cwd) {
	const selected = /* @__PURE__ */ new Set();
	const addPath = (changedPath) => {
		if (typeof changedPath !== "string" || !changedPath.trim()) return false;
		const absolute = path.resolve(cwd, changedPath);
		const relative = path.relative(cwd, absolute);
		if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
		selected.add(relative.split(path.sep).join("/"));
		return selected.size >= 256;
	};
	for (const rawEvent of session?.events ?? []) {
		const event = record(rawEvent);
		if (event?.type === "tool/call") {
			const data = record(event.data);
			for (const changedPath of mutationPathsFromToolCall(String(data?.name ?? ""), data?.arguments, cwd)) if (addPath(changedPath)) return [...selected];
			continue;
		}
		if (event?.type !== "tool/result") continue;
		const data = record(event.data);
		const message = record(data?.message);
		const meta = record(data?.meta) ?? record(message?.meta);
		const diffs = Array.isArray(meta?.diffs) ? meta.diffs : [];
		for (const rawDiff of diffs) {
			const changedPath = record(rawDiff)?.path;
			if (addPath(changedPath)) return [...selected];
		}
	}
	return [...selected];
}
function workspaceOf(agent) {
	const cwd = agent?.session?.header?.cwd;
	return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}
function controllerFor(cwd) {
	const key = cwd;
	const existing = controllers.get(key);
	if (existing) return existing;
	const created = new AutoresearchController({ cwd });
	controllers.set(key, created);
	return created;
}
function createAutoresearchFollowupMessage(text) {
	return createUserMessage({
		content: [{
			type: "text",
			text
		}],
		source: {
			kind: "plugin",
			plugin: name,
			form: "instructions"
		}
	});
}
function withSnapshot(controller, result) {
	const snapshot = toJsonValue(controller.snapshot());
	return toJsonValue({
		...result,
		snapshot,
		text: String(result.text ?? "")
	});
}
function toolOutput() {
	return {
		schema: { type: "json" },
		render: (_args, value) => [{
			type: "text",
			text: value.text
		}],
		presentationMeta: (_args, value) => value.snapshot ? { snapshot: value.snapshot } : {}
	};
}
function queueAutoresearchFollowup(agent, text) {
	if (!agent?.followup) return;
	agent.followup(createAutoresearchFollowupMessage(text));
}
function playbookFor(result) {
	if (!result.needsSetup) return CONTINUE_PLAYBOOK;
	const goal = result.snapshot?.goal?.trim();
	return goal ? `${CREATE_PLAYBOOK}\n\nCurrent explicit goal: ${goal}` : CREATE_PLAYBOOK;
}
function isActivating(args) {
	const command = args.trim().toLowerCase();
	if (!command) return false;
	if (/^(help|status|off|complete|clear|export|finalize|hooks)\b/.test(command)) return false;
	return true;
}
function enableAllowNoGit(controller, raw) {
	if (!/\ballow[- ]?no[- ]?git\b/i.test(raw)) return;
	const configPath = sessionFilePath(controller.cwd, "config");
	ensureParentDir(configPath);
	writeFileSync(configPath, `${JSON.stringify({
		...controller.config(),
		allowNoGit: true
	}, null, 2)}\n`);
}
async function apply(ctx, config) {
	const migration = await migrateLegacyAutoresearchSessions(ctx.sessionPersistence);
	if (migration.failures.length > 0) ctx.logger.warn("[dsh-autoresearch] legacy session migration deferred", migration.failures);
	console.log(MARKER);
	let source = () => config;
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, NS, Config, config, {
			setSource: (current) => {
				source = current;
			},
			onChange: () => {
				source();
			}
		});
	});
	ctx.on("tools/pre-execute", (exec, next) => {
		const cwd = workspaceOf(exec.agent);
		const controller = controllerFor(cwd);
		const pending = controller.privateState();
		const args = exec.arguments && typeof exec.arguments === "object" && !Array.isArray(exec.arguments) ? exec.arguments : void 0;
		const decision = evaluatePendingGuard({
			toolName: exec.name,
			args,
			cwd,
			pending
		});
		if (decision.decision === "deny") return {
			kind: "deny",
			reason: decision.reason
		};
		const mutationPaths = mutationPathsFromToolCall(exec.name, exec.arguments, cwd);
		if (mutationPaths.length) {
			const protectedResult = controller.protectPathsBeforeMutation(mutationPaths);
			if (!protectedResult.ok) return {
				kind: "deny",
				reason: protectedResult.text ?? "这个特殊路径需要你确认后才能修改。"
			};
		}
		return next();
	});
	const tool = (spec) => ctx.tools.register(defineTool(spec));
	tool({
		name: "autoresearch_control",
		description: "Handle an explicit /autoresearch command: start/resume a goal, show help/status, stop, or clear. Ordinary user prompts must never call this tool to activate a loop.",
		parameters: { args: {
			type: "string",
			description: "Raw /autoresearch arguments"
		} },
		output: toolOutput(),
		async execute(args, exec) {
			const cwd = workspaceOf(exec.agent);
			const controller = controllerFor(cwd);
			const raw = String(args.args ?? "");
			enableAllowNoGit(controller, raw);
			const result = withSnapshot(controller, await controller.control({
				args: raw,
				protectedPaths: protectedPathsFromSession(exec.agent?.session, cwd)
			}));
			if (result.ok && result.active && isActivating(raw)) queueAutoresearchFollowup(exec.agent, playbookFor(result));
			return result;
		}
	});
	tool({
		name: "autoresearch_status",
		description: "Read durable autoresearch state for this workspace without activating it.",
		parameters: {},
		output: toolOutput(),
		async execute(_args, exec) {
			const controller = controllerFor(workspaceOf(exec.agent));
			return withSnapshot(controller, await controller.status());
		}
	});
	tool({
		name: "autoresearch_init_experiment",
		description: "Initialize or reinitialize an active experiment segment and append its config header.",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "Experiment name"
			},
			metric_name: {
				type: "string",
				required: true,
				description: "Primary METRIC name"
			},
			metric_unit: {
				type: "string",
				description: "Optional unit"
			},
			direction: {
				type: "string",
				enum: ["lower", "higher"],
				description: "Whether lower or higher is better"
			}
		},
		output: toolOutput(),
		async execute(args, exec) {
			const controller = controllerFor(workspaceOf(exec.agent));
			return withSnapshot(controller, await controller.initExperiment(args));
		}
	});
	tool({
		name: "autoresearch_run_experiment",
		description: "Run the stable benchmark for an active loop with timing, cancellation, METRIC parsing, and optional correctness checks. Always follow with autoresearch_log_experiment.",
		parameters: {
			command: {
				type: "string",
				required: true,
				description: "Benchmark command, usually bash .auto/measure.sh"
			},
			timeout_seconds: {
				type: "number",
				description: "Benchmark timeout in seconds"
			},
			checks_timeout_seconds: {
				type: "number",
				description: "Optional checks.sh timeout"
			}
		},
		output: toolOutput(),
		async execute(args, exec) {
			const controller = controllerFor(workspaceOf(exec.agent));
			return withSnapshot(controller, await controller.runExperiment({
				...args,
				signal: exec.signal
			}));
		}
	});
	tool({
		name: "autoresearch_log_experiment",
		description: "Durably record one actual experiment and atomically decide whether to continue, complete, or wait for the user. keep commits; discard/crash/checks_failed revert while preserving .auto.",
		parameters: {
			commit: {
				type: "string",
				description: "Optional short commit hash"
			},
			metric: {
				type: "number",
				required: true,
				description: "Primary metric value"
			},
			metrics: {
				type: "json",
				description: "Secondary METRIC map"
			},
			status: {
				type: "string",
				required: true,
				enum: [
					"keep",
					"discard",
					"crash",
					"checks_failed"
				]
			},
			description: {
				type: "string",
				required: true,
				description: "What changed in this run"
			},
			asi: {
				type: "json",
				required: true,
				description: "Hypothesis and notes for the next iteration"
			},
			force: {
				type: "boolean",
				description: "Allow adding new secondary metrics"
			},
			next_action: {
				type: "string",
				required: true,
				enum: [
					"continue",
					"complete",
					"needs_user"
				],
				description: "The durable next lifecycle decision for this loop"
			},
			decision_reason: {
				type: "string",
				required: true,
				description: "Evidence-based reason for the next lifecycle decision"
			},
			user_question: {
				type: "string",
				description: "Required when next_action is needs_user; ask this exact decision question"
			}
		},
		output: toolOutput(),
		async execute(args, exec) {
			const controller = controllerFor(workspaceOf(exec.agent));
			const result = withSnapshot(controller, await controller.logExperiment(args));
			if (result.resume?.shouldSchedule) {
				queueAutoresearchFollowup(exec.agent, CONTINUE_PLAYBOOK);
				exec.concludeTurn?.();
				if (result.resume.token) try {
					controller.consumeResumeToken(result.resume.token);
				} catch {}
			}
			return result;
		}
	});
	tool({
		name: "autoresearch_finish",
		description: "Close an active autoresearch loop after later verification, or pause it for an explicit user decision. Use this before claiming completion when no new experiment is being logged.",
		parameters: {
			outcome: {
				type: "string",
				required: true,
				enum: ["complete", "needs_user"]
			},
			reason: {
				type: "string",
				required: true,
				description: "Evidence-based completion or decision reason"
			},
			user_question: {
				type: "string",
				description: "Required when outcome is needs_user"
			}
		},
		output: toolOutput(),
		async execute(args, exec) {
			const controller = controllerFor(workspaceOf(exec.agent));
			return withSnapshot(controller, await controller.finish(args));
		}
	});
	tool({
		name: "autoresearch_compaction_summary",
		description: "Build a deterministic summary from .auto artifacts so the active loop can survive context compaction.",
		parameters: {},
		output: toolOutput(),
		async execute(_args, exec) {
			const controller = controllerFor(workspaceOf(exec.agent));
			return withSnapshot(controller, {
				ok: true,
				text: buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(controller.workDir()))
			});
		}
	});
	ctx.inject(["commands"], (commandCtx) => {
		commandCtx.commands.register({
			name: "autoresearch",
			description: "Explicitly start, resume, inspect, or stop a durable autoresearch experiment loop",
			input: { hint: "<goal | resume | status | off | clear>" },
			handler: async (invocation) => {
				const cwd = workspaceOf(invocation.agent);
				const controller = controllerFor(cwd);
				const raw = invocation.rawInput;
				enableAllowNoGit(controller, raw);
				const result = withSnapshot(controller, await controller.control({
					args: raw,
					protectedPaths: protectedPathsFromSession(invocation.agent.session, cwd)
				}));
				if (result.ok && result.active && isActivating(raw)) queueAutoresearchFollowup(invocation.agent, playbookFor(result));
				return {
					kind: result.ok ? "success" : "error",
					text: result.text
				};
			}
		});
	});
	ctx.inject(["systemPrompt"], (promptCtx) => {
		promptCtx.systemPrompt.section({
			name: "tool:autoresearch",
			order: 118,
			text: (assemble) => {
				const state = controllerFor(workspaceOf(assemble.agent)).privateState();
				if (state.loopState === "awaiting_user") return [
					"Autoresearch is paused for an explicit user decision.",
					`Question: ${state.decisionQuestion ?? "Ask the user whether to continue or complete."}`,
					`Reason: ${state.completionReason ?? "Further progress requires user judgment."}`,
					"Use the host decision-question UI. If the user chooses to continue, run /autoresearch resume. If the user chooses to stop, call autoresearch_finish with outcome=complete before the final answer."
				].join("\n");
				if (state.active !== true || state.manualOff === true) return "";
				return state.pendingNewGoal && state.goal ? `${CREATE_PLAYBOOK}\n\nCurrent explicit goal: ${state.goal}` : CREATE_PLAYBOOK;
			}
		});
	});
	ctx.inject(["skills"], (skillCtx) => {
		const bodies = skillBodies();
		skillCtx.skills.register({
			name: "autoresearch-create",
			description: "Supporting setup playbook for an explicitly activated /autoresearch loop. Never activates autoresearch by itself.",
			source: "runtime",
			content: bodies.create,
			invocation: {
				modelInvocable: false,
				userInvocable: false
			}
		});
		if (bodies.finalize) skillCtx.skills.register({
			name: "autoresearch-finalize",
			description: "Finalize an autoresearch session into clean, reviewable branches.",
			source: "runtime",
			content: bodies.finalize,
			invocation: {
				modelInvocable: false,
				userInvocable: false
			}
		});
		if (bodies.hooks) skillCtx.skills.register({
			name: "autoresearch-hooks",
			description: "Author before/after hooks for an autoresearch session.",
			source: "runtime",
			content: bodies.hooks,
			invocation: {
				modelInvocable: false,
				userInvocable: false
			}
		});
	});
	ctx.inject(["sessionProjections"], (projectionCtx) => {
		projectionCtx.sessionProjections.register({
			key: "autoresearch",
			stateSchema: autoresearchProjectionStateSchema,
			init: initialAutoresearchProjectionState,
			apply: (state, event) => {
				return foldAutoresearchProjection(state, event);
			},
			wire: {
				viewSchema: autoresearchProjectionSchema,
				view: (state) => state.snapshot ? {
					...state.snapshot,
					boardReady: state.boardReady
				} : null
			},
			stateVersion: 6
		});
	});
}
//#endregion
export { Config, NS, apply, createAutoresearchFollowupMessage, inject, mutationPathsFromToolCall, name, protectedPathsFromSession, queueAutoresearchFollowup };
