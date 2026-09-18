# Architecture

Paseo Deck has three deep modules joined by small, typed interfaces.

## Gateway seam

`PaseoGateway` is the application's entire Paseo-facing surface: connect and close, read and observe the directory, focus and release one timeline, and execute typed commands. `ProductionPaseoGateway` contains SDK projection, cursor recovery, subscription ownership, target resolution, and the shell-free CLI fallback. `FakePaseoGateway` implements the same contract for deterministic store and application tests.

The gateway uses public `@getpaseo/client` APIs for discovery, timelines, creation, prompts, permissions, archive, and detach. A subprocess adapter invokes documented CLI commands for stop, rename, mode, and thinking because those operations are not in the public SDK. It always passes an executable and argument array, parses JSON, captures stderr, and never launches a shell.

## Store

The store is a pure reducer over normalized project, workspace, agent, connection, modal, permission, and focused-timeline state. Workspace identity is always the Paseo workspace ID. Unknown timeline items remain visible, while assistant deltas and tool updates merge through their stable message or call IDs. Epoch and sequence cursors prevent duplicate delivery across hydration and reconnection.

No reducer imports terminal, SDK, or subprocess code. This keeps state transitions reproducible and makes races testable without a daemon.

## Subscription lifecycle

The application subscribes to directory changes before requesting the initial snapshot, buffering early updates until hydration completes. Focusing an agent releases the previous timeline observation and assigns a generation token so late callbacks cannot mutate the new focus.

The timeline adapter subscribes before fetching history. Live events received during hydration are buffered, merged with projected history by epoch and sequence, and replayed exactly once. Replacements reset projected state without discarding live events that arrive during the replacement fetch. Reconnect recovery requests events after the last accepted cursor.

On quit, Ctrl+C, connection failure, or an uncaught error, the controller releases its focused and directory observations, closes the gateway, and restores the terminal's alternate screen exactly once.
