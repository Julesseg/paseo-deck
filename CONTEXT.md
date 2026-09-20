# Paseo Deck

Paseo Deck is a terminal client for working with several Paseo sessions without losing the context of the workspace that owns them.

## Organization

**Project**:
A named group of related workspaces.

**Workspace**:
A working directory registered with Paseo. A workspace contains sessions and terminals.

**Session**:
The user-facing conversation and activity history for one AI coding agent in a workspace. Use this term for sidebar entries, tabs, timelines, and user commands.
_Avoid_: Agent, chat, conversation

**Agent**:
The provider-backed worker that performs a session's task. Use this term when the distinction from the user-facing session matters.
_Avoid_: Session process

**Terminal**:
A persistent shell owned by a workspace. A terminal is a workspace resource, not a session timeline item.
_Avoid_: Console, shell tab

## Interface

**Active session**:
The session whose timeline and composer occupy the main pane. Moving the sidebar selection does not change the active session.
_Avoid_: Focused session, selected agent

**Sidebar selection**:
The highlighted project, workspace, or session row that sidebar navigation will act on. A session becomes active only when the user opens it.
_Avoid_: Active session, focus

**Timeline**:
The ordered, live record of messages, reasoning, tool activity, permissions, turn state, and errors in the active session.
_Avoid_: Transcript, log, output

**Composer**:
The editor and session controls used to send the next prompt to the active session.
_Avoid_: Prompt box, input

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
The temporary active region for moving the sidebar selection and activating sessions. Pressing Escape returns to composer normal mode.
_Avoid_: Sidebar mode, tree focus

**Timeline navigation**:
The temporary active region that presents the rendered timeline as a read-only Vim buffer with a text cursor. Escape from timeline normal mode returns to composer normal mode.
_Avoid_: Cursor mode, timeline mode, timeline selection

**Activity indicator**:
A semantic visual cue for live work, waiting permission, failure, stale data, or unread activity. Text or symbols must carry the meaning when color is unavailable.
_Avoid_: Status color

**Workspace activity**:
The roll-up state of a workspace's sessions. `attention` means intervention is required, `working` means at least one session is active, `idle` means available sessions are waiting, and `done` means every session has ended or been archived.
_Avoid_: Workspace status

**Key cue**:
A short, dimmed key label placed beside the value or action it controls, such as the model, thinking level, or mode.
_Avoid_: Shortcut hint, footer help
