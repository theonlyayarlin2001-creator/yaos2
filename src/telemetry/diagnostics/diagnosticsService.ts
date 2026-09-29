import { App, Platform, apiVersion, normalizePath } from "obsidian";
import { deriveSyncFacts } from "../../runtime/connectionFacts";
import type { BlobSyncSnapshot, DiskMirrorSnapshot, SyncReadPort } from "../telemetryRuntimeHost";
import type { TraceHttpContext } from "../debug/trace";
import type { VaultSyncSettings } from "../../settings";
import type { FrontmatterQuarantineEntry } from "../../sync/frontmatterQuarantine";
import type { TraceHeaderPlatform, TraceHeaderStateInput } from "./diagnosticsBundle";
import type { ReconcileMode } from "../../sync/vaultSync";

type LogLine = { ts: string; msg: string };

type LastReconcileStats = {
	at: string;
	mode: ReconcileMode;
	plannedCreates: number;
	plannedUpdates: number;
	flushedCreates: number;
	flushedUpdates: number;
	safetyBrakeTriggered: boolean;
	safetyBrakeReason: string | null;
};

interface DiagnosticsServiceDeps {
	app: App;
	getSettings(): VaultSyncSettings;
	getServerVersion(): string | null;
	getTraceHttpContext(): TraceHttpContext | undefined;
	getSyncState(): SyncReadPort | null;
	getDiskMirrorSnapshot(): DiskMirrorSnapshot | null;
	getBlobSyncSnapshot(): BlobSyncSnapshot | null;
	getEventRing(): LogLine[];
	getRecentServerTrace(): unknown[];
	getFrontmatterQuarantineEntries(): FrontmatterQuarantineEntry[];
	getState(): {
		reconciled: boolean;
		reconcileInFlight: boolean;
		reconcilePending: boolean;
		lastReconcileStats: LastReconcileStats | null;
		awaitingFirstProviderSyncAfterStartup: boolean;
		lastReconciledGeneration: number;
		untrackedFileCount: number;
		openFileCount: number;
	};
	isMarkdownPathSyncable(path: string): boolean;
	collectOpenFileTraceState(): Promise<Array<Record<string, unknown>>>;
	sha256Hex(text: string): Promise<string>;
	log(message: string): void;
}

function describePlatform(): TraceHeaderPlatform {
	let operatingSystem = "unknown";
	if (Platform.isIosApp) operatingSystem = "ios";
	else if (Platform.isAndroidApp) operatingSystem = "android";
	else if (Platform.isMacOS) operatingSystem = "macos";
	else if (Platform.isWin) operatingSystem = "windows";
	else if (Platform.isLinux) operatingSystem = "linux";
	return {
		obsidianApiVersion: apiVersion ?? null,
		operatingSystem,
		isMobile: Platform.isMobile,
		isDesktopApp: Platform.isDesktopApp,
	};
}

/**
 * Gathers the point-in-time state that becomes the header of an exported
 * debug trace. Nothing here writes a file or shows a Notice: the trace export
 * owns the artifact, this owns the facts that go at the top of it.
 */
export class DiagnosticsService {
	constructor(private readonly deps: DiagnosticsServiceDeps) {}

	/**
	 * Read the world: settings, sync state, connection facts, and a content
	 * hash of every syncable markdown file on disk and in the CRDT so the header
	 * can state where the two disagree. Returns plain values only — the pure
	 * builder in diagnosticsBundle.ts decides what is safe to emit.
	 *
	 * Returns null when sync is not initialised; a header cannot describe a
	 * world that does not exist yet.
	 */
	async collectTraceHeaderInput(): Promise<TraceHeaderStateInput | null> {
		const vaultSync = this.deps.getSyncState();
		if (!vaultSync) return null;

		const startedAt = Date.now();
		const settings = this.deps.getSettings();
		const state = this.deps.getState();

		const diskFiles = this.deps.app.vault
			.getMarkdownFiles()
			.filter((f) => this.deps.isMarkdownPathSyncable(f.path));

		const diskHashes = new Map<string, { hash: string; length: number }>();
		for (const file of diskFiles) {
			try {
				const content = await this.deps.app.vault.read(file);
				diskHashes.set(file.path, {
					hash: await this.deps.sha256Hex(content),
					length: content.length,
				});
			} catch (err) {
				this.deps.log(`trace header: failed to read disk file "${file.path}": ${String(err)}`);
			}
		}

		const activePaths = vaultSync.getActiveMarkdownPaths();
		const crdtHashes = new Map<string, { hash: string; length: number }>();
		for (const path of activePaths) {
			if (!this.deps.isMarkdownPathSyncable(path)) continue;
			const content = vaultSync.getPathContent(path);
			if (content === null) continue;
			crdtHashes.set(path, {
				hash: await this.deps.sha256Hex(content),
				length: content.length,
			});
		}

		const blobSyncSnapshot = this.deps.getBlobSyncSnapshot();
		const syncFacts = deriveSyncFacts(
			{
				connected: vaultSync.connected,
				fatalAuthError: vaultSync.fatalAuthError,
				fatalAuthCode: vaultSync.fatalAuthCode,
				lastLocalUpdateAt: vaultSync.lastLocalUpdateAt,
				lastLocalUpdateWhileConnectedAt: vaultSync.lastLocalUpdateWhileConnectedAt,
				lastRemoteUpdateAt: vaultSync.lastRemoteUpdateAt,
				pendingBlobUploads: blobSyncSnapshot?.pendingUploads ?? 0,
				serverAppliedLocalState: vaultSync.serverAppliedLocalState,
				lastServerReceiptEchoAt: vaultSync.lastServerReceiptEchoAt,
				lastKnownServerReceiptEchoAt: vaultSync.lastKnownServerReceiptEchoAt,
				candidatePersistenceHealthy: vaultSync.candidatePersistenceHealthy,
				candidatePersistenceFailureCount: vaultSync.candidatePersistenceFailureCount,
				hasUnconfirmedServerReceiptCandidate: vaultSync.hasUnconfirmedServerReceiptCandidate,
				serverReceiptCandidateCapturedAt: vaultSync.serverReceiptCandidateCapturedAt,
			},
			vaultSync.connected
				? (state.reconciled ? "online" : "connecting")
				: (vaultSync.fatalAuthError ? "auth_failed" : "offline"),
		);

		return {
			generatedAt: new Date().toISOString(),
			generationDurationMs: Date.now() - startedAt,
			platform: describePlatform(),
			serverVersion: this.deps.getServerVersion(),
			settings: {
				host: settings.host,
				token: settings.token,
				vaultId: settings.vaultId,
				deviceName: settings.deviceName,
				debug: settings.debug,
				enableAttachmentSync: settings.enableAttachmentSync,
				externalEditPolicy: settings.externalEditPolicy,
			},
			syncState: {
				reconcileCompleted: state.reconciled,
				reconcileInFlight: state.reconcileInFlight,
				reconcilePending: state.reconcilePending,
				lastReconcileStats: state.lastReconcileStats,
				awaitingFirstProviderSyncAfterStartup: state.awaitingFirstProviderSyncAfterStartup,
				lastReconciledGeneration: state.lastReconciledGeneration,
				connectedToServer: vaultSync.connected,
				providerSynced: vaultSync.providerSynced,
				localCacheReady: vaultSync.localReady,
				connectionGeneration: vaultSync.connectionGeneration,
				fatalAuthError: vaultSync.fatalAuthError,
				fatalAuthCode: vaultSync.fatalAuthCode,
				fatalAuthDetails: vaultSync.fatalAuthDetails,
				indexedDbError: vaultSync.idbError,
				indexedDbErrorDetails: vaultSync.idbErrorDetails,
				serverReceiptStartupValidation: vaultSync.serverReceiptStartupValidation,
				serverReceiptEchoCounters: vaultSync.svEchoCounters,
				activeCrdtPathCount: activePaths.length,
				blobPathCount: vaultSync.blobPathCount,
				syncableMarkdownFileCountOnDisk: diskFiles.length,
				openFileCount: state.openFileCount,
				documentSchemaVersionSupportedByClient: vaultSync.supportedSchemaVersion,
				documentSchemaVersionStoredInDocument: vaultSync.storedSchemaVersion,
			},
			syncFacts,
			httpTraceContext: this.deps.getTraceHttpContext(),
			diskHashes,
			crdtHashes,
			pluginLogLines: this.deps.getEventRing(),
			syncLogLines: vaultSync.getRecentEvents(240) as LogLine[],
			serverTraceEvents: this.deps.getRecentServerTrace(),
			openFiles: await this.deps.collectOpenFileTraceState(),
			diskMirrorSnapshot: this.deps.getDiskMirrorSnapshot(),
			blobSyncSnapshot,
			frontmatterQuarantine: this.deps.getFrontmatterQuarantineEntries(),
			sha256Hex: this.deps.sha256Hex.bind(this.deps),
		};
	}

	async ensureDiagnosticsDir(): Promise<string> {
		const diagDir = normalizePath(`${this.deps.app.vault.configDir}/plugins/yaos/diagnostics`);
		if (!(await this.deps.app.vault.adapter.exists(diagDir))) {
			await this.deps.app.vault.adapter.mkdir(diagDir);
		}
		return diagDir;
	}
}
