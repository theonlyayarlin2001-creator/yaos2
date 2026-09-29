/**
 * Minimal ambient declaration for the `ws` package.
 *
 * `ws` ships no types and @types/ws is not a dependency; qa/ uses exactly one
 * WebSocket client (the raw CDP transport in qa/controllers/). Following the
 * src/js-yaml.d.ts and src/types/qrcode.d.ts convention, only the surface the
 * harness actually calls is declared — deliberately not the whole package.
 */
declare module "ws" {
	interface WebSocketEventMap {
		open: () => void;
		close: (code: number, reason: Buffer) => void;
		error: (err: Error) => void;
		message: (data: Buffer) => void;
	}

	class WebSocket {
		/** readyState value for an established connection. */
		static readonly OPEN: 1;
		constructor(url: string);
		readonly readyState: number;
		on<K extends keyof WebSocketEventMap>(event: K, listener: WebSocketEventMap[K]): this;
		send(data: string): void;
		close(code?: number, reason?: string): void;
	}

	export default WebSocket;
}
