import type { App } from "obsidian";
import type { VaultSyncSettings } from "../../settings";
import { FlightRecorder, type FlightRecorderOptions } from "./flightRecorder";
import {
	FLIGHT_EVENT_SCHEMA_VERSION,
	type FlightEventInput,
	type FlightPathEventInput,
} from "../../observability/flightEnvelope";
import { FLIGHT_KIND, FLIGHT_TAXONOMY_VERSION } from "../../observability/flightTaxonomy";
import type { FlightExportResult, TraceContext } from "./flightEvents";
import { PathIdentityResolver, deriveSaltFingerprint, deriveVaultPathSalt } from "./pathIdentity";
import { buildTraceHeader, type TraceHeaderStateInput } from "../diagnostics/diagnosticsBundle";
import { sha256Hex, getOrCreateLocalDeviceId } from "../../sync/indexedDbCandidateStore";

export type FlightTraceDeps = {
	app: App;
	getSettings(): VaultSyncSettings;
	getPluginVersion(): string;
	getDocSchemaVersion(): number | null;
	buildCheckpoint(): Promise<Record<string, unknown>>;
	/** Point-in-time world state for the export header; null if sync is down. */
	collectTraceHeaderInput(): Promise<TraceHeaderStateInput | null>;
	registerCleanup(cleanup: () => void): void;
	log(message: string): void;
};

const DEFAULT_CHECKPOINT_MS = 30_000;

/**
 * The recorder always runs in "safe" mode: raw vault paths, the server URL,
 * the vault id and the device name never reach the on-disk log. Whether an
 * *export* reveals filenames is decided per export, and only ever by adding a
 * pathId directory to the header — never by rewriting the event lines.
 */
const RECORDING_MODE = "safe" as const;

/**
 * Canonicalize a server host URL to its origin for stable hashing.
 * Falls back to the raw string if URL parsing fails.
 */
function canonicalizeHost(host: string): string {
	try {
		return new URL(host).origin;
	} catch {
		return host;
	}
}

export class FlightTraceController {
	private recorder: FlightRecorder | null = null;
	private pathIdentity: PathIdentityResolver | null = null;
	private checkpointTimer: number | null = null;
	private enabled = false;
	private pathSalt: string | null = null;
	private saltFingerprint: string | null = null;

	/** Pending recordPath() promises — flush() drains these before reading. */
	private pendingPathPromises = new Set<Promise<void>>();

	constructor(private readonly deps: FlightTraceDeps) {}

	get isEnabled(): boolean {
		return this.enabled;
	}

	get currentRecorder(): FlightRecorder | null {
		return this.recorder;
	}

	get context(): TraceContext | null {
		return this.recorder?.context ?? null;
	}

	/** Current seq counter (last assigned seq). Used for causedByEvents linkage. */
	get currentSeq(): number {
		return this.recorder?.currentSeq ?? 0;
	}

	/**
	 * Shareable fingerprint of the vault-scoped path pseudonymization salt.
	 * Two devices configured against the same vault report the same value and
	 * their traces can be merged; null while no trace is running.
	 */
	get pathSaltFingerprint(): string | null {
		return this.saltFingerprint;
	}

	async start(): Promise<void> {
		if (this.enabled) return;
		const settings = this.deps.getSettings();
		if (!settings.vaultId || !settings.host) return;

		const [vaultIdHash, serverHostHash, deviceId, pathSalt] = await Promise.all([
			sha256Hex(settings.vaultId.trim()),
			sha256Hex(canonicalizeHost(settings.host)),
			getOrCreateLocalDeviceId(),
			deriveVaultPathSalt(sha256Hex, settings.vaultId),
		]);
		const recorderOptions: FlightRecorderOptions = {
			mode: RECORDING_MODE,
			deviceId,
			vaultIdHash,
			serverHostHash,
			pluginVersion: this.deps.getPluginVersion(),
			docSchemaVersion: this.deps.getDocSchemaVersion() ?? undefined,
		};
		this.recorder = new FlightRecorder(this.deps.app, recorderOptions);
		this.pathIdentity = new PathIdentityResolver(sha256Hex, { salt: pathSalt });
		this.pathSalt = pathSalt;
		this.saltFingerprint = await deriveSaltFingerprint(sha256Hex, pathSalt);
		this.enabled = true;
		this.startCheckpointLoop();
		this.record({
			priority: "important",
			kind: FLIGHT_KIND.debugTraceStarted,
			severity: "info",
			scope: "diagnostics",
			source: "diagnostics",
			layer: "diagnostics",
			data: { mode: RECORDING_MODE },
		});
		this.deps.registerCleanup(() => {
			void this.stop();
		});
	}

	/**
	 * The whole lifecycle. `debug` is the only switch: on records, off does not.
	 */
	async refreshFromSettings(reason: string): Promise<void> {
		if (!this.deps.getSettings().debug) {
			await this.stop();
			return;
		}
		if (this.enabled) return;
		await this.start();
		if (this.enabled) this.deps.log(`Debug trace recording started (${reason})`);
	}

	async stop(): Promise<void> {
		if (!this.enabled) return;
		this.record({
			priority: "important",
			kind: FLIGHT_KIND.debugTraceStopped,
			severity: "info",
			scope: "diagnostics",
			source: "diagnostics",
			layer: "diagnostics",
			data: { mode: RECORDING_MODE },
		});
		this.stopCheckpointLoop();
		await this.flush();
		await this.recorder?.shutdown();
		this.recorder = null;
		this.pathIdentity = null;
		this.pathSalt = null;
		this.saltFingerprint = null;
		this.enabled = false;
	}

	record(event: FlightEventInput): void {
		this.recorder?.record(event);
	}

	/**
	 * Record a path-scoped event. Returns a Promise that resolves after the
	 * event has been written to the pending queue (path identity resolved).
	 * Callers on the hot path may fire-and-forget; flush() drains all pending
	 * promises before reading the session file.
	 */
	recordPath(event: FlightPathEventInput): Promise<void> {
		const p = this.resolveAndRecord(event);
		this.pendingPathPromises.add(p);
		void p.finally(() => this.pendingPathPromises.delete(p));
		return p;
	}

	/**
	 * Reserve a seq and record a path-scoped event, returning the reserved seq.
	 * Use this when the caller needs the seq for causedByEvents linkage.
	 * The seq is reserved synchronously before any async work.
	 */
	reserveAndRecordPath(event: FlightPathEventInput): number {
		const seq = this.recorder?.reserveSeq() ?? 0;
		const p = this.resolveAndRecordWithSeq(event, seq);
		this.pendingPathPromises.add(p);
		void p.finally(() => this.pendingPathPromises.delete(p));
		return seq;
	}

	/**
	 * Flush: drain all pending path-identity promises, then flush the recorder.
	 * Must be called before reading the session file for export.
	 */
	async flush(): Promise<void> {
		if (this.pendingPathPromises.size > 0) {
			await Promise.allSettled([...this.pendingPathPromises]);
			this.pendingPathPromises.clear();
		}
		await this.recorder?.flushNow();
		// Drain the write chain too.
		// FlightRecorder.flushNow() already chains onto writeChain; awaiting it
		// is sufficient — no extra handle needed here.
	}

	async getPathId(path: string): Promise<{ pathId: string }> {
		if (!this.pathIdentity) {
			return { pathId: "p:unavailable" };
		}
		return await this.pathIdentity.getPathIdentity(path);
	}

	/**
	 * Delete all flight log files.
	 * If a trace is active, stops it first.
	 */
	async clearLogs(): Promise<void> {
		if (this.enabled) {
			await this.stop();
		}
		await clearFlightLogs(this.deps.app);
	}

	// -----------------------------------------------------------------------
	// Export
	// -----------------------------------------------------------------------

	/**
	 * Export the current trace session as one NDJSON file: a self-describing
	 * header line stating what world the trace was recorded in, followed by the
	 * recorded events in causal `seq` order.
	 *
	 * `includeFilenames` defaults to false. The redacted export is the one a
	 * user can hand to a stranger; the unredacted one additionally carries the
	 * pathId → vault path directory and the server URL, vault id and device name.
	 */
	async exportTrace(options: {
		diagDir: string;
		includeFilenames?: boolean;
	}): Promise<FlightExportResult> {
		const includeFilenames = options.includeFilenames ?? false;
		if (!this.enabled || !this.recorder) {
			return { ok: false, reason: "trace-not-active" };
		}

		const recorder = this.recorder;

		// Structural mode checks.
		if (!recorder.exportable) {
			return { ok: false, reason: "trace-not-exportable" };
		}
		// Flush before reading: the user is told to export, never to stop first.
		try {
			await this.flush();
		} catch {
			return { ok: false, reason: "flush-failed" };
		}
		// Per-export redaction only rewrites the header. A recorder that wrote
		// raw paths into its event lines can never produce a redacted export.
		if (!includeFilenames && !recorder.safeToShare) {
			return { ok: false, reason: "trace-unsafe-for-safe-export" };
		}

		let combinedContent = "";
		let segmentCount = 0;
		try {
			const segments = await recorder.getAllSessionSegmentPaths();
			for (const segPath of segments) {
				try {
					combinedContent += await this.deps.app.vault.adapter.read(segPath);
					segmentCount++;
				} catch {
					// Segment might have been cleaned up by retention — skip
				}
			}
		} catch {
			return { ok: false, reason: "write-failed" };
		}

		if (!combinedContent && segmentCount === 0) {
			return { ok: false, reason: "write-failed" };
		}

		const state = await this.deps.collectTraceHeaderInput().catch((err: unknown) => {
			this.deps.log(`debug trace export: header state unavailable: ${String(err)}`);
			return null;
		});
		// Every path the header will name must already have a pseudonym, so the
		// header's file lists join against the event lines by pathId.
		if (state && this.pathIdentity) {
			await this.pathIdentity.prime([...state.diskHashes.keys(), ...state.crdtHashes.keys()]);
		}

		const { header, leakDetected } = await buildTraceHeader(
			{
				state,
				trace: {
					traceId: recorder.context.traceId,
					bootId: recorder.currentBootId,
					deviceId: recorder.context.deviceId,
					vaultIdHash: recorder.context.vaultIdHash,
					serverHostHash: recorder.context.serverHostHash,
					pluginVersion: recorder.context.pluginVersion,
					flightEventSchemaVersion: FLIGHT_EVENT_SCHEMA_VERSION,
					flightEventTaxonomyVersion: FLIGHT_TAXONOMY_VERSION,
					exportedAt: new Date().toISOString(),
					eventCount: combinedContent.split("\n").filter(Boolean).length,
					segmentCount,
					segmentsRotated: segmentCount > 1,
					pathIdentityDegraded: recorder.pathIdentityDegraded,
					droppedEventCount: recorder.redactionStats.droppedCount,
					droppedEventCountByKind: recorder.redactionStats.droppedByKind,
					pathPseudonymSaltFingerprint: this.saltFingerprint,
					pathDirectory: this.pathIdentity?.directory() ?? [],
				},
			},
			// Same salt as the recorder's pseudonyms: paths the redactor catches
			// inside free-form text land in the same namespace as the event lines.
			{ redacted: !includeFilenames, salt: this.pathSalt ?? undefined },
		);

		if (leakDetected) {
			this.deps.log("debug trace export: a vault path survived redaction, export refused");
			return { ok: false, reason: "trace-unsafe-for-safe-export" };
		}

		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const variant = includeFilenames ? "with-filenames" : "redacted";
		const outPath = `${options.diagDir}/debug-trace-${variant}-${stamp}.ndjson`;

		try {
			await this.deps.app.vault.adapter.write(
				outPath,
				`${JSON.stringify(header)}\n${combinedContent}`,
			);
			return { ok: true, path: outPath, includesFilenames: includeFilenames };
		} catch {
			return { ok: false, reason: "write-failed" };
		}
	}

	// -----------------------------------------------------------------------
	// Private
	// -----------------------------------------------------------------------

	private async resolveAndRecord(event: FlightPathEventInput): Promise<void> {
		// Reserve seq synchronously so causal order is preserved regardless of
		// async path identity resolution time.
		const reservedSeq = this.recorder?.reserveSeq();
		await this._resolveAndRecordCore(event, reservedSeq);
	}

	private async resolveAndRecordWithSeq(event: FlightPathEventInput, reservedSeq: number): Promise<void> {
		await this._resolveAndRecordCore(event, reservedSeq);
	}

	private async _resolveAndRecordCore(event: FlightPathEventInput, reservedSeq: number | undefined): Promise<void> {
		const identity = await this.getPathId(event.path);
		const { path: _removedPath, ...rest } = event;
		this.recorder?.record({ ...rest, pathId: identity.pathId }, { reservedSeq });
		// Emit path.identity.degraded if the resolver fell back to FNV.
		if (this.pathIdentity?.hasDegraded) {
			this.recorder?.markPathIdentityDegraded();
			this.record({
				priority: "critical",
				kind: FLIGHT_KIND.pathIdentityDegraded,
				severity: "error",
				scope: "diagnostics",
				source: "traceRuntime",
				layer: "diagnostics",
				data: { affectedPath: identity.pathId },
			});
		}
	}

	private startCheckpointLoop(): void {
		if (this.checkpointTimer) return;
		this.checkpointTimer = window.setInterval(() => {
			void this.emitCheckpoint();
		}, DEFAULT_CHECKPOINT_MS);
	}

	private stopCheckpointLoop(): void {
		if (this.checkpointTimer) {
			window.clearInterval(this.checkpointTimer);
			this.checkpointTimer = null;
		}
	}

	private async emitCheckpoint(): Promise<void> {
		if (!this.recorder) return;
		const state = await this.deps.buildCheckpoint();
		this.recorder.record({
			priority: "important",
			kind: FLIGHT_KIND.qaCheckpoint,
			severity: "info",
			scope: "diagnostics",
			source: "diagnostics",
			layer: "diagnostics",
			data: { state },
		});
	}
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/**
 * Clear all flight log files. Pure filesystem helper — no recorder, settings,
 * or vaultId required. The logs directory is deterministic.
 */
export async function clearFlightLogs(app: App): Promise<void> {
	const root = `${app.vault.configDir}/plugins/yaos/flight-logs`;
	try {
		const exists = await app.vault.adapter.exists(root);
		if (!exists) return;
		const listing = await app.vault.adapter.list(root);
		for (const filePath of listing.files) {
			try { await app.vault.adapter.remove(filePath); } catch { /* skip */ }
		}
		for (const dir of listing.folders) {
			await deleteDirectoryRecursive(app, dir);
		}
		// Try to remove the root itself
		try { await app.vault.adapter.rmdir(root, false); } catch { /* ok */ }
	} catch { /* nothing to clear */ }
}

async function deleteDirectoryRecursive(app: App, dir: string): Promise<void> {
	try {
		const listing = await app.vault.adapter.list(dir);
		for (const filePath of listing.files) {
			try { await app.vault.adapter.remove(filePath); } catch { /* skip */ }
		}
		for (const subDir of listing.folders) {
			await deleteDirectoryRecursive(app, subDir);
		}
		try { await app.vault.adapter.rmdir(dir, false); } catch { /* ok */ }
	} catch { /* skip */ }
}
