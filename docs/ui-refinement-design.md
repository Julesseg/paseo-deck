# Timeline, sidebar, and composer refinements

Accepted design for the Timeline, Sidebar, Composer, and provider suggestions. This preserves the design decisions and capability evidence from the interview. See [implementation verification](ui-refinement-verification.md) for the implemented behavior, checks and remaining acceptance limits.

## Settled decisions

- The Sidebar continues to list Workspaces. Sessions and Terminals remain in the Active workspace's Tab row, consistent with ADR-0001.
- Add status grouping for Workspaces and make it the initial default. Retain Project grouping as another listing option. Display groups in the originally requested order: Waiting for user input, Failed, Ready to review, Working, then Done.
- Use Paseo's native Workspace bucket and aggregation priority, including its Session, subagent, and Terminal contributions. A Workspace with both a running Session and an unread completed Session can remain Working. Display-group ordering does not override this bucket choice. Do not add separate Idle or Stopped Workspace groups; preserve the existing archived visibility toggle.
- Session review state is based on whether a completed turn has been seen: Ready to review means the agent finished a turn but the user has not opened the Session to see it; opening that Session makes the completed turn Done. Done does not require a manual completion action or imply task acceptance.
- Acknowledge only the opened Session's finished attention. Other unopened Sessions retain their review attention. Merely highlighting a Workspace or displaying a Terminal does not acknowledge a Session. A Session finishing while it is already displayed and Deck is visible is immediately considered seen, even when Sidebar navigation owns keyboard input.
- Right-align each user message block, keep its text left-aligned, and limit the block to roughly three quarters of the reading column. Give it a dedicated subtle background. Assistant messages remain left-aligned.
- Tool calls have a separate reading-column background, including expanded output, bounded before a visible scrollbar. Separate Timeline blocks with a blank row, including consecutive tools and user/assistant boundaries; omit per-tool divider rules. Message bodies have no author/time heading.
- Bare `i` in Sidebar navigation or idle Timeline Normal focuses the currently displayed Workspace's Composer in Insert mode. It does not activate the highlighted Sidebar row. Preserve text-object input such as `yiw` and Visual `iw`, search/filter text, pending character input, and literal Terminal input.
- Enter on a Workspace row restores its active Tab and focuses the appropriate content: Session Composer with its saved mode/cursor, direct Terminal input, or an empty Workspace's Launch composer. Enter on a grouping row toggles its expansion; `h` and `l` retain collapse and expand meanings.
- `s` in Sidebar navigation toggles Status/Project grouping and persists the chosen grouping across launches. Filtering treats `s` as ordinary text input.
- Within each group, always order Workspaces by most recent activity first. Migrate saved alphabetical/attention ordering to recent activity; remove the alphabetical toggle. Preserve the highlighted Workspace and freeze automatic regrouping/reordering while Sidebar navigation owns keyboard input; badges update immediately and pending positions apply on leaving the Sidebar. Explicit grouping changes apply immediately.
- Each Workspace has a second metadata line: Status in Project grouping, Project in status grouping. Project metadata has a folder icon; Status metadata is icon-only, with the same icon before status words on grouping headings. Native Paseo Workspace labels share the Tab pill endcaps and are colored pills immediately after metadata on the same row, using subdued native catalog hue tints against the Sidebar surface. Labels are clipped first with a right ellipsis; separate Workspace cards with one empty row. Relative last-activity time has a leading clock icon, is right-aligned, and takes priority over labels when width is constrained; labels use ellipsis.
- Use Paseo's Workspace `activityAt` for compact relative ages such as `now`, `3m`, `2h`, and `4d`; when that field is unavailable, use the most recent native Session update timestamp in the Workspace. Show `—` only when neither source provides a valid timestamp. Do not substitute local opening or observation times.
- Grouping headings have one empty line before and after them.
- The Composer has one empty line after its mode/destination display before the prompt editor, and one empty line after the prompt editor before Session settings. The Main pane always has one blank bottom row, reused for Composer/Timeline search without moving the Composer.
- Decorative blank lines are skipped by keyboard navigation. Keep the requested spacing in constrained layouts. Plain/ASCII terminals retain readable labels, separators, and icon substitutes.

## Additional requested changes

- Reset the Sidebar text query when a Workspace is opened with Enter. Merely moving the highlight with `j`/`k` does not clear it. Preserve the attention-only and archived visibility toggles.
- Remove the entire bottom main-pane status line. Keep Session settings in the Composer; do not preserve the redundant row for its extra provider, usage, connection, permission-count, or notification details. Other existing overlays and commands are not changed by this row removal.
- Fix the right-aligned Composer token count being clipped with ellipsis despite available space. When the full count fits in the actual Composer settings-line content width, display it fully and align it to that content area's right edge. The implementation must reproduce the reported symptom before selecting a fix.
- Increase the Sidebar default from 34 to 51 columns and its adjustable maximum from 48 to 72 columns. Migrate the old automatically saved 34-column default to 51; preserve other custom widths and mark new width choices so an explicitly chosen 34 stays 34. Retain the existing `[`/`]` resizing controls. Switch to the Sidebar drawer when the chosen Sidebar width would leave fewer than 40 columns for the Main pane; retain the existing drawer behavior for narrow terminals.

## Provider suggestions

- Offer skill and command completion only in Composer Insert, in a dropdown directly above the currently entered name. Preserve Normal-mode `/` search, text-object input, and literal Terminal input.
- Fuzzy-filter suggestions using the partial name being typed. A bare triggering slash offers the eligible provider items; no fuzzy matches means no selectable popup. Up/Down navigate suggestions only while the popup is open; otherwise retain editor/history navigation.
- Tab or plain Enter accepts the selected suggestion, replaces the entire reference token (including when the cursor is in its middle), and leaves the cursor after one following space so prompt writing can continue. Reuse an existing following space where possible and preserve surrounding prompt text. Acceptance stays in Insert and never submits, executes a command, or inserts a newline. One undo restores the original partial reference.
- A slash can trigger suggestions only at the beginning of a logical line or immediately after a literal space. A slash immediately after another character does not trigger suggestions, avoiding paths such as `src/file`, `~/file`, and `./file`.
- Typing a space or another slash while suggestions are open dismisses the popup and inserts that character literally. The second slash of `/tmp/file` therefore ends skill completion; `/tmp` at a qualifying boundary initially remains indistinguishable from a skill name.
- Escape first dismisses the popup while staying in Insert; another Escape returns to Normal. Without a popup, preserve existing Tab and Enter meanings. Native paste remains literal input and never accepts a suggestion or submits.
- Suggestions include both skills and ordinary commands such as `/clear`, from the Composer's selected provider only, scoped to its Workspace. For existing Sessions use that Session's provider; for Session drafts use the chosen draft provider. Include personal, Project, and plugin skills when reported by that provider. Do not substitute a daemon-wide skill-management catalog.
- Offer ordinary commands only at the beginning of the prompt; offer skills at all qualifying slash boundaries. A leading slash can therefore offer both commands and skills, while `please /review` offers skills only.
- Insert `/name` for both skills and commands, matching Paseo's native completion and submission behavior. This completion feature does not add provider-specific expansion of embedded skill references; the Codex inline limitation described below is accepted.
- Wrapped-token popup placement and screen overflow must preserve the requested above-token anchoring within terminal bounds.

## Status names and distinct priorities

| Paseo Workspace bucket | Sidebar label | Display group position |
| --- | --- | --- |
| `needs_input` | Waiting for user input | 1 |
| `failed` | Failed | 2 |
| `attention` | Ready to review | 3 |
| `running` | Working | 4 |
| `done` | Done | 5 |

Native bucket selection remains Waiting for user input → Failed → Working → Ready to review → Done. Preserve that aggregation priority while displaying the groups in the order above: a mixed Workspace can be classified Working even when the Ready to review group precedes Working in the Sidebar.

## Capability evidence from the design interview

The inspected Paseo CLI is 0.11.2. Inspection of @getpaseo/client and @getpaseo/protocol 0.8.0, matching this repository's declared dependency versions, confirms Agent `requiresAttention`, `attentionReason` (`finished`, `error`, or `permission`), and `attentionTimestamp`; Workspace summaries expose `status` (`needs_input`, `failed`, `running`, `attention`, or `done`) and nullable `activityAt`. The client exposes `clearAgentAttention` and `clearWorkspaceAttention`.

Deck's current gateway drops Agent attention reason/timestamp and Workspace status/activity timestamp. The review distinction therefore exists upstream even though the current Deck model does not represent it. Separate local persistent review bookkeeping is unnecessary for the agreed model.

Read-only inspection of the installed daemon confirms that finishing a turn sets persisted finished attention, per-Agent clearing persists and emits updated state, and Workspace-wide clearing can acknowledge multiple unopened Sessions. Use per-Session acknowledgement for this design. No live acknowledgement mutation was performed during the interview.

Installed Paseo 0.11.2 also exposes public provider command discovery through `client.agents.ref(id).commands(options)`, returning name, description, argument hint, and optional command/skill kind. Draft discovery accepts provider and Workspace configuration. This API's availability in Deck's pinned SDK 0.8.0 has not yet been established; do not assume the repository already exposes it. Daemon-wide orchestration skill-installation inventory is a different catalog.

Installed Paseo's frontend inserts `/name` for skill completion for both Claude and Codex. Its inline suggestion list includes skill-kind entries. The installed Codex adapter explicitly expands a recognized leading `/skill` into structured skill input and `$skill` text; an embedded `please /skill` does not take that leading-command path and remains ordinary text. Claude receives slash references as text through its SDK. No live skill or slash-command prompt was sent during the interview, so provider execution has not been demonstrated.

The existing pi-tui completion defaults do not match this design: their menu appears below the editor, slash detection is more restrictive, and Enter can proceed to submission. Deck's custom Insert handling also bypasses native Editor input for those keys. Completion must explicitly honor the agreed anchor and key ownership rather than merely enabling library defaults.

## Implementation verification to perform

- Verify native status propagation, per-Session acknowledgement, completion while already displayed, mixed Session/Terminal Workspaces, reconnect, and persisted attention across restart.
- Exercise Enter and bare `i` through the full input/controller/store path, including text objects, pending commands, searches, Terminal passthrough, saved Composer state, and empty Workspace activation.
- Verify grouping persistence, sorting, stable highlighted Workspace identity, live badge updates during frozen navigation, expansion controls, archived visibility, and filters in both grouping modes.
- Verify filter reset on the agreed activation trigger, complete footer removal with the recovered layout height, and full right-aligned Composer token text through the actual Composer rendering path rather than the control-row helper alone.
- Verify the wider Sidebar's defaults, adjustable bounds, preference restoration, and responsive drawer behavior alongside the remaining Main pane width.
- Verify provider catalog discovery and SDK compatibility for existing Sessions and drafts; ensure provider changes do not retain stale suggestions from another provider.
- Verify skill suggestions at line start and after spaces, command eligibility only at prompt start, fuzzy filtering, path exclusion, whole-token replacement and trailing-space insertion, arrow/Tab/Enter ownership, space/slash/Escape dismissal, wrapped-line placement, native paste, and per-resource Composer state. Confirm native leading-command versus inline-skill submission behavior without treating suggestion acceptance as submission.
- Capture matched before/after UI states for user messages, collapsed/expanded tools, both Sidebar groupings, long metadata, missing timestamps, Composer spacing, constrained geometry, and plain/ASCII appearances.
- Verify Timeline cursor/selection/semantic anchors through reflow, streaming, folding, and Session switching; decorative indentation, backgrounds, separators, and padding must not enter copied content.
- Keep automated terminal-frame evidence separate from physical terminal keyboard, clipboard, and visibility behavior that has not been exercised.

## Documentation boundary

The agreed terminology is recorded in CONTEXT.md and source-of-truth ownership in ADR-0003. docs/keymap.md documents current behavior. This design record preserves the accepted decisions; [implementation verification](ui-refinement-verification.md) records the evidence and its boundaries.
