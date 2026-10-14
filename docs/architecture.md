# Architecture

Paseo Deck has three deep modules joined by small, typed interfaces.

## Gateway seam

`PaseoGateway` is the application's entire Paseo-facing surface: connect and close, read and observe the directory, focus and release one timeline, and execute typed commands. `ProductionPaseoGateway` contains SDK projection, replacement recovery, subscription ownership, target resolution, and the shell-free CLI fallback. `FakePaseoGateway` implements the same contract for deterministic store and application tests.

The gateway uses public `@getpaseo/client` APIs for discovery, timelines, creation, prompts, permissions, archive, and detach. A subprocess adapter invokes documented CLI commands for stop, Session rename, standalone thinking-level changes and operational mode. Narrow adapters own the pinned package-exported `internal/daemon-client` contracts for Git metadata, supported Session model mutation and its dependent thinking setter, Terminal rename and authoritative Terminal title/activity reads (the public 0.11.2 projection strips these fields), per-Session completion acknowledgement (absent from the public SDK), provider command discovery for Session drafts, and native Workspace label definitions/colors (absent from the public Workspace projection). Each adapter limits its operations, shares resolved authentication/target, and closes its owned connection; no broad private-client access or daemon modification is required. It always passes an executable and argument array, parses JSON, captures stderr, and never launches a shell.

## Store and terminal presentation

The store is a pure reducer over normalized project, workspace, agent, connection, modal, permission, and focused-timeline state. Workspace identity is always the Paseo workspace ID. Unknown timeline items remain visible, while assistant deltas and tool updates merge through their stable message or call IDs. Epoch and sequence cursors prevent duplicate delivery across hydration and reconnection.

No reducer imports terminal, SDK, or subprocess code. This keeps state transitions reproducible and makes races testable without a daemon.

`DeckTui` owns terminal-only presentation such as pane width, scrolling, overlays, and the effective semantic theme. Terminal capabilities are detected once by the runtime and injected. The theme module distinguishes Deck-owned chrome, sanitized remote text, and already-sanitized Markdown render output, so ANSI styling cannot turn daemon content into terminal control sequences. No-color and ASCII choices retain textual state markers and width-safe clipping.

## Subscription lifecycle

The application subscribes to directory changes before requesting the initial snapshot, buffering early updates until hydration completes. Focusing an agent releases the previous timeline observation and assigns a generation token so late callbacks cannot mutate the new focus.

The timeline adapter subscribes before fetching history. Live events received during hydration are buffered, merged with projected history by epoch and sequence, and replayed exactly once. The SDK restores focused timeline demand after reconnect; its replacement event triggers a fresh projected-history fetch without discarding live events that arrive during that fetch.

On quit, Ctrl+C, connection failure, or an uncaught error, the controller releases its focused and directory observations, closes the gateway, and restores the terminal's alternate screen exactly once. Pinned public client 0.11.2 returns public owned subscriptions from Agent and Workspace directory queries. The gateway retains and releases those handles with its observation, including partial startup failures. The SDK restores the same owned query lifetimes after reconnect; the gateway does not create another query. Because no public connection-state listener is exposed, the gateway samples public connection state every 200 ms only to trigger controller snapshot/timeline recovery. Palette **Refresh directory / reconnect** remains available for explicit recovery.

Workspace activity and timestamps come directly from Paseo summaries. The controller acknowledges only finished attention on the displayed Session, after timeline hydration; permission/error attention and unopened Sessions are preserved. Terminal focus reports suspend acknowledgement while hidden and resume it on focus-in. Terminals that do not report focus default to visible while Deck runs. Attention is persisted by Paseo, never stored in Deck preferences.

Provider completion uses public SDK 0.11.2 `Agent.commands()` for existing Sessions. Drafts use a separately owned package-exported DaemonClient connection because the public Agent handle cannot represent unsent provider/Workspace configuration. Catalogs are transient and keyed by resource, provider, Workspace directory and draft settings; late results cannot replace a different current context. Missing command kind remains unclassified and is eligible only at prompt start.

Workspace label assignments come from public Workspace summaries; a lazily owned native label catalog supplies their colors. Its owned query is released with the directory observation. A failed query is released and retried independently every 500 ms while the observation remains active, without changing the main connection state. Retry timers and late callbacks are canceled on release.

`RecordingTerminal` uses the official xterm Unicode 11 addon for modern emoji cell widths. Report captures retain RGB foreground/background cells; simulated default/indexed foregrounds and physical font painting remain outside that evidence.

## Preference lifecycle

The runtime opens one preference session before constructing the controller or terminal view. The session validates a strict versioned allowlist and hydrates only tree ordering, archived visibility, expanded group IDs, tree width, theme, and symbol choices. Theme and symbols are global; tree state is keyed by a hash of the normalized daemon target. Passwords and raw target strings never enter the preference schema.

State and presentation changes update a small safe projection. Writes are deduplicated, debounced, serialized, and flushed during shutdown. The storage adapter writes a private temporary file, synchronizes it, atomically renames it, and synchronizes the containing directory. Missing files use defaults; corrupt or unsupported versions produce a generic warning without exposing file contents or credentials.

Serialization covers writes from one running Deck process. v0.1 does not coordinate concurrent processes; if several instances share the same preference file, the last process to save wins.
