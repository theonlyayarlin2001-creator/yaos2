import type { ConnectionState } from "../runtime/connectionController";

export type SyncStatus = "disconnected" | "loading" | "syncing" | "connected" | "offline" | "error" | "unauthorized";

export type ServerReceiptStatus = {
	serverAppliedLocalState: boolean | null;
	lastServerReceiptEchoAt: number | null;
	lastKnownServerReceiptEchoAt: number | null;
	candidatePersistenceHealthy: boolean | null;
	serverReceiptStartupValidation: string | null;
	/** Receipts from this server prove a durable write, not just in-memory apply. */
	receiptGuaranteeIsDurable?: boolean;
	/** Server reported it cannot durably store writes. */
	serverPersistenceDegraded?: boolean;
};

export function getSyncStatusLabel(state: SyncStatus): string {
	const labels: Record<SyncStatus, string> = {
		disconnected: "CRDT: Disconnected",
		loading: "CRDT: Loading cache...",
		syncing: "CRDT: Syncing...",
		connected: "CRDT: Connected",
		offline: "CRDT: Offline",
		error: "CRDT: Error",
		unauthorized: "CRDT: Unauthorized",
	};
	return labels[state];
}

/**
 * Derives a status bar label directly from the rich `ConnectionState`. This
 * replaces the coarse 7-value SyncStatus → label mapping for the visible
 * status bar text, allowing the user to see auth rejection reasons and
 * schema-mismatch details without a full dashboard. Per the stabilization
 * plan (INV-AUTH-01): not a dashboard — just enough truth.
 */
export function getLabelFromConnectionState(
	state: ConnectionState,
	transferStatus?: string | null,
	serverReceipt?: ServerReceiptStatus | null,
	attentionCount = 0,
): string {
	let base: string;
	switch (state.kind) {
		case "disconnected":
			base = "YAOS: Disconnected";
			break;
		case "loading_cache":
			base = "YAOS: Loading...";
			break;
		case "connecting":
			base = "YAOS: Connecting...";
			break;
		case "online":
			base = "YAOS: Connected";
			break;
		case "offline":
			base = "YAOS: Offline";
			break;
		case "auth_failed":
			switch (state.code) {
				case "unclaimed":
					base = "YAOS: Server unclaimed";
					break;
				case "server_misconfigured":
					base = "YAOS: Server misconfigured";
					break;
				case "unauthorized":
				default:
					base = "YAOS: Auth rejected";
					break;
			}
			break;
		case "server_update_required":
			base = "YAOS: Update required";
			break;
	}
	if (transferStatus) base = `${base} (${transferStatus})`;
	const receipt = serverReceipt && shouldShowReceiptStatus(state)
		? getServerReceiptStatusLabel(serverReceipt, state.kind === "online")
		: null;
	if (attentionCount > 0) {
		base = `${base} · ${attentionCount} file${attentionCount === 1 ? "" : "s"} need attention`;
	}
	// Ranked ahead of the receipt: a receipt can be outstanding merely because
	// nothing was sent, whereas this says the server cannot store what it has
	// already accepted.  Shown even while "Connected", because a healthy socket
	// is exactly what makes this failure invisible.
	if (serverReceipt?.serverPersistenceDegraded === true) {
		base = `${base} · Server not saving`;
	}
	return receipt ? `${base} · ${receipt}` : base;
}

function shouldShowReceiptStatus(state: ConnectionState): boolean {
	return state.kind === "online" || state.kind === "offline";
}

export const SERVER_RECEIPT_STATUS_TITLE =
	"Server receipt means this device’s latest local CRDT state was written to the server’s storage. It does not prove that another device received the change.";

/**
 * Shown against a server that predates the durability marker, where the
 * state-vector fallback proves only an in-memory apply.  Kept as a separate
 * string rather than softening the main one: the common case now genuinely is
 * durable, and describing it as though it were not is the mistake this
 * replaces.
 */
export const SERVER_RECEIPT_STATUS_TITLE_LEGACY =
	"Server receipt means this device’s latest local CRDT state was applied to the server Y.Doc in memory. This server does not report storage confirmation, so the receipt does not prove durable storage or that another device received the change.";

export function getServerReceiptStatusTitle(receipt?: ServerReceiptStatus | null): string {
	return receipt?.receiptGuaranteeIsDurable === true
		? SERVER_RECEIPT_STATUS_TITLE
		: SERVER_RECEIPT_STATUS_TITLE_LEGACY;
}

function fmtTime(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function getServerReceiptStatusLabel(
	receipt: ServerReceiptStatus,
	connected: boolean,
): string {
	// "saved" is claimed only when the durable marker is in force; otherwise the
	// weaker "received" wording stands, because that is all the fallback proves.
	const durable = receipt.receiptGuaranteeIsDurable === true;
	let label: string;
	if (receipt.serverAppliedLocalState === true && connected) {
		label = durable
			? "Receipt: server saved latest local state"
			: "Receipt: server received latest local state";
	} else if (receipt.serverAppliedLocalState === false && connected) {
		label = "Receipt: local state not yet received by server";
	} else if (receipt.serverAppliedLocalState === false && !connected) {
		label = "Receipt: offline — local state not yet received by server";
	} else if (receipt.serverAppliedLocalState === true && !connected && receipt.lastServerReceiptEchoAt !== null) {
		label = durable
			? `Receipt: offline — server saved at ${fmtTime(receipt.lastServerReceiptEchoAt)}`
			: `Receipt: offline — server receipt at ${fmtTime(receipt.lastServerReceiptEchoAt)}`;
	} else if (receipt.serverReceiptStartupValidation === "skipped_local_yjs_timeout") {
		label = "Receipt: unchecked — local cache still loading";
	} else if (receipt.lastKnownServerReceiptEchoAt !== null && receipt.lastServerReceiptEchoAt === null) {
		label = `Receipt: last known server receipt at ${fmtTime(receipt.lastKnownServerReceiptEchoAt)} — checking…`;
	} else {
		label = "Receipt: not tracked yet";
	}
	if (receipt.candidatePersistenceHealthy === false) {
		label += " — receipt history not saved locally";
	}
	return label;
}

export function renderSyncStatus(
	statusBarEl: HTMLElement,
	state: SyncStatus,
	transferStatus?: string | null,
	attentionCount = 0,
): void {
	let text = getSyncStatusLabel(state);
	if (transferStatus) {
		text += ` (${transferStatus})`;
	}
	if (attentionCount > 0) {
		text += ` · ${attentionCount} file${attentionCount === 1 ? "" : "s"} need attention`;
	}
	statusBarEl.setText(text);
}

/**
 * Renders the status bar using the rich ConnectionState label. Prefer this
 * over renderSyncStatus when the ConnectionState is available.
 */
export function renderConnectionState(
	statusBarEl: HTMLElement,
	state: ConnectionState,
	transferStatus?: string | null,
	serverReceipt?: ServerReceiptStatus | null,
	attentionCount = 0,
): void {
	statusBarEl.setText(getLabelFromConnectionState(state, transferStatus, serverReceipt, attentionCount));
	const title = serverReceipt && shouldShowReceiptStatus(state)
		? getServerReceiptStatusTitle(serverReceipt)
		: "";
	statusBarEl.setAttr("title", title);
}
