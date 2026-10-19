# DNDPlace Sync · 0.1.0 test release

Desktop-only Obsidian plugin for DNDPlace campaign archives. The native panel can
receive and send explicitly selected Markdown notes and their private images after
review. Automatic exchange is opt-in per folder and device after a reviewed first
transfer. Local text restoration and all four
reviewed conflict decisions are available. History links open the authenticated
site record for server-side restoration. Local folder bindings can be paused and
resumed without deleting notes or recovery data.
This is not a general-use release.

## Available in the panel

- Native d20 ribbon, command and settings entry, using the site's forged-die mark.
- Multiple named site connections with verified account and server identity.
- Separate campaign, remote archive binding and existing local folder selection.
- Persistent folder bindings, with overlapping, hidden, configuration, symlinked
  and escaping roots rejected.
- Searchable note list and selection of up to 32 notes per reviewed operation.
- Separate receiving/sending tabs, read-only previews, explicit confirmations,
  cancellation and recovery of interrupted operations.
- Settings changes invalidate old selection and approval. Changed files, open
  editors, stale versions and path collisions are guarded by the coordinator;
  unresolved entries remain pending rather than being silently overwritten.
- Read-only server/local history, author/source/time, and text comparison between
  versions or the captured current editor text.
- Separately reviewed local text restoration, with durable disk/editor preimages,
  changed-file guards and interrupted-write recovery. It never rewinds a server base.
- Selected-note comparison with server-version, local-copy, durable-defer and
  keep-local decisions. Keeping local requires a fresh server plan and a separate
  explicit overwrite approval. No automatic or unreviewed overwrite is enabled.
- Native theme colors and responsive layouts. Checkbox/search focus and note-list
  scroll position survive rerenders.

## Connection and data boundaries

Credentials use Obsidian's `SecretStorage`; settings contain secret names, not
plaintext credentials. A separate host secret identifies this installation.
Removing a connection saves removal of its folder bindings before clearing the
local credential. Server-key revocation is managed on DNDPlace's profile page.

Transport uses HTTPS with normal certificate checks; HTTP is allowed only for
literal local loopback addresses. Redirects are forbidden. Requests have
cancellation, deadlines, size limits and strict shared contracts. Opening the
plugin does not scan notes or start network requests.

Receiving writes only through guarded Obsidian Vault/editor adapters. It keeps
unrelated YAML, comments, CRLF and authoring source while retaining reserved local
identity metadata. Only authorized referenced private images are downloaded;
arbitrary external links are never fetched. Board data stays in separate verified
state, not inserted into note prose. Manual subsets do not advance feed cursors.

Per-device, per-identity state includes checksummed journals and plaintext local
preimage/output blobs. **Backups contain private campaign material and are not
encrypted by SecretStorage.** They live in the plugin's state directory and are not
deleted when disconnecting. Retention controls remain future work. Existing
bounded journal/history limits fail closed rather than silently dropping backups.

## Reviewed manual sending

The panel captures exact Markdown/image packages, stores durable reviews,
serializes campaign operations with fenced leases, uploads deterministic bounded
ZIPs and recovers uncertain server commits through immutable matching receipts.
Acknowledgement records the captured local version, never later edits. Sending
has two steps: review the captured package, then approve the server's exact plan.
Staging is not a note commit. A reopened panel can recover its unconfirmed review
or reconcile an uncertain commit without creating another operation.

The local inventory uses file metadata only; capture reads selected notes and
referenced in-root images through guarded adapters. Open-editor text is captured
without saving the note. Raw/legacy/object board metadata and proven local renames
retain their original board and checksums. UTF-8 BOM and CRLF remain exact.
Copied identities, missing assets, two-sided edits and remote-only changes block
confirmation instead of silently selecting an overwrite.

History links, reversible folder pause, optional scheduling and strict typed
checks/callouts are included. Full site-editor parity is not claimed. No
automatic first transfer, implicit deletion or campaign roll is enabled.

## Selected-note conflict decisions

Select one existing linked note and open version comparison. The panel shows the
captured local disk/editor text and the current server version. Each action has a
separate root/connection-scoped, single-use confirmation:

- Take the server version: revalidate the remote revision and use the guarded
  pull writer with the approved disk/editor preimages. Changed files, buffers,
  pending pushes or incompatible versions cannot silently authorize overwrites.
- Create a copy: create a unique sibling Markdown file from the captured local
  text, removing reserved identity metadata without changing the original mapping.
  Existing image links remain relative to the same directory; a separate board
  is not copied. Sending the new note later requires normal reviewed creation.
- Later: persist the remote snapshot and unresolved journal, preserving both
  versions and the old base. Restart/recovery never applies this deferred output.
- Keep local: capture the selected local version and referenced images without
  saving or changing the vault. The first approval stages a bounded package and
  obtains a new server plan; a second approval explicitly authorizes replacing
  the shown server version. Entity, revision, source hash, plan and destination
  must match. Staging alone never commits a note.

Confirmed later acknowledgements retire only pending versions proven covered by
that acknowledgement. Their backup blobs remain in history; a pending newer version
is retained. This prevents resolved conflicts from resurfacing after recovery.
Copy/save crash recovery uses the same durable journal and campaign lease.
Server/copy/defer decisions make no server note mutation or transfer approval.
Keeping local is a separate reviewed transfer: its durable intent stores the
current server version separately from the old real synchronization baseline.
That baseline is not fabricated or advanced before a verified matching receipt.
The same review predicate gates both the button and the push runner. Conflict
rows are allowed only for an explicit captured overwrite of that exact entity.
Canceling the final step keeps an unapproved plan; continue it from the sending
tab. Reopened reviews clearly say overwrite and still require final approval.
Later local edits are neither sent nor written over by acknowledgement. Uncertain
commits retain their immutable operation identity and recover without a second
commit. Revoked write permission and stale plans pause rather than overwrite.

## History and comparison

Select one note and open its history. The panel separates server versions from
local preimage, unsaved-editor and delivered snapshots retained by receiving.
Server rows show the public actor name, trusted source and UTC timestamp rendered
in the user's locale. Local journals have no historical timestamp; none is invented.

The text view compares two selected versions or a version with a snapshot of the
current file/editor buffer. It renders inert text, not HTML, image embeds, scripts
or a board/image diff. Opening history never saves a file or advances a sync base.

A bounded panel-lifetime memory cache supports explicitly labelled saved history
when the network is unavailable. It is scoped to identity, root, note, cursor and
version. No cache means unavailable history, not an empty history. A known 401/403
clears cached server history for the whole connection; local backup blobs remain.
Closing the panel disposes memory caches. It does not make history available offline
after restarting Obsidian.

For an existing linked file, select a version and choose local text restoration.
A separate review shows the exact current text (including an open unsaved buffer)
and proposed replacement. Only its single-use confirmation authorizes the write.
The guarded writer stores disk/editor preimages before writing and preserves later
edits; a crash can recover exact output without writing again. The old server
baseline, board, image state and feed cursor stay unchanged. Restored text remains
a pending local edit, never an automatically suppressed sync write. An unchanged
restoration creates no journal. Missing, unlinked or foreign-identity files cannot
be recreated or rebound through this action. Images and boards are not restored.
No server restore/purge capability, upload or implicit sending is involved.

## Requirements

- Obsidian Desktop 1.11.4+ with working `SecretStorage` (development typings 1.12.3).
- Node.js 22.18+ for development.
- A DNDPlace site with the archive/Obsidian schema and API enabled,
  `NEXTAUTH_URL` matching its origin, and a stable `ARCHIVE_INSTANCE_ID`.
- A scoped DNDPlace Obsidian key and permission to read the chosen archive.
  Sending and creating a remote binding additionally require site write permission.

Working-site migrations and deployments are separate operations. A successful
plugin build does not activate a server whose required schema is absent.

## Development and verification

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run build
npm run check:contracts -- /path/to/dndplace-site
```

Build output is `main.js`; distribution metadata/assets are `manifest.json`
and `styles.css`. Builds and tests do not install into a vault. Dependencies are
pinned. Obsidian remains external to the CommonJS host bundle. The explicit-path
contract comparison imports no site runtime source.

Latest verification: 283 plugin tests, type checking, CommonJS build, byte-identical
shared contracts and 11 authenticated HTTP/isolated-SQLite integration checks pass.
The new native keep-local fixture uses physical temporary notes, a genuine site
edit, two approvals, service reopen and a deliberately lost commit response. It
checks exact overwrite revision, unchanged later local edits, revoked write access
and a stale plan after a newer server edit. Unit regressions cover immutable intent,
old-baseline acknowledgement, wrong targets/actions, blocked reviews, corruption,
no implicit apply and resumable explicit approval. The prior checkpoint of 177
site integration and 200 archive regression tests was not rerun for this package.

The renderer browser fixture uses the actual panel/controller with synthetic
service data. Tests cover 300/390px panels and a 1366×768 host, keyboard/search,
scroll retention, two-step sending approval, history comparison/cache labels,
local restoration review/cancel/confirmation without sending, safe focus return,
server/copy/defer review and cancellation, visible destinations and safe focus,
two-step keep-local overwrite, final-step cancellation, resumed explicit overwrite
and disabled blocked plans, with focus kept away from automatic final approval,
focus restoration, invalidation, campaign switching, literal HTML-like
titles, light/dark themes and overflow. Run `node scripts/panel-browser-server.mjs`,
then `python test/browser/test_panel.py` with an independently installed Python
Playwright/browser toolchain. Optional `PANEL_TEST_PORT`, `PANEL_TEST_URL` and
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` select the isolated fixture and test browser.

From the site checkout run `npm run test:obsidian-sync`; the test expects a sibling
plugin checkout or an explicit `DNDPLACE_OBSIDIAN_PLUGIN_PATH`. It uses isolated
fixtures, never the application datasource.

No working vault was accessed or modified. These are renderer, VM, synthetic-host
and filesystem/HTTP checks, **not installed Obsidian acceptance**, actual editor
undo, power-loss, network-filesystem, multi-OS or two-physical-device acceptance.

## Community distribution

The official [submission guide](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
uses a pull request to the [community directory](https://community.obsidian.md),
with the Obsidian account linked to the repository owner's GitHub account.
Submission needs a public repository README, manifest, owner-selected license and
a GitHub release whose tag matches the manifest version. Release assets are
`main.js`, `manifest.json` and optionally `styles.css`. Review is not automatic.

Before publication: finish guarded manual exchange/conflict/history controls,
test in a new synthetic Obsidian vault, document network and account requirements,
choose a license and explicitly approve release. An opt-in BRAT beta is also
possible. No commit, push, release, community submission or license selection was
performed by this build.
