# Paseo Deck

Paseo Deck is a terminal client for working with several Paseo sessions without losing the context of the workspace that owns them.

## Organization

**Project**:
A named group of related workspaces.

**Workspace**:
A working directory registered with Paseo. A workspace contains sessions and terminals.

**Session**:
The user-facing conversation and activity history for one AI coding agent in a workspace. Sessions appear in the active workspace's tab row and timeline, not the sidebar.
_Avoid_: Agent, chat, conversation

**Agent**:
The provider-backed worker that performs a session's task. Use this term when the distinction from the user-facing session matters.
_Avoid_: Session process

**Terminal**:
A persistent shell owned by a workspace. Terminals appear in the active workspace's tab row, not the sidebar or a session timeline.
_Avoid_: Console, shell tab

## Interface

**Active workspace**:
The workspace whose session and terminal tabs occupy the main pane. Opening a workspace makes it active; moving the sidebar selection does not.
_Avoid_: Selected workspace

**Active session**:
The session whose timeline and composer occupy the main pane within the active workspace.
_Avoid_: Focused session, selected agent

**Sidebar selection**:
The project or workspace row that sidebar navigation will act on. It is highlighted only while the sidebar is active. Opening a workspace makes it active.
_Avoid_: Active workspace, focus

**Timeline**:
The ordered, live record of messages, reasoning, tool activity, permissions, turn state, and errors in the active session.
_Avoid_: Transcript, log, output

**Main pane**:
The bordered region beside the sidebar that contains the active workspace's session and terminal tabs, the active timeline, the composer, and session status.
_Avoid_: Timeline window, right-side region

**Composer**:
The editor and session controls used to send the next prompt to the active session.
_Avoid_: Prompt box, input

**Choice picker**:
A centered, bordered list for choosing a provider, model, thinking level, or operational mode. A choice picker may support filtering, disabled choices, and a preselected value.
_Avoid_: Ticker, selection dialog

**Active region**:
The composer, sidebar, or timeline currently receiving keyboard commands. Its border is brighter than the other regions.
_Avoid_: Pane focus, focus area

**Normal mode**:
The default Vim mode for the composer or timeline. Composer normal mode is the application's resting state; timeline normal mode navigates its read-only buffer.

**Insert mode**:
The composer-only Vim mode for entering prompt text. Pressing Escape returns the composer to normal mode.

**Visual mode**:
The Vim mode for selecting text in the composer or read-only timeline. Pressing Escape clears the selection and returns that region to normal mode.

**Sidebar navigation**:
The temporary active region for moving the sidebar selection and opening workspaces. Pressing Escape returns to composer normal mode.
_Avoid_: Sidebar mode, tree focus

**Timeline navigation**:
The temporary active region that presents the rendered timeline as a read-only Vim buffer with a text cursor. Escape from timeline normal mode returns to composer normal mode.
_Avoid_: Cursor mode, timeline mode, timeline selection

**Activity indicator**:
A semantic visual cue for live work, waiting permission, failure, stale data, or unread activity. Text or symbols must carry the meaning when color is unavailable.
_Avoid_: Status color

**Workspace activity**:
The roll-up state of a workspace's sessions and terminals. `attention` means intervention is required, `working` means at least one resource is active, `idle` means resources are available or the workspace is empty and launchable, and `done` means the workspace previously had resources and all have ended or been archived.
_Avoid_: Workspace status

**Key cue**:
A short, dimmed key label placed beside a Paseo-specific value or action such as the model, thinking level, or operational mode. Ordinary Vim movement and confirmation keys do not need key cues.
_Avoid_: Shortcut hint, footer help
