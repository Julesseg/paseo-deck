# Architecture

Paseo Deck has three deep modules joined by small, typed interfaces.

## Gateway seam

`PaseoGateway` is the application's entire Paseo-facing surface: connect and close, read and observe the directory, focus and release one timeline, and execute typed commands. `ProductionPaseoGateway` contains SDK projection, cursor recovery, subscription ownership, target resolution, and the shell-free CLI fallback. `FakePaseoGateway` implements the same contract for deterministic store and application tests.

The gateway uses public `@getpaseo/client` APIs for discovery, timelines, creation, prompts, permissions, archive, and detach. A subprocess adapter invokes documented CLI commands for stop, rename, mode, and thinking because those operations are not in the public SDK. It always passes an executable and argument array, parses JSON, captures stderr, and never launches a shell.

## Store and terminal presentation

The store is a pure reducer over normalized project, workspace, agent, connection, modal, permission, and focused-timeline state. Workspace identity is always the Paseo workspace ID. Unknown timeline items remain visible, while assistant deltas and tool updates merge through their stable message or call IDs. Epoch and sequence cursors prevent duplicate delivery across hydration and reconnection.

No reducer imports terminal, SDK, or subprocess code. This keeps state transitions reproducible and makes races testable without a daemon.

`DeckTui` owns terminal-only presentation such as pane width, scrolling, overlays, and the effective semantic theme. Terminal capabilities are detected once by the runtime and injected. The theme module distinguishes Deck-owned chrome, sanitized remote text, and already-sanitized Markdown render output, so ANSI styling cannot turn daemon content into terminal control sequences. No-color and ASCII choices retain textual state markers and width-safe clipping.

## Subscription lifecycle

The application subscribes to directory changes before requesting the initial snapshot, buffering early updates until hydration completes. Focusing an agent releases the previous timeline observation and assigns a generation token so late callbacks cannot mutate the new focus.

The timeline adapter subscribes before fetching history. Live events received during hydration are buffered, merged with projected history by epoch and sequence, and replayed exactly once. Replacements reset projected state without discarding live events that arrive during the replacement fetch. Reconnect recovery requests events after the last accepted cursor.

On quit, Ctrl+C, connection failure, or an uncaught error, the controller releases its focused and directory observations, closes the gateway, and restores the terminal's alternate screen exactly once.

## Preference lifecycle

The runtime opens one preference session before constructing the controller or terminal view. The session validates a strict versioned allowlist and hydrates only tree ordering, archived visibility, expanded group IDs, tree width, theme, and symbol choices. Theme and symbols are global; tree state is keyed by a hash of the normalized daemon target. Passwords and raw target strings never enter the preference schema.

State and presentation changes update a small safe projection. Writes are deduplicated, debounced, serialized, and flushed during shutdown. The storage adapter writes a private temporary file, synchronizes it, atomically renames it, and synchronizes the containing directory. Missing files use defaults; corrupt or unsupported versions produce a generic warning without exposing file contents or credentials.

Serialization covers writes from one running Deck process. v0.1 does not coordinate concurrent processes; if several instances share the same preference file, the last process to save wins.
