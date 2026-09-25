# Paseo Deck

Paseo Deck is a terminal client for working with Paseo workspaces and their sessions and terminals.

## Organization

**Project**:
A named group of related workspaces.

**Workspace**:
A working directory registered with Paseo. A workspace contains sessions and terminals.

**Local workspace**:
A workspace that uses the project's original checkout directory on disk.

**Worktree workspace**:
A workspace that uses a Paseo-managed Git worktree created for that workspace.

**Base ref**:
The remote or local Git ref from which Paseo creates a Worktree workspace.

**Session**:
The user-facing conversation and activity history for one AI coding agent in a workspace. Use this term for tabs, timelines, and user commands. Sessions do not appear as sidebar rows.
_Avoid_: Agent, chat, conversation

**Session draft**:
The local, unsent configuration and first message used to create a Session. A Session draft belongs to a Workspace but is not yet a daemon resource.
_Avoid_: Draft agent

**Agent**:
The provider-backed worker that performs a session's task. Use this term when the distinction from the user-facing session matters.
_Avoid_: Session process

**Terminal**:
A persistent shell owned by a workspace. A terminal is a workspace resource in the active Workspace's Tab row, not a sidebar row or session timeline item.
_Avoid_: Console, shell tab

**Terminal profile**:
A named terminal configuration supplied by the connected Paseo daemon.
_Avoid_: Deck terminal profile

## Interface

**Active workspace**:
The Workspace whose tabs and content occupy the main pane. Moving the Sidebar selection does not change the Active workspace.
_Avoid_: Selected workspace, focused workspace

**Tab**:
The interface representation of a Session draft, Session, or Terminal in the Active workspace.
_Avoid_: Sidebar entry

**Tab row**:
The ordered collection of Tabs belonging to the Active workspace.
_Avoid_: Global tabs, session tabs

**Active tab**:
The Tab whose Session draft, Session, or Terminal occupies the main pane.
_Avoid_: Selected tab, focused tab

**Active session**:
The Session represented by the Active tab. Its timeline and composer occupy the main pane.
_Avoid_: Focused session, selected agent

**Active terminal**:
The Terminal represented by the Active tab. Its terminal surface occupies the main pane.
_Avoid_: Focused terminal, selected terminal

**Sidebar selection**:
The Project or Workspace row that Sidebar navigation will act on. It is highlighted only while the sidebar is active, and a Workspace becomes active only when the user opens it.
_Avoid_: Active workspace, focus

**Timeline**:
The ordered, live record of messages, reasoning, tool activity, permissions, turn state, and errors in the active session.
_Avoid_: Transcript, log, output

**Main pane**:
The region beside the sidebar that contains the Active workspace's Tab row and the Active tab's content.
_Avoid_: Timeline window, right-side region

**Composer**:
The editor and session controls used to send the next prompt to the active session.
_Avoid_: Prompt box, input

**New workspace composer**:
The editor and controls used to define a new Workspace and the Session or Terminal that will initially occupy it.
_Avoid_: Workspace picker, creation modal

**Launch composer**:
The editor and controls used to create the first Session or Terminal in an existing empty Workspace.
_Avoid_: New workspace composer, empty state

**Choice picker**:
A centered, bordered list for choosing a provider, model, thinking level, or operational mode. A choice picker may support filtering, disabled choices, and a preselected value.
_Avoid_: Ticker, selection dialog

**Active region**:
The composer, sidebar, timeline, or terminal currently receiving keyboard commands. Its heading or selection styling indicates where keyboard commands go.
_Avoid_: Pane focus, focus area

**Normal mode**:
The default Vim mode for the composer, timeline, or terminal. Composer normal mode is the application's resting state, timeline normal mode navigates its read-only buffer, and terminal normal mode handles Deck commands.

**Insert mode**:
The Vim mode for entering prompt text in the composer or sending literal input to a terminal. Pressing Escape returns that region to normal mode.

**Visual mode**:
The Vim mode for selecting text in the composer or read-only timeline. Pressing Escape clears the selection and returns that region to normal mode.

**Sidebar navigation**:
The temporary active region for moving the Sidebar selection and activating Workspaces. Pressing Escape returns to composer normal mode.
_Avoid_: Sidebar mode, tree focus

**Timeline navigation**:
The temporary active region that presents the rendered timeline as a read-only Vim buffer with a text cursor. Escape from timeline normal mode returns to composer normal mode.
_Avoid_: Cursor mode, timeline mode, timeline selection

**Activity indicator**:
A semantic visual cue for attention, working, idle, or done activity. Text or symbols must carry the meaning when color is unavailable.
_Avoid_: Status color

**Workspace activity**:
The roll-up state of a Workspace's Sessions and Terminals. `attention` means intervention is required, `working` means at least one resource is active, `idle` means the Workspace is available without active work, including when it is empty and launchable, and `done` means it had resources and all of them have ended or been archived.
_Avoid_: Workspace status

**Key cue**:
A short, dimmed key label placed beside a Paseo-specific value or action such as the model, thinking level, or operational mode. Ordinary Vim movement and confirmation keys do not need key cues.
_Avoid_: Shortcut hint, footer help
