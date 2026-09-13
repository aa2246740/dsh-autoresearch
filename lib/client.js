window.__ModuleLoader__.load({
	id: "dsh-autoresearch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_dom = require("react-dom");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/types.ts
		const STATE_MARKER = "AUTORESEARCH_STATE_V1";
		function parseEmbeddedState(text) {
			const idx = text.lastIndexOf(STATE_MARKER);
			if (idx < 0) return { text };
			const json = text.slice(idx + 21).trim();
			try {
				return {
					text: text.slice(0, idx).trim(),
					snapshot: JSON.parse(json)
				};
			} catch {
				return { text };
			}
		}
		//#endregion
		//#region src/projection.ts
		function isRecord$1(value) {
			return value !== null && typeof value === "object" && !Array.isArray(value);
		}
		function snapshotFromMeta(meta) {
			if (!isRecord$1(meta)) return null;
			if (Array.isArray(meta.results) && typeof meta.metricName === "string") return meta;
			if (meta.snapshot) return snapshotFromMeta(meta.snapshot);
			return null;
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
		* Upgrade a conversation log snapshot with a longer projected ledger.
		* Never invent a progress board from projection alone (status/init leftovers).
		*/
		function preferLedgerSnapshot(conversation, projected) {
			if (ledgerLength(conversation) === 0) return conversation ?? null;
			if (!projected) return conversation ?? null;
			const terminal = projected.loopState === "completed" || projected.loopState === "stopped" || projected.loopState === "blocked";
			const projectedSegment = projected.currentSegment ?? projected.results.at(-1)?.segment ?? 0;
			const projectedCurrentRuns = projected.results.filter((run) => run.segment === projectedSegment).length;
			if (conversation && terminal && projectedCurrentRuns === 0) return {
				...conversation,
				active: false,
				manualOff: projected.manualOff,
				loopState: projected.loopState,
				completionReason: projected.completionReason,
				completedAt: projected.completedAt,
				decisionQuestion: null,
				pendingContinuation: false,
				updatedAt: Math.max(conversation.updatedAt, projected.updatedAt)
			};
			if (conversation?.name && projected?.name && conversation.name !== projected.name) {
				if ((projected.sessionEpoch ?? 0) <= (conversation.sessionEpoch ?? 0)) return conversation;
			}
			return longerSnapshot(conversation, projected);
		}
		//#endregion
		//#region src/client/dashboard.ts
		const RUN_TOOL = "autoresearch_run_experiment";
		const LOG_TOOL = "autoresearch_log_experiment";
		const RECENT_ROWS = 3;
		function isRecord(value) {
			return value !== null && typeof value === "object" && !Array.isArray(value);
		}
		function currentSegmentOf(results) {
			return results.at(-1)?.segment ?? 0;
		}
		function currentResults(results, segmentOverride) {
			const segment = segmentOverride ?? currentSegmentOf(results);
			return results.filter((run) => run.segment === segment);
		}
		function isBetter(current, best, direction) {
			return direction === "lower" ? current < best : current > best;
		}
		function median(values) {
			if (values.length === 0) return 0;
			const sorted = [...values].sort((a, b) => a - b);
			const middle = Math.floor(sorted.length / 2);
			return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
		}
		/** MAD-based confidence; null below 3 points — same rule as pi-autoresearch. */
		function confidenceFor(results, direction) {
			const current = currentResults(results).filter((run) => run.metric > 0);
			if (current.length < 3) return null;
			const values = current.map((run) => run.metric);
			const center = median(values);
			const mad = median(values.map((value) => Math.abs(value - center)));
			if (mad === 0) return null;
			const baseline = current[0]?.metric;
			const kept = current.filter((run) => run.status === "keep");
			if (!baseline || kept.length === 0) return null;
			const best = kept.reduce((value, run) => isBetter(run.metric, value, direction) ? run.metric : value, kept[0].metric);
			if (best === baseline) return null;
			return Math.abs(best - baseline) / mad;
		}
		function formatNum(value, unit = "") {
			if (value === null || value === void 0 || !Number.isFinite(value)) return "—";
			const raw = value === Math.round(value) ? String(value) : value.toFixed(2);
			if (!unit) return raw;
			return `${raw}${unit.length <= 2 ? "" : " "}${unit}`;
		}
		function formatDeltaPct(pct) {
			if (pct === null || !Number.isFinite(pct)) return null;
			return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
		}
		function progressCardKind(input) {
			if ((input.results?.length ?? 0) > 0) return "board";
			if (input.runningExperiment || input.hasRunStarted) return "running";
			return "none";
		}
		function shortCommit(status, commit) {
			if (status !== "keep") return "—";
			const trimmed = String(commit || "").trim();
			return trimmed ? trimmed.slice(0, 7) : "—";
		}
		function deltaPct(value, baseline) {
			if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0 || value === baseline) return null;
			return (value - baseline) / baseline * 100;
		}
		function secondaryNames(results, metricName) {
			const names = [];
			const seen = /* @__PURE__ */ new Set();
			for (const run of results) for (const name of Object.keys(run.metrics ?? {})) {
				if (name === metricName || seen.has(name)) continue;
				seen.add(name);
				names.push(name);
			}
			return names;
		}
		function buildDashboardModel(snapshot, opts = {}) {
			const results = snapshot.results ?? [];
			const current = currentResults(results, snapshot.currentSegment);
			const keptRuns = current.filter((run) => run.status === "keep");
			const discarded = current.filter((run) => run.status === "discard").length;
			const crashed = current.filter((run) => run.status === "crash").length;
			const checksFailed = current.filter((run) => run.status === "checks_failed").length;
			const direction = snapshot.direction ?? "lower";
			const unit = snapshot.metricUnit ?? "";
			const metricName = snapshot.metricName || "metric";
			const baselineRun = current[0] ?? null;
			const baselineValue = baselineRun?.metric ?? snapshot.baselineMetric;
			const baselineIndex = results.findIndex((run) => run.segment === (baselineRun?.segment ?? currentSegmentOf(results)));
			const baselineNumber = baselineRun ? baselineRun.run || baselineIndex + 1 : 0;
			let best = null;
			for (const run of keptRuns) if (best === null || isBetter(run.metric, best.metric, direction)) best = run;
			const secondaries = [];
			if (best) for (const name of secondaryNames(current, metricName)) {
				const value = best.metrics?.[name];
				if (value === void 0) continue;
				const baselineSec = baselineRun?.metrics?.[name];
				secondaries.push({
					name,
					value: formatNum(value, name.endsWith("_ms") ? "ms" : ""),
					deltaPct: baselineSec === void 0 ? null : deltaPct(value, baselineSec)
				});
			}
			const allRows = current.map((run) => ({
				run: run.run,
				commit: shortCommit(run.status, run.commit),
				metric: formatNum(run.metric, unit),
				status: run.status,
				description: String(run.description || run.asi?.hypothesis || "").trim() || "—"
			}));
			const rows = allRows.slice(Math.max(0, allRows.length - RECENT_ROWS));
			return {
				title: snapshot.name ? `autoresearch: ${snapshot.name}` : "autoresearch",
				name: snapshot.name,
				runs: current.length,
				kept: keptRuns.length,
				discarded,
				crashed,
				checksFailed,
				conf: confidenceFor(current, direction),
				metricName,
				baseline: baselineRun && baselineValue !== null && baselineValue !== void 0 ? {
					value: formatNum(baselineValue, unit),
					run: baselineNumber
				} : null,
				progress: best ? {
					value: formatNum(best.metric, unit),
					run: best.run,
					deltaPct: baselineValue === null || baselineValue === void 0 ? null : deltaPct(best.metric, baselineValue),
					improved: baselineValue === null || baselineValue === void 0 || best.metric === baselineValue ? null : isBetter(best.metric, baselineValue, direction)
				} : null,
				secondaries,
				allRows,
				rows,
				running: opts.running === true,
				runningCommand: opts.runningCommand ?? null,
				lifecycle: snapshot.loopState === "completed" ? "completed" : snapshot.loopState === "awaiting_user" ? "awaiting_user" : snapshot.loopState === "stopped" || snapshot.loopState === "blocked" ? "stopped" : snapshot.active ? "running" : "ended"
			};
		}
		function snapshotFromUnknown(value) {
			if (!isRecord(value)) return null;
			if (Array.isArray(value.results) && typeof value.metricName === "string") return value;
			if (value.snapshot) return snapshotFromUnknown(value.snapshot);
			return null;
		}
		function textFromContent(content) {
			if (!Array.isArray(content)) return typeof content === "string" ? content : "";
			return content.map((block) => isRecord(block) && typeof block.text === "string" ? block.text : "").filter(Boolean).join("\n");
		}
		function snapshotFromNode(node) {
			return snapshotFromUnknown(node.meta) ?? parseEmbeddedState(textFromContent(node.content)).snapshot ?? null;
		}
		function toolNameOf(node) {
			if (isRecord(node.call) && typeof node.call.name === "string") return node.call.name;
			if (typeof node.name === "string") return node.name;
			return "";
		}
		function commandFromArgsRaw(raw) {
			if (!raw) return null;
			try {
				const parsed = JSON.parse(raw);
				if (isRecord(parsed) && typeof parsed.command === "string") return parsed.command;
			} catch {}
			return raw;
		}
		function visitRecord(node, visit, seen) {
			if (seen.has(node)) return;
			seen.add(node);
			visit(node);
			for (const value of Object.values(node)) if (Array.isArray(value)) walkNodes(value, visit, seen);
			else if (isRecord(value) && value !== node.meta && value !== node.snapshot) walkNodes([value], visit, seen);
		}
		function walkNodes(nodes, visit, seen = /* @__PURE__ */ new Set()) {
			for (const item of nodes) {
				if (!isRecord(item)) continue;
				visitRecord(item, visit, seen);
			}
		}
		function conversationNodes(conv) {
			if (!conv || typeof conv !== "object") return [];
			const rec = conv;
			const out = [];
			const push = (value) => {
				if (Array.isArray(value)) out.push(...value);
			};
			push(rec.nodes);
			if (isRecord(rec.chat)) {
				if (isRecord(rec.chat.legacy)) push(rec.chat.legacy.nodes);
				const store = rec.chat.nodes;
				if (store && typeof store.values === "function") try {
					push(store.values());
				} catch {}
			}
			return out;
		}
		function isRunExperimentName(name) {
			return name === RUN_TOOL || name.endsWith("run_experiment");
		}
		function isLogExperimentNode(node, name) {
			if (name === LOG_TOOL || name.endsWith("log_experiment")) return true;
			return node.kind === "tool-result" && /Logged #\d+/.test(textFromContent(node.content));
		}
		/**
		* Progress comes from this conversation's run/log tools, not from /autoresearch status.
		* init_experiment alone (empty ledger) stays kind 'none'.
		* Longer log_experiment snapshots win, including when a shorter one is nested later.
		*/
		function inspectConversation(conv) {
			const runningCall = (conv?.runningCalls ?? []).find((call) => call.name === RUN_TOOL);
			const runningExperiment = Boolean(runningCall);
			const runningCommand = commandFromArgsRaw(runningCall?.argsRaw);
			let hasRunStarted = runningExperiment;
			let logSnapshot = null;
			walkNodes(conversationNodes(conv), (node) => {
				const name = toolNameOf(node);
				if (!(node.kind === "tool-result" || name.startsWith("autoresearch_")) && !isRunExperimentName(name) && !isLogExperimentNode(node, name)) return;
				if (isRunExperimentName(name)) hasRunStarted = true;
				const snapshot = snapshotFromNode(node);
				if (snapshot && isLogExperimentNode(node, name)) logSnapshot = longerSnapshot(logSnapshot, snapshot);
			});
			return {
				kind: progressCardKind({
					results: logSnapshot?.results,
					runningExperiment,
					hasRunStarted
				}),
				snapshot: logSnapshot,
				runningCommand,
				hasRunStarted,
				runningExperiment
			};
		}
		//#endregion
		//#region src/client/store.ts
		const READ_RECEIPT_PREFIX = "dsh-autoresearch.read.v1";
		const emptyDraft = () => ({
			goal: "",
			maxRuns: "3"
		});
		let state = {
			dock: "hidden",
			page: "create",
			phase: "idle",
			sessionId: null,
			snapshot: null,
			draft: emptyDraft(),
			error: null,
			busy: false,
			notice: null,
			supersededProgressKey: null,
			commandAck: null
		};
		const listeners = /* @__PURE__ */ new Set();
		function emit() {
			for (const listener of listeners) listener();
		}
		function getLabState() {
			return state;
		}
		function subscribeLab(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
		function patchLab(patch) {
			state = {
				...state,
				...patch
			};
			emit();
		}
		/** `/autoresearch` or slash 「新开」: show the init card. Does not activate the loop. */
		function showInitDock() {
			patchLab({
				dock: "init",
				page: "create",
				phase: "configuring",
				draft: emptyDraft(),
				error: null,
				busy: false,
				supersededProgressKey: null,
				commandAck: null
			});
		}
		/**
		* After 「确认并开始」: send the slash line, then leave the progress UI closed.
		* The agent may still ask about requirements; the board appears only after run/log.
		*/
		function hideAfterConfirm(previousProgressKey = null) {
			patchLab({
				dock: "waiting",
				page: "create",
				phase: "idle",
				busy: false,
				error: null,
				supersededProgressKey: previousProgressKey
			});
		}
		/** Hide the init/waiting dock. Progress cards are conversation-driven and ignore this. */
		function cancelInitDock() {
			if (state.dock !== "init" && state.dock !== "waiting") return;
			patchLab({
				dock: "hidden",
				page: "create",
				phase: "idle",
				error: null,
				supersededProgressKey: null
			});
		}
		function rememberSession(sessionId) {
			if (state.sessionId === sessionId) return;
			patchLab({
				sessionId,
				supersededProgressKey: null,
				commandAck: null
			});
		}
		/**
		* The client command service emits this exact Host result after a local slash
		* submission settles. It bridges the short gap before a cold read/projection
		* refresh; durable truth remains in command/done and the controller sidecar.
		*/
		function recordCommandAcknowledgement(sessionId, text) {
			const completed = /^Autoresearch completed:\s*(.*)$/s.exec(text);
			if (completed) {
				patchLab({ commandAck: {
					sessionId,
					kind: "completed",
					reason: completed[1]?.trim() || "The verified goal is complete.",
					at: Date.now()
				} });
				return;
			}
			if (text === "Autoresearch is off. Any pending automatic continuation was cancelled.") {
				patchLab({ commandAck: {
					sessionId,
					kind: "stopped",
					reason: "Stopped by the user.",
					at: Date.now()
				} });
				return;
			}
			if (text === "Autoresearch log cleared and automatic continuation stopped.") {
				patchLab({ commandAck: {
					sessionId,
					kind: "idle",
					reason: null,
					at: Date.now()
				} });
				return;
			}
			if (text.startsWith("Autoresearch is active.")) patchLab({ commandAck: null });
		}
		function applyCommandAcknowledgement(snapshot, ack, sessionId) {
			if (!snapshot || !ack || ack.sessionId !== sessionId) return snapshot;
			if (ack.kind === "idle") return null;
			return {
				...snapshot,
				active: false,
				manualOff: ack.kind === "stopped",
				loopState: ack.kind,
				completionReason: ack.reason,
				completedAt: ack.kind === "completed" ? ack.at : null,
				decisionQuestion: null,
				pendingContinuation: false,
				updatedAt: Math.max(snapshot.updatedAt, ack.at)
			};
		}
		function progressIdentity(snapshot) {
			const segment = snapshot.currentSegment ?? snapshot.results.at(-1)?.segment ?? 0;
			const epoch = snapshot.sessionEpoch ?? 0;
			return [
				snapshot.workDir,
				epoch,
				segment,
				snapshot.name ?? snapshot.goal ?? "autoresearch"
			].join("::");
		}
		/**
		* A read receipt belongs to one durable completion, not merely to the project.
		* `completedAt` is authoritative for current logs; `updatedAt` keeps imported
		* legacy completions distinguishable without making ordinary UI reads mutable.
		*/
		function completionIdentity(snapshot) {
			const completedAt = snapshot.completedAt ?? snapshot.updatedAt ?? 0;
			return `${progressIdentity(snapshot)}::completed@${completedAt}`;
		}
		function completionReceiptKey(sessionId) {
			return `${READ_RECEIPT_PREFIX}:${sessionId}`;
		}
		function browserReadReceiptStorage() {
			try {
				return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
			} catch {
				return null;
			}
		}
		function isCompletionUnread(sessionId, snapshot, storage = browserReadReceiptStorage()) {
			if (!storage) return true;
			try {
				return storage.getItem(completionReceiptKey(sessionId)) !== completionIdentity(snapshot);
			} catch {
				return true;
			}
		}
		function markCompletionRead(sessionId, snapshot, storage = browserReadReceiptStorage()) {
			const identity = completionIdentity(snapshot);
			try {
				storage?.setItem(completionReceiptKey(sessionId), identity);
			} catch {}
			return identity;
		}
		/**
		* Legacy parser for old logs that still carry AUTORESEARCH_STATE_V1.
		* Must not open a progress dock — confirm/status/init snapshots stay off the board.
		*/
		function applyCommandText(text) {
			const parsed = parseEmbeddedState(text);
			if (parsed.snapshot) patchLab({
				snapshot: parsed.snapshot,
				error: null,
				notice: parsed.text
			});
			return parsed.snapshot;
		}
		function parseRoundBudget(raw) {
			const parsed = Number.parseInt(String(raw).trim(), 10);
			return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
		}
		/** Never expose internal process/Git failures in the beginner start card. */
		function friendlyStartError(error) {
			const raw = error instanceof Error ? error.message : String(error ?? "");
			if (/没有活动会话|请填写目标|轮次必须|项目目录不可用|特殊路径无法自动保护/.test(raw)) return raw;
			return "自动准备没有完成，但项目和会话都没有损坏。请再点一次“确认并开始”；如果仍未完成，请重新打开目标项目会话。";
		}
		/** A recoverable decision keeps the confirmation card open instead of looking successful. */
		function startDecisionMessage(text) {
			return /项目目录不可用|特殊路径无法自动保护/.test(text) ? text : null;
		}
		/**
		* Command sent only after 「确认并开始」.
		* Goal is natural language; rounds become maxIterations via `for N runs`.
		* Metric / direction / allowNoGit are not encoded — the agent infers them after confirm.
		*/
		function buildStartLine(draft) {
			return `/autoresearch ${draft.goal.trim()} for ${parseRoundBudget(draft.maxRuns) ?? 3} runs`;
		}
		//#endregion
		//#region src/client/index.tsx
		const name = "dsh-autoresearch-client";
		const inject = [
			"slots",
			"sessions",
			"remote",
			"remote.commands",
			"settingsScope",
			"commandUi"
		];
		const colors = {
			bg: "var(--dsw-alias-bg-layer-1, Canvas)",
			panel: "color-mix(in srgb, var(--dsw-alias-label-primary, CanvasText) 2.5%, var(--dsw-alias-bg-layer-1, Canvas))",
			subtle: "color-mix(in srgb, var(--dsw-alias-label-primary, CanvasText) 6.5%, var(--dsw-alias-bg-layer-1, Canvas))",
			text: "var(--dsw-alias-label-primary, CanvasText)",
			muted: "var(--dsw-alias-label-secondary, GrayText)",
			line: "var(--dsw-alias-border-l1, var(--dsw-alias-border-l2, ButtonBorder))",
			lineStrong: "color-mix(in srgb, var(--dsw-alias-label-primary, CanvasText) 18%, transparent)",
			good: "var(--dsw-alias-text-success, var(--dsw-alias-state-success-primary, #1a7f37))",
			bad: "var(--dsw-alias-text-danger, var(--dsw-alias-state-error-primary, #cf222e))",
			accent: "var(--dsw-alias-button-primary-fill, var(--dsw-alias-state-business-primary, #2f6fed))",
			onAccent: "var(--dsw-alias-label-primary-foreground, #ffffff)",
			warn: "var(--dsw-alias-state-warn-label, #9a6700)"
		};
		const font = {
			fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
			color: colors.text
		};
		const dockShell = {
			...font,
			boxSizing: "border-box",
			width: "calc(100% - var(--dsh-composer-side-clearance, 0px) * 2 - var(--dsh-composer-dock-inset, 0px) * 4)",
			maxWidth: "calc(var(--dsh-composer-card-max-width, 960px) - var(--dsh-composer-dock-inset, 0px) * 2)",
			margin: "0 auto",
			border: `1px solid ${colors.lineStrong}`,
			borderRadius: 14,
			background: colors.panel,
			padding: 16
		};
		const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
		const tabular = {
			fontVariantNumeric: "tabular-nums",
			fontFeatureSettings: "\"tnum\" 1"
		};
		const PANEL_GAP = 8;
		const PANEL_MARGIN = 12;
		const UNPLACED_PANEL_STYLE = {
			visibility: "hidden",
			left: 0,
			top: 0
		};
		const clientStyles = `
  @keyframes dsh-ar-spin { to { transform: rotate(360deg); } }
  @keyframes dsh-ar-panel-enter {
    from { opacity: 0; transform: translateY(-5px) scale(.992); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .dsh-ar-header-root { position: relative; }
  .dsh-ar-trigger {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid ${colors.line};
    border-radius: 999px;
    background: transparent;
    color: ${colors.text};
    cursor: pointer;
    transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease, transform 100ms ease;
  }
  .dsh-ar-trigger:hover,
  .dsh-ar-trigger:focus-visible { background: var(--dsw-alias-interactive-bg-hover, ${colors.subtle}); }
  .dsh-ar-trigger:active { transform: scale(.96); }
  .dsh-ar-trigger:focus-visible { outline: 2px solid ${colors.accent}; outline-offset: 2px; }
  .dsh-ar-trigger[data-open] {
    border-color: var(--dsw-alias-button-ghost-active-border, ${colors.accent});
    background: var(--dsw-alias-button-ghost-active-fill, ${colors.subtle});
  }
  .dsh-ar-trigger[data-state='running'],
  .dsh-ar-trigger[data-state='ready'] { color: ${colors.accent}; }
  .dsh-ar-trigger[data-state='waiting'],
  .dsh-ar-trigger[data-state='awaiting-user'] { color: ${colors.warn}; }
  .dsh-ar-trigger[data-state='completed-unread'] { color: ${colors.good}; }
  .dsh-ar-trigger[data-state='completed-read'] { color: ${colors.text}; }
  .dsh-ar-trigger[data-state='stopped'],
  .dsh-ar-trigger[data-state='ended'] { color: ${colors.muted}; }
  .dsh-ar-menu {
    position: fixed;
    z-index: 1100;
    box-sizing: border-box;
    width: min(420px, calc(100vw - 24px));
    max-width: calc(100vw - 24px);
    max-height: min(540px, calc(100vh - 24px));
    overflow: hidden;
    border: 1px solid ${colors.lineStrong};
    border-radius: 14px;
    background: ${colors.panel};
    box-shadow: var(--dsw-shadow-lv3, 0 12px 32px color-mix(in srgb, CanvasText 14%, transparent));
    color: ${colors.text};
    transform-origin: top right;
    animation: dsh-ar-panel-enter 180ms cubic-bezier(.2, .8, .2, 1);
    isolation: isolate;
  }
  .dsh-ar-panel-scroll {
    box-sizing: border-box;
    max-height: min(540px, calc(100vh - 24px));
    overflow: auto;
    padding: 20px 20px 14px;
    overscroll-behavior: contain;
  }
  .dsh-ar-compact-panel { min-height: 56px; display: flex; align-items: center; }
  .dsh-ar-button:hover:not(:disabled) { filter: brightness(0.97); }
  .dsh-ar-button:active:not(:disabled) { filter: brightness(0.93); }
  .dsh-ar-button:focus-visible { outline: 2px solid ${colors.accent}; outline-offset: 2px; }
  .dsh-ar-history-row {
    border-top: 1px solid ${colors.line};
  }
  .dsh-ar-history-row:first-child { border-top: 0; }
  .dsh-ar-history-summary {
    box-sizing: border-box;
    width: 100%;
    min-height: 44px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto 14px;
    align-items: start;
    column-gap: 8px;
    row-gap: 5px;
    padding: 11px 0 12px;
    border: 0;
    background: transparent;
    color: ${colors.text};
    text-align: left;
    cursor: pointer;
    font: inherit;
  }
  .dsh-ar-history-summary:hover .dsh-ar-history-chevron { color: ${colors.text}; }
  .dsh-ar-history-summary:focus-visible,
  .dsh-ar-history-list-toggle:focus-visible {
    outline: 2px solid ${colors.accent};
    outline-offset: 2px;
    border-radius: 6px;
  }
  .dsh-ar-history-preview {
    grid-column: 1 / -1;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
    overflow: hidden;
    color: ${colors.muted};
    font-size: 13px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .dsh-ar-history-chevron {
    align-self: center;
    justify-self: end;
    width: 14px;
    height: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: ${colors.muted};
  }
  .dsh-ar-history-detail {
    padding: 0 0 14px;
    color: ${colors.text};
    font-size: 13px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .dsh-ar-history-list-toggle {
    min-width: 44px;
    min-height: 32px;
    margin: -6px -4px -6px 0;
    padding: 0 4px;
    border: 0;
    background: transparent;
    color: ${colors.muted};
    cursor: pointer;
    font: inherit;
    font-size: 11px;
  }
  @media (max-width: 640px) {
    .dsh-ar-panel-scroll { padding: 18px 18px 12px; }
  }
  @media (prefers-reduced-motion: reduce) {
    [data-autoresearch-spinner] { animation: none !important; }
    .dsh-ar-menu { animation: none !important; }
  }
`;
		function useLab() {
			return (0, react.useSyncExternalStore)(subscribeLab, getLabState, getLabState);
		}
		async function executeLine(ctx, sessionId, line) {
			const answered = await ctx.remote.commands.execute(sessionId, line, []);
			if (!answered.ok) throw new Error(`${answered.error?.message ?? "command failed"} (${answered.error?.code ?? "error"})`);
			if (answered.value === void 0) throw new Error(`unknown command: ${line}`);
			const payload = answered.value;
			const result = payload.result ?? payload;
			const text = result.text ?? "";
			applyCommandText(text);
			if ("kind" in result && result.kind === "error") throw new Error(parseEmbeddedState(text).text || text);
			return text;
		}
		function statusColor(status) {
			if (status === "keep") return colors.good;
			if (status === "discard") return colors.warn;
			return colors.bad;
		}
		function LabButton(props) {
			const kind = props.kind ?? "ghost";
			const background = kind === "primary" ? colors.accent : "transparent";
			const color = kind === "primary" ? colors.onAccent : kind === "danger" ? colors.bad : colors.text;
			const border = kind === "primary" ? colors.accent : kind === "danger" ? colors.bad : colors.line;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				className: "dsh-ar-button",
				type: props.type ?? "button",
				"aria-label": props.ariaLabel,
				disabled: props.disabled,
				onClick: props.onClick,
				style: {
					...font,
					background,
					color,
					border: `1px solid ${border}`,
					borderRadius: 8,
					minHeight: 44,
					padding: "0 14px",
					cursor: props.disabled ? "not-allowed" : "pointer",
					opacity: props.disabled ? .55 : 1,
					fontSize: 13
				},
				children: props.children
			});
		}
		function fieldStyle() {
			return {
				...font,
				background: colors.bg,
				border: `1px solid ${colors.line}`,
				borderRadius: 8,
				padding: 8
			};
		}
		function Spinner() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				"data-autoresearch-spinner": true,
				"aria-hidden": "true",
				style: {
					display: "inline-block",
					width: 10,
					height: 10,
					marginRight: 6,
					border: `2px solid ${colors.line}`,
					borderTopColor: colors.warn,
					borderRadius: "50%",
					animation: "dsh-ar-spin 0.8s linear infinite",
					verticalAlign: "middle"
				}
			});
		}
		function AutoresearchIcon() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: "17",
				height: "17",
				viewBox: "0 0 20 20",
				fill: "none",
				"aria-hidden": "true",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M7 2.75h6M8.25 3v4.4l-4.1 7.05A1.85 1.85 0 0 0 5.75 17h8.5a1.85 1.85 0 0 0 1.6-2.55L11.75 7.4V3",
						stroke: "currentColor",
						strokeWidth: "1.45",
						strokeLinecap: "round",
						strokeLinejoin: "round"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M6.15 12h7.7",
						stroke: "currentColor",
						strokeWidth: "1.45",
						strokeLinecap: "round"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "8.15",
						cy: "14.35",
						r: ".7",
						fill: "currentColor"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "11.65",
						cy: "13.55",
						r: ".55",
						fill: "currentColor"
					})
				]
			});
		}
		function InitDockCard({ ctx, sessionId, previousSnapshot }) {
			const lab = useLab();
			const [draft, setDraft] = (0, react.useState)(lab.draft);
			async function onConfirm(event) {
				event.preventDefault();
				if (!sessionId) {
					patchLab({ error: "没有活动会话。先打开一个对话，再 /autoresearch。" });
					return;
				}
				if (!draft.goal.trim()) {
					patchLab({ error: "请填写目标。普通聊天不会启动循环。" });
					return;
				}
				if (parseRoundBudget(draft.maxRuns) === null) {
					patchLab({ error: "轮次必须是大于 0 的整数。" });
					return;
				}
				patchLab({
					draft,
					busy: true,
					error: null
				});
				try {
					const decision = startDecisionMessage(await executeLine(ctx, sessionId, buildStartLine(draft)));
					if (decision) {
						patchLab({
							busy: false,
							error: decision
						});
						return;
					}
					hideAfterConfirm(previousSnapshot ? progressIdentity(previousSnapshot) : null);
				} catch (error) {
					patchLab({
						busy: false,
						error: friendlyStartError(error)
					});
				}
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
				"data-autoresearch": "init-card",
				onSubmit: (event) => void onConfirm(event),
				style: {
					display: "grid",
					gap: 8
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: clientStyles }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							justifyContent: "space-between",
							alignItems: "baseline",
							gap: 8
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 13,
								fontWeight: 600
							},
							children: "新开 Autoresearch"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								color: colors.muted,
								fontSize: 12
							},
							children: "确认前不会开跑"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						"data-autoresearch": "git-safety-note",
						style: {
							color: colors.muted,
							fontSize: 12
						},
						children: "首次使用会自动开启本地版本保护并保存当前状态；不会上传代码。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: {
							display: "grid",
							gap: 4,
							fontSize: 12,
							color: colors.muted
						},
						children: ["目标", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							"data-autoresearch-field": "goal",
							value: draft.goal,
							onChange: (event) => setDraft({
								...draft,
								goal: event.target.value
							}),
							rows: 4,
							placeholder: "例如：把 examples/score.py 的错误数降到 0。每次只改一个变量。",
							style: {
								...fieldStyle(),
								resize: "vertical",
								minHeight: 72,
								fontSize: 13
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "flex-end",
							gap: 8,
							flexWrap: "wrap"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: {
									display: "grid",
									gap: 4,
									fontSize: 12,
									color: colors.muted
								},
								children: ["轮次", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									"data-autoresearch-field": "rounds",
									type: "number",
									min: 1,
									step: 1,
									inputMode: "numeric",
									value: draft.maxRuns,
									onChange: (event) => setDraft({
										...draft,
										maxRuns: event.target.value
									}),
									style: {
										...fieldStyle(),
										width: 88,
										fontSize: 13
									}
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: { flex: 1 } }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabButton, {
								onClick: cancelInitDock,
								children: "取消"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabButton, {
								type: "submit",
								kind: "primary",
								disabled: lab.busy,
								children: lab.busy ? "正在启动…" : "确认并开始"
							})
						]
					}),
					lab.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							color: colors.warn,
							fontSize: 12,
							whiteSpace: "pre-wrap"
						},
						children: lab.error
					}) : null
				]
			});
		}
		function WaitingCard() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-autoresearch": "waiting-card",
				role: "status",
				style: {
					display: "flex",
					alignItems: "center",
					color: colors.muted,
					fontSize: 13,
					minHeight: 28
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: clientStyles }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Spinner, {}),
					"正在准备新目标，完成第一轮后会显示结果"
				]
			});
		}
		function RunningCard({ name, command }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-autoresearch": "running-card",
				role: "status",
				style: {
					fontSize: 13,
					color: colors.text
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: clientStyles }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Spinner, {}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { fontWeight: 600 },
						children: "正在优化"
					}),
					name ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { color: colors.muted },
						children: ` · ${name}`
					}) : null,
					command ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							...mono,
							color: colors.muted
						},
						children: ` · ${command}`
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { color: colors.muted },
						children: " · 第一轮完成后显示结果"
					})
				]
			});
		}
		function statusLabel(status) {
			if (status === "keep") return "保留";
			if (status === "discard") return "未采用";
			if (status === "crash") return "运行失败";
			return "检查未通过";
		}
		function ProgressCard({ model, snapshot, ctx, sessionId }) {
			const lab = useLab();
			const progressDelta = formatDeltaPct(model.progress?.deltaPct ?? null);
			const deltaTone = model.progress?.improved === true ? colors.good : model.progress?.improved === false ? colors.bad : colors.muted;
			const terminal = model.lifecycle !== "running" && model.lifecycle !== "awaiting_user";
			const stateTone = model.lifecycle === "completed" ? colors.good : model.lifecycle === "awaiting_user" ? colors.warn : terminal ? colors.muted : colors.accent;
			const stateLabel = model.lifecycle === "completed" ? "目标已完成" : model.lifecycle === "awaiting_user" ? "等待你拍板" : model.lifecycle === "stopped" ? "本轮已停止" : model.lifecycle === "ended" ? "本轮已结束" : model.running ? "正在执行" : "循环已开启";
			const issueCount = model.crashed + model.checksFailed;
			const [showAllRuns, setShowAllRuns] = (0, react.useState)(false);
			const [expandedRun, setExpandedRun] = (0, react.useState)(null);
			const historyId = (0, react.useId)();
			const historySectionRef = (0, react.useRef)(null);
			const snapshotIdentity = progressIdentity(snapshot);
			const visibleRows = showAllRuns ? model.allRows : model.rows;
			(0, react.useEffect)(() => {
				setShowAllRuns(false);
				setExpandedRun(null);
			}, [snapshotIdentity]);
			async function onPause() {
				if (!sessionId || lab.busy) return;
				patchLab({
					busy: true,
					error: null
				});
				try {
					await executeLine(ctx, sessionId, "/autoresearch off");
					patchLab({ busy: false });
				} catch (error) {
					patchLab({
						busy: false,
						error: friendlyStartError(error)
					});
				}
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				"data-autoresearch": "progress-card",
				"aria-label": "Autoresearch 结果",
				style: {
					display: "grid",
					gap: 0,
					fontSize: 14
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: clientStyles }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						"data-ud-check": "progress-header",
						"data-ud-role": "title",
						style: {
							display: "flex",
							justifyContent: "space-between",
							alignItems: "flex-start",
							gap: 16
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: { minWidth: 0 },
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									color: colors.muted,
									fontSize: 12,
									marginBottom: 4
								},
								children: "Autoresearch"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								"data-autoresearch": "progress-title",
								style: {
									fontSize: 17,
									lineHeight: 1.3,
									fontWeight: 620,
									overflowWrap: "anywhere"
								},
								children: model.name ?? "未命名目标"
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							role: "status",
							style: {
								display: "inline-flex",
								alignItems: "center",
								flex: "0 0 auto",
								gap: 6,
								color: stateTone,
								paddingTop: 2,
								fontSize: 12,
								fontWeight: 560
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								"aria-hidden": "true",
								style: {
									width: 6,
									height: 6,
									borderRadius: "50%",
									background: stateTone
								}
							}), stateLabel]
						})]
					}),
					model.lifecycle === "awaiting_user" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						role: "status",
						"data-autoresearch": "decision-required",
						style: {
							display: "grid",
							gap: 5,
							marginTop: 16,
							padding: "12px 14px",
							border: `1px solid color-mix(in srgb, ${colors.warn} 45%, transparent)`,
							borderRadius: 8,
							background: `color-mix(in srgb, ${colors.warn} 8%, ${colors.panel})`
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
								style: { color: colors.warn },
								children: "等待你拍板"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: snapshot.decisionQuestion ?? "下一步需要你的决定，请在对话中的确认卡选择。" }),
							snapshot.completionReason ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									color: colors.muted,
									fontSize: 12
								},
								children: snapshot.completionReason
							}) : null
						]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "dsh-ar-outcome",
						"data-ud-check": "progress-outcome",
						"data-ud-role": "panel",
						style: {
							padding: "24px 0 20px",
							borderBottom: `1px solid ${colors.line}`
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									color: colors.muted,
									fontSize: 12,
									marginBottom: 7
								},
								children: ["当前最佳 · ", model.metricName]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								"data-autoresearch": "progress-best",
								style: {
									color: model.progress ? colors.text : colors.muted,
									fontSize: 32,
									lineHeight: 1.05,
									fontWeight: 650,
									...tabular
								},
								children: model.progress?.value ?? "—"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									color: colors.muted,
									fontSize: 12,
									lineHeight: 1.55,
									marginTop: 8,
									...tabular
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										"data-autoresearch": "baseline",
										children: ["基线 ", model.baseline?.value ?? "—"]
									}),
									progressDelta ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										"data-autoresearch": "delta",
										style: { color: deltaTone },
										children: ` · ${progressDelta}`
									}) : null,
									model.progress ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: ` · 第 ${model.progress.run} 轮` }) : null
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									color: colors.muted,
									fontSize: 12,
									lineHeight: 1.55,
									marginTop: 12,
									display: "flex",
									gap: "5px 14px",
									flexWrap: "wrap",
									...tabular
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
										"本轮 ",
										model.runs,
										" 轮"
									] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										"data-autoresearch": "kept",
										children: [
											"保留 ",
											model.kept,
											" 次"
										]
									}),
									model.conf !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										"data-autoresearch": "conf",
										children: [
											"可信度 ",
											model.conf.toFixed(1),
											"×"
										]
									}) : null,
									issueCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: { color: colors.bad },
										children: [issueCount, " 次未通过"]
									}) : null
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						ref: historySectionRef,
						"data-ud-check": "experiment-history",
						"data-ud-role": "panel",
						style: { paddingTop: 18 },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								justifyContent: "space-between",
								alignItems: "baseline",
								gap: 12,
								marginBottom: 2
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 13,
									fontWeight: 620
								},
								children: "最近记录"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-ar-history-list-toggle",
								"data-autoresearch": "history-list-toggle",
								"aria-expanded": showAllRuns,
								onClick: () => {
									setShowAllRuns((value) => !value);
									setExpandedRun(null);
									requestAnimationFrame(() => historySectionRef.current?.scrollIntoView({ block: "start" }));
								},
								children: showAllRuns ? "只看最近 3 轮" : `查看全部 ${model.allRows.length} 轮`
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
							"aria-label": "最近记录",
							style: {
								listStyle: "none",
								margin: 0,
								padding: 0
							},
							children: visibleRows.map((row) => {
								const expanded = expandedRun === row.run;
								const detailId = `${historyId}-run-${row.run}`;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									className: "dsh-ar-history-row",
									"data-autoresearch-run": row.run,
									"data-autoresearch-status": row.status,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: "dsh-ar-history-summary",
										"data-autoresearch-expand-run": row.run,
										"aria-expanded": expanded,
										"aria-controls": detailId,
										"aria-label": `${expanded ? "收起" : "展开"}第 ${row.run} 轮详情，${statusLabel(row.status)}，${row.metric}`,
										onClick: () => setExpandedRun((value) => value === row.run ? null : row.run),
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												style: {
													display: "flex",
													alignItems: "center",
													gap: 7,
													minWidth: 0,
													fontSize: 12
												},
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														"aria-label": `第 ${row.run} 轮`,
														style: {
															color: colors.muted,
															...tabular
														},
														children: ["#", row.run]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														"aria-hidden": "true",
														style: {
															width: 5,
															height: 5,
															borderRadius: "50%",
															background: statusColor(row.status)
														}
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														style: {
															color: statusColor(row.status),
															fontWeight: 560
														},
														children: statusLabel(row.status)
													})
												]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													fontSize: 13,
													fontWeight: 620,
													textAlign: "right",
													...tabular
												},
												children: row.metric
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-ar-history-chevron",
												"aria-hidden": "true",
												style: { transform: expanded ? "rotate(90deg)" : void 0 },
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
													width: "12",
													height: "12",
													viewBox: "0 0 12 12",
													fill: "none",
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
														d: "M4.5 2.5 8 6l-3.5 3.5",
														stroke: "currentColor",
														strokeWidth: "1.5",
														strokeLinecap: "round",
														strokeLinejoin: "round"
													})
												})
											}),
											!expanded ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-ar-history-preview",
												children: row.description
											}) : null
										]
									}), expanded ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										id: detailId,
										className: "dsh-ar-history-detail",
										"data-autoresearch-run-detail": row.run,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: row.description }), row.commit !== "—" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: {
												...mono,
												color: colors.muted,
												fontSize: 11,
												marginTop: 7
											},
											children: ["版本 ", row.commit]
										}) : null]
									}) : null]
								}, row.run);
							})
						})]
					}),
					model.running ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						"data-autoresearch": "running-line",
						role: "status",
						style: {
							color: colors.muted,
							fontSize: 12,
							padding: "10px 0"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Spinner, {}),
							"正在执行当前实验",
							model.runningCommand ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: mono,
								children: ` · ${model.runningCommand}`
							}) : null
						]
					}) : null,
					lab.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						role: "alert",
						style: {
							color: colors.bad,
							fontSize: 12,
							whiteSpace: "pre-wrap"
						},
						children: lab.error
					}) : null,
					model.lifecycle === "awaiting_user" || !terminal ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						"data-ud-check": "progress-action",
						"data-ud-role": "panel",
						style: {
							display: "flex",
							justifyContent: "flex-end",
							alignItems: "center",
							minHeight: 44,
							paddingTop: 10,
							borderTop: `1px solid ${colors.line}`
						},
						children: model.lifecycle === "awaiting_user" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								color: colors.muted,
								fontSize: 12
							},
							children: "请在对话中的确认卡拍板"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LabButton, {
							disabled: !sessionId || lab.busy,
							onClick: () => void onPause(),
							children: lab.busy ? "正在暂停…" : "暂停"
						})
					}) : null
				]
			});
		}
		function AutoresearchHeaderUtility({ ctx, sessionId, useSession, useProjection, session }) {
			const lab = useLab();
			rememberSession(sessionId);
			const live = useSession ? useSession((snapshot) => snapshot) : session;
			const projected = snapshotFromMeta(typeof useProjection === "function" ? useProjection("autoresearch") : void 0);
			const progress = inspectConversation(live ?? {
				runningCalls: [],
				nodes: []
			});
			const projectedBoard = Boolean(projected?.boardReady && projected.results.length > 0);
			const snapshot = applyCommandAcknowledgement(progress.kind === "board" ? preferLedgerSnapshot(progress.snapshot, projected) ?? progress.snapshot : projectedBoard ? projected : progress.snapshot, lab.commandAck, sessionId);
			const model = snapshot ? buildDashboardModel(snapshot, {
				running: progress.runningExperiment,
				runningCommand: progress.runningCommand
			}) : null;
			const superseded = Boolean(lab.dock === "waiting" && lab.supersededProgressKey && snapshot && progressIdentity(snapshot) === lab.supersededProgressKey);
			const acknowledgedBoard = lab.commandAck?.sessionId === sessionId && lab.commandAck.kind !== "idle";
			const showBoard = !superseded && (progress.kind === "board" || projectedBoard || acknowledgedBoard) && snapshot !== null && model !== null && model.runs > 0;
			const showRunning = !showBoard && !superseded && progress.kind === "running";
			const showWaiting = !showBoard && !showRunning && (lab.dock === "waiting" || superseded || Boolean(snapshot?.active && (model?.runs ?? 0) === 0));
			const visible = lab.dock !== "init" && (showBoard || showRunning || showWaiting);
			const [open, setOpen] = (0, react.useState)(false);
			const [locallyReadCompletion, setLocallyReadCompletion] = (0, react.useState)(null);
			const rootRef = (0, react.useRef)(null);
			const triggerRef = (0, react.useRef)(null);
			const panelRef = (0, react.useRef)(null);
			const panelPosition = (0, _deepseek_ai_dsh_client_ui_primitives.useAnchoredPosition)({
				open,
				anchorRef: triggerRef,
				panelRef,
				gap: PANEL_GAP,
				margin: PANEL_MARGIN
			});
			(0, react.useEffect)(() => setOpen(false), [sessionId]);
			(0, react.useEffect)(() => {
				if (visible) return;
				setOpen(false);
			}, [visible]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const closeOutside = (event) => {
					if (!(event.target instanceof Node)) return;
					if (rootRef.current?.contains(event.target) === true) return;
					if (panelRef.current?.contains(event.target) === true) return;
					setOpen(false);
				};
				const closeOnEscape = (event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					setOpen(false);
					triggerRef.current?.focus();
				};
				document.addEventListener("pointerdown", closeOutside);
				document.addEventListener("keydown", closeOnEscape);
				return () => {
					document.removeEventListener("pointerdown", closeOutside);
					document.removeEventListener("keydown", closeOnEscape);
				};
			}, [open]);
			if (!visible) return null;
			const monitorState = showBoard && model?.lifecycle === "completed" ? "completed" : showBoard && model?.lifecycle === "awaiting_user" ? "awaiting-user" : showBoard && model?.lifecycle === "stopped" ? "stopped" : showBoard && model?.lifecycle === "ended" ? "ended" : showRunning || progress.runningExperiment ? "running" : showWaiting || snapshot?.pendingContinuation ? "waiting" : "ready";
			const stateLabel = monitorState === "completed" ? "目标已完成" : monitorState === "awaiting-user" ? "等待你拍板" : monitorState === "stopped" ? "本轮已停止" : monitorState === "ended" ? "本轮已结束" : monitorState === "running" ? "正在执行实验" : monitorState === "waiting" ? "正在准备下一轮" : "循环已开启";
			const goalLabel = model?.name ?? projected?.name ?? snapshot?.name ?? null;
			const currentCompletion = monitorState === "completed" && snapshot ? completionIdentity(snapshot) : null;
			const completionUnread = Boolean(currentCompletion && currentCompletion !== locallyReadCompletion && snapshot && isCompletionUnread(sessionId, snapshot));
			const triggerState = monitorState === "completed" ? completionUnread ? "completed-unread" : "completed-read" : monitorState;
			const accessibleStateLabel = monitorState === "completed" ? completionUnread ? "目标已完成，有新结果" : "目标已完成，已查看" : stateLabel;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				className: "dsh-ar-header-root",
				"data-autoresearch": "header-utility",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: clientStyles }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						ref: triggerRef,
						type: "button",
						className: "dsh-ar-trigger",
						"data-autoresearch": "header-trigger",
						"data-open": open ? "" : void 0,
						"data-state": triggerState,
						"data-unread": completionUnread ? "" : void 0,
						"aria-expanded": open,
						"aria-label": `Autoresearch，${accessibleStateLabel}${goalLabel ? `，${goalLabel}` : ""}`,
						title: `Autoresearch · ${accessibleStateLabel}`,
						onClick: () => {
							const nextOpen = !open;
							if (nextOpen && monitorState === "completed" && snapshot) setLocallyReadCompletion(markCompletionRead(sessionId, snapshot));
							setOpen(nextOpen);
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AutoresearchIcon, {})
					}),
					open ? (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						ref: panelRef,
						className: "dsh-ar-menu",
						style: panelPosition ?? UNPLACED_PANEL_STYLE,
						role: "dialog",
						"aria-modal": "false",
						"aria-label": "Autoresearch 监测面板",
						"data-autoresearch": "header-panel",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: `dsh-ar-panel-scroll${showBoard ? "" : " dsh-ar-compact-panel"}`,
							children: showBoard && model && snapshot ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProgressCard, {
								model,
								snapshot,
								ctx,
								sessionId
							}) : showRunning ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RunningCard, {
								name: projected?.name ?? snapshot?.name ?? null,
								command: progress.runningCommand
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WaitingCard, {})
						})
					}), document.body) : null
				]
			});
		}
		function AutoresearchDock({ ctx, sessionId, useSession, useProjection, session }) {
			const lab = useLab();
			rememberSession(sessionId);
			const live = useSession ? useSession((snapshot) => snapshot) : session;
			const projected = snapshotFromMeta(typeof useProjection === "function" ? useProjection("autoresearch") : void 0);
			const progress = inspectConversation(live ?? {
				runningCalls: [],
				nodes: []
			});
			const snapshot = progress.kind === "board" ? preferLedgerSnapshot(progress.snapshot, projected) ?? progress.snapshot : projected?.boardReady && projected.results.length > 0 ? projected : progress.snapshot;
			if (lab.dock === "init") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				"data-autoresearch": "dock",
				style: dockShell,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InitDockCard, {
					ctx,
					sessionId,
					previousSnapshot: snapshot
				})
			});
			return null;
		}
		function SettingsCard({ scope }) {
			const value = scope.value ?? {};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					...font,
					display: "grid",
					gap: 10,
					padding: 4
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { fontWeight: 700 },
						children: "Autoresearch"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							color: colors.muted,
							fontSize: 12,
							marginTop: 4
						},
						children: "项目级 `.auto/config.json` 优先于这里的默认值。日常首页和 composer 不常驻实验入口；用 `/autoresearch` 打开引导卡。"
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: {
							display: "grid",
							gap: 6,
							fontSize: 13
						},
						children: ["默认最大轮数（0 表示不在设置里封顶）", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "number",
							defaultValue: Number(value.maxIterations ?? 20),
							onBlur: (event) => void scope.set("maxIterations", Number(event.target.value)),
							style: fieldStyle()
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: {
							display: "grid",
							gap: 6,
							fontSize: 13
						},
						children: ["默认自动续跑次数", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "number",
							defaultValue: Number(value.maxAutoResumeTurns ?? 20),
							onBlur: (event) => void scope.set("maxAutoResumeTurns", Number(event.target.value)),
							style: fieldStyle()
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: {
							display: "flex",
							gap: 8,
							alignItems: "center",
							fontSize: 13
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							defaultChecked: value.hintsEnabled === true,
							onChange: (event) => void scope.set("hintsEnabled", event.target.checked)
						}), "允许侧模型 hint（默认关闭）"]
					})
				]
			});
		}
		function apply(ctx) {
			ctx.on("command/executed", (sessionId, commandName, result) => {
				if (commandName !== "autoresearch" || result.kind !== "success" || typeof result.text !== "string") return;
				recordCommandAcknowledgement(sessionId, result.text);
			});
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "autoresearch-monitor",
				order: 60,
				label: "Autoresearch"
			}, (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AutoresearchHeaderUtility, {
				ctx,
				...props
			})));
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "autoresearch",
				order: 25
			}, (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AutoresearchDock, {
				ctx,
				...props
			})));
			const scope = ctx.settingsScope.bind({ namespace: "autoresearch" });
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: "autoresearch"
			}, () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsCard, { scope })));
			ctx.commandUi.decorate({
				name: "autoresearch",
				available: () => true,
				ui: {
					kind: "popupSelect",
					options: async () => [
						{
							id: "start",
							label: "新开一次 Autoresearch",
							detail: "目标 + 轮次，确认后才执行"
						},
						{
							id: "resume",
							label: "继续",
							detail: "/autoresearch resume"
						},
						{
							id: "status",
							label: "状态",
							detail: "/autoresearch status"
						},
						{
							id: "off",
							label: "停止续跑",
							detail: "/autoresearch off"
						},
						{
							id: "clear",
							label: "清除账本",
							detail: "/autoresearch clear"
						}
					],
					onSelect: async (option, session) => {
						rememberSession(session.sessionId);
						if (option.id === "start") {
							showInitDock();
							return;
						}
						const line = option.id === "resume" ? "/autoresearch resume" : `/autoresearch ${option.id}`;
						await executeLine(ctx, session.sessionId, line);
					}
				}
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map