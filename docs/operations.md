# Operations

## Deploy

Use the repository's **Deploy to Cloudflare** button. It targets `server/`, provisions the Worker and Durable Object bindings, and starts unclaimed. Visit the Worker URL, claim it in the browser, and use the generated Obsidian setup link.

The default deployment is Markdown-only. No `SYNC_TOKEN` or R2 bucket is required.

### Optional R2

To enable attachments and snapshots, create an R2 bucket and bind it as `YAOS_BUCKET`. If the dashboard cannot add the binding, add this to the generated deployment repository's `wrangler.toml` and push:

```toml
[[r2_buckets]]
binding = "YAOS_BUCKET"
bucket_name = "your-bucket-name"
```

Capabilities refresh dynamically after deployment.

## Update an existing deployment

The Deploy button creates a detached repository. Upstream pushes do not update it automatically.

Git is the update boundary because the generated deployment is detached from upstream and already owns the Worker configuration. Re-running initial deployment can create a new project path; server self-mutation would require Cloudflare credentials. Applying a release artifact as an ordinary repository commit keeps deployment and rollback visible without either risk.

1. Set the generated deployment repository URL in YAOS settings.
2. Run **Initialize updater** once if the repository lacks the workflow.
3. Run **Open update action** and choose update or revert.
4. Cloudflare deploys the resulting repository commit.

Update metadata uses patch semantics so a new or legacy device cannot clear established server configuration with empty values.

## Local development

```sh
npm install
cd server && npm install && cd ..
npm run build
npm run test:ci
```

Run the Worker directly when needed:

```sh
cd server
npm run dev -- --var SYNC_TOKEN:dev-sync-token
```

Without `SYNC_TOKEN`, the local server starts unclaimed and can be claimed through the browser.

## Manual deployment

```sh
cd server
npm install
npm run deploy
```

## Authentication migration

Normal WebSocket connections use short-lived `?ticket=` credentials. Legacy clients may use `?token=` during the migration window.

Tickets keep the long-lived bearer token out of normal WebSocket URLs. The plugin refreshes and patches the provider URL because the current `y-partyserver` reconnect loop reuses that URL without re-running asynchronous connection parameters.

After every client is ticket-aware, set:

```toml
[vars]
YAOS_DISABLE_LEGACY_WS_TOKEN = "true"
```

Before announcing migration completion, execute BACKLOG `OPS-02`: a ticket-aware plugin must connect, an old token-query client must receive 401 before room wake, and Worker logs must show pre-auth rejection rather than a Durable Object error.

## Schema updates

Client and server support one exact schema version. A schema bump requires coordinated updates to:

Exact admission is deliberate: a writer using an incompatible CRDT shape can corrupt shared state. A compatibility range is valid only when an upgrade defines backward-compatible read/write semantics and migration ownership; it is not the default.

- `src/sync/schema.ts`;
- `server/src/version.ts`;
- `scripts/guard-schema-version.mjs`.

Run:

```sh
npm run guard:schema-version
npm run test:regressions
```

Do not deploy a mixed writer fleet. Admission rejects absent or mismatched schema declarations with `update_required`.

## Release gates

```sh
npm run build
npm run typecheck:tests
npm run typecheck:qa
npm run test:ci
npm run lint
npm run guard:production-bundles
npm run guard:no-tracked-generated-artifacts
npm run guard:no-any
```

`test:ci` runs regression suites and the local Wrangler integration driver. The driver covers schema admission, provider connection, two sync passes, snapshots, server hardening, ticket reconnect, and socket admission protocol.

Real-device and external-deployment evidence is separate; see [QA](qa.md) and [BACKLOG](BACKLOG.md).

## Troubleshooting

- **Unauthorized/Auth rejected:** verify server URL and token; reconnect. Persistent idle rejection is tracked as `ISSUE-68`.
- **R2 not configured:** add `YAOS_BUCKET`; Markdown remains available without it.
- **Cloudflare build/dashboard instability:** retry once, then commit the binding/configuration through the generated repository. Record the failed deployment commit SHA in any issue.
- **Files not syncing:** check exclusions, file-size limits, status, and diagnostics.
- **Server receipt waiting:** reconnect and allow local cache loading to finish. A receipt is latest-state confirmation, not other-device delivery.

## Current limits

- One vault-wide Yjs document per room.
- Empty folders are not synchronized.
- Attachment upload cap: 10 MB by default.
- Text persistence is bounded by SQLite row/statement limits and the checkpoint/journal policy.
- Server memory is bounded by the 128 MB isolate and CRDT struct growth.
- Native Windows, Docker, headless CLI, multi-vault control plane, sharding, and `.obsidian` sync are not `main` behavior.
