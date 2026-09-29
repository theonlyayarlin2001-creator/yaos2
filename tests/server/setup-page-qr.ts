import { sha256Hex } from "../../server/src/hex";
import { handleClaimRoute } from "../../server/src/routes/auth";
import type { AuthState, Env } from "../../server/src/routes/types";
import { renderSetupPage } from "../../server/src/setupPage";
import { buildMobileSetupUrl, renderSetupQrDataUrl } from "../../server/src/setupQr";
import { makeConfigNamespace, makeEnv } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("setup-page-qr");

function decodeSvgDataUrl(dataUrl: string): string {
	const prefix = "data:image/svg+xml;base64,";
	if (!dataUrl.startsWith(prefix)) {
		throw new Error("expected an SVG data URL");
	}
	return Buffer.from(dataUrl.slice(prefix.length), "base64").toString("utf8");
}

s.section("Setup QR renderer stays local to the Worker");
const host = "https://example.test";
const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const vaultId = "vault-identifier";
const mobileSetupUrl = buildMobileSetupUrl(host, token, vaultId);
const renderedQr = await renderSetupQrDataUrl(mobileSetupUrl);
const svg = decodeSvgDataUrl(renderedQr);

s.check(renderedQr.startsWith("data:image/svg+xml;base64,"), "renderer returns an SVG data URL");
s.check(svg.includes("<svg ") && svg.includes("shape-rendering=\"crispEdges\""), "renderer emits a QR SVG");
s.check(svg.includes("fill=\"#08111d\"") && svg.includes("fill=\"white\""), "renderer preserves the setup QR colors");
s.check(!svg.includes("<script") && !svg.includes("qrious") && !svg.includes("jsdelivr"), "renderer SVG contains no executable or remote QR dependency");
s.check(!/\s(?:href|xlink:href)=/i.test(svg), "renderer SVG has no external resource reference");

let blankRejected = false;
try {
	await renderSetupQrDataUrl("  ");
} catch {
	blankRejected = true;
}
s.check(blankRejected, "renderer rejects an empty setup URL");

s.section("Setup HTML has no external QR runtime");
const setupHtml = renderSetupPage({ host });
s.check(!/qrious/i.test(setupHtml), "setup page does not reference QRious");
s.check(!setupHtml.includes("cdn.jsdelivr.net"), "setup page does not reference jsDelivr");
s.check(!setupHtml.includes("window.QRious"), "setup page does not access the QRious global");
s.check(!setupHtml.includes("<script src="), "setup page has no external script source");
s.check(setupHtml.includes("data:image/svg+xml;base64,") && setupHtml.includes("document.createElement(\"img\")"), "setup page renders the Worker-provided local QR image");
s.check(setupHtml.includes("host-input") && setupHtml.includes("token-input") && setupHtml.includes("vault-input"), "manual setup fallback remains available");

s.section("Claim response returns a local QR without persisting the token");
let claimWriteCount = 0;
let persistedTokenHash: string | null = null;
const claimedConfig = {
	claimed: true,
	tokenHash: "placeholder",
	updateProvider: null,
	updateRepoUrl: null,
	updateRepoBranch: null,
};

// The stub reads the claim body off the Request rather than a raw RequestInit,
// which is what the Durable Object actually receives.
const env: Env = makeEnv({
	YAOS_CONFIG: makeConfigNamespace(async (req) => {
		const pathname = new URL(req.url).pathname;
		if (pathname === "/__yaos/claim") {
			claimWriteCount++;
			const body = JSON.parse(await req.text()) as { tokenHash?: string };
			persistedTokenHash = body.tokenHash ?? null;
			claimedConfig.tokenHash = persistedTokenHash ?? "placeholder";
			return new Response(null, { status: 200 });
		}
		if (pathname === "/__yaos/config") {
			return new Response(JSON.stringify(claimedConfig), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		throw new Error(`unexpected config request: ${pathname}`);
	}),
});
const unclaimed: AuthState = { mode: "unclaimed", claimed: false };

const invalidClaim = await handleClaimRoute(
	new Request(`${host}/claim`, { method: "POST", body: JSON.stringify({ token: "too-short", vaultId }) }),
	env,
	unclaimed,
);
s.check(invalidClaim.status === 400 && claimWriteCount === 0, "invalid claim does not write configuration");

const claimResponse = await handleClaimRoute(
	new Request(`${host}/claim`, { method: "POST", body: JSON.stringify({ token, vaultId }) }),
	env,
	unclaimed,
);
const claimBody = await claimResponse.json() as { mobileSetupQrDataUrl?: string };
const expectedHash = await sha256Hex(new TextEncoder().encode(token));

s.check(claimResponse.status === 200, "valid claim succeeds");
s.check(claimWriteCount === 1, "valid claim writes configuration once");
s.check(persistedTokenHash === expectedHash && persistedTokenHash !== token, "claim persists only the token hash");
s.check(claimBody.mobileSetupQrDataUrl === renderedQr, "claim response returns the local QR for the exact mobile setup URL");
s.check(!decodeSvgDataUrl(claimBody.mobileSetupQrDataUrl ?? "").includes("jsdelivr"), "claim QR has no remote reference");

const alreadyClaimed: AuthState = { mode: "claim", claimed: true, tokenHash: expectedHash };
const secondClaim = await handleClaimRoute(
	new Request(`${host}/claim`, { method: "POST", body: JSON.stringify({ token, vaultId }) }),
	env,
	alreadyClaimed,
);
s.check(secondClaim.status === 403 && claimWriteCount === 1, "already claimed server does not write configuration again");
await s.done();
