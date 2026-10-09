# Complete keyboard reference


Implemented reference for #72. See [acceptance evidence](acceptance-72.md) for automated coverage and remaining physical-host verification.

The following tables are part of this spec. They enumerate direct bindings, aliases, contextual exceptions, palette-only actions and removals. They are the agreed map; inherited library defaults do not add commands.

**Notation:** CN = Composer Normal; CV = Composer Visual character/line; TN = Timeline Normal; TV = Timeline Visual character/line. A count is a positive integer. Motion/operator families cover their approved count forms without listing every number. Text objects are single-object operations; counted/repeated expansion remains excluded.

## 1. Global controls and precedence

| Keys | Scope | Action / exception |
| --- | --- | --- |
| Ctrl-S | Every Deck context; terminal input | Focus Sidebar. From an overlay, dismiss its pending input first. Already focused is a no-op. |
| Ctrl-K | Deck buffers and overlays | Focus Timeline when available. In searchable pickers, select the previous result instead. Terminal input passes it through. |
| Ctrl-P | Deck buffers and overlays | Open palette; replace another overlay without applying its input. Already-open palette keeps query/selection. Terminal input passes it through. |
| Ctrl-U / Ctrl-D | Every Deck context | Scroll Timeline up/down half a visible page. Terminal input passes these through. No editor deletion fallback at boundaries or without a Timeline. |
| Ctrl-C | Every Deck context | Quit; confirm if unsent drafts are dirty. From an overlay, cancellation of quit restores that overlay. Repeated Ctrl-C cannot confirm quitting. Terminal input passes it through. |
| g? | CN, CV, TN, TV, Sidebar | Open Help. In text entry these characters are text; in terminal input they pass through. |

Actual focus changes and opening overlays cancel pending counts/operators/prefixes and cancel unconfirmed buffer searches using their Esc restoration rules. Preserve established buffer state within its own draft/Session. Unavailable focus targets and already-focused targets do not reset state.

Ctrl-U/Ctrl-D in TN move the cursor with the scroll. In TV, they preserve both selection endpoints and may leave the active end offscreen. Background scrolling preserves Timeline cursor/selection and the focused field's state. Refocusing does not undo the scroll; the next cursor motion reveals its destination from the saved position.

## 2. Text motions shared by composer and timeline buffers

Applies to CN, CV, TN and TV. Composer uses logical lines, including the retained g aliases; Timeline uses displayed rows. Visual motions move the active endpoint. Normal motions operate the cursor. Approved motions also work after d/c/y in CN and y in TN.

| Keys | Action / scope detail |
| --- | --- |
| h, Left, Backspace | One character left. |
| l, Right, Space | One character right. |
| j / k, Down / Up | One line/row down/up. Only standalone uncounted CN j/k recalls newer/older prompts at the last/first line. Visual/operator/counted motion stays within the current buffer. |
| gj / gk | Corresponding down/up aliases; logical lines in composer, displayed rows in Timeline. |
| w / W | Next word / whitespace-delimited WORD start. |
| b / B | Previous word / WORD start. Standalone b retains this meaning. |
| e / E | Word / WORD end. |
| ge / gE | Previous word / WORD end. |
| 0, g0 | Line/row start. A zero following an existing count is part of that count. |
| ^, _, g^ | First nonblank character. Underscore is exactly caret, including after an operator; no whole-line underscore behavior. |
| $, g$ | Line/row end. |
| g_ | Last nonblank, inclusive; with count, target the line/row count minus one below. |
| f{char} / F{char} | Find the next/previous occurrence in the line/row. |
| t{char} / T{char} | Move until the next/previous occurrence, stopping before it. |
| ; / , | Repeat character-find in the same/opposite direction. |
| gg / G | First/last line or row. Bare TN G also resumes following. TV G extends to latest output without resuming following. |
| {n}gg / {n}G | Numbered line/row, counting from one; numbered TN G does not resume following. |
| ( / ) | Previous/next sentence. |
| { / } | Previous/next paragraph. |
| [[ / ]] | Previous/next section start. |
| [] / ][ | Previous/next section end. |
| % | Matching delimiter. Percentage forms are removed. |
| / / ? | Start forward/backward search in the current buffer. Query owns text input until Enter or Esc. |
| n / N | Repeat confirmed search in the same/opposite direction. While entering a query, these are text. |
| * / # | Forward/backward whole-word search for the word under the cursor. |
| {count}{motion} | Repeat an approved motion or use its numbered-target meaning. Unsupported count combinations cancel without performing an uncounted fallback. |

CN prompt recall saves/restores the unfinished draft and cursor, stops at oldest/newest boundaries without wrapping and never modifies sent history. Operator/motion counts multiply, such as 2d3w = d6w; a completed edit is one undo step. Even explicit 1j/1k cannot recall history.

## 3. Shared text objects

In CN use d/c/y followed by the object; in TN use y. In CV/TV type the object directly. Inner forms exclude delimiters; around forms include them or the relevant surrounding whitespace. No entry object remains.

| Inner / around keys | Object |
| --- | --- |
| iw / aw | Word / word with adjacent whitespace. |
| iW / aW | Whitespace-delimited WORD / WORD with adjacent whitespace. |
| is / as | Sentence / sentence with adjacent whitespace. |
| ip / ap | Paragraph / paragraph with adjacent blank lines. |
| iq / aq | Nearest complete quote pair across supported quote types, including when outside all pairs. |
| ib / ab | Nearest complete bracket pair among parentheses, square brackets, braces and angle brackets, including when outside all pairs. |
| i" / a" | Double quotes. |
| i' / a' | Single quotes. |
| i or a followed by a backtick | Backticks. |
| i( / a(, i) / a) | Parentheses. |
| i[ / a[, i] / a] | Square brackets. |
| i{ / a{, i} / a}, iB / aB | Braces. Uppercase B retains the braces alias. |
| i< / a<, i> / a> | Angle brackets. |

Missing character-find, delimiter or object targets cancel the operation without changing text/cursor/selection/clipboard/mode. A valid empty pair can still be a change target.

## 4. Composer Normal: editing and mode controls

Also inherits globals, shared motions/objects and the Normal application table below.

| Keys | Action |
| --- | --- |
| i / a | Enter Insert before/after the cursor. |
| I / A | Enter Insert at first nonblank / line end. |
| o / O | Open a line below/above and enter Insert. |
| v / V | Enter character / whole-logical-line Visual. |
| gv | Restore this draft's previous selection, if its endpoints still resolve. |
| x / X | Delete character under/before cursor into the shared clipboard. |
| s / S | Change character/line and enter Insert. |
| D / C | Delete/change through line end; C enters Insert. |
| d{motion} / c{motion} / y{motion} | Delete/change/copy the motion range. |
| di{object} / da{object} | Delete inside/around an approved object. |
| ci{object} / ca{object} | Change inside/around an approved object; enter Insert on success. |
| yi{object} / ya{object} | Copy inside/around an approved object. |
| dd / cc / yy / Y | Delete/change/copy complete logical lines. cc enters Insert; counts select multiple lines. |
| d_ / c_ / y_ | Same motion range as d^ / c^ / y^. |
| r{char} | Replace under-cursor character(s) with the supplied character. |
| J | Join lines with ordinary space/indentation handling. |
| ~ | Toggle character case. |
| p / P | Read current system clipboard; insert characterwise after/before cursor, or Deck-owned linewise text below/above current line. |
| u / Ctrl-R | Undo/redo in the shared per-draft history. |
| {count}{edit or yank} | Repeat an approved editing/yank command, subject to its ordinary meaning; no counted objects. |
| Enter, idle | Send a nonempty prompt. New Session/Workspace creation follows the creation table below. |
| Enter, unfinished command/count | Cancel without editing or sending. Search-query Enter has its separate confirmation meaning. |
| Esc | Cancel pending command/query first; otherwise remain in Normal. |

External clipboard text is characterwise even when it contains newlines. Buffer deletes/changes/yanks share the system clipboard; there is no separate paste register. Pasted input is always data and never a stream of Vim/application commands or submission events.

## 5. Ordinary text editing: Composer Insert and single-line fields

Single-line fields include buffer search queries, picker filters, Sidebar filter and Rename. Globals and the picker Ctrl-K exception take precedence over editing. These rows do not apply to terminal programs.

| Keys / input | Action |
| --- | --- |
| Printable text | Insert text. Letters and punctuation do not trigger Vim/application commands here. |
| Left / Right, Ctrl-B / Ctrl-F | Move one character left/right. |
| Alt-Left / Alt-Right, Ctrl-Left / Ctrl-Right, Alt-B / Alt-F | Move one word left/right. |
| Home / End, Ctrl-Home / Ctrl-End, Ctrl-A / Ctrl-E | Move to line start/end; single-line fields use field start/end. No outer fullscreen interception. |
| Backspace / Shift-Backspace | Delete the character before the caret. |
| Delete / Shift-Delete | Delete the character at the caret. |
| Ctrl-W / Alt-Backspace | Delete the previous word. |
| Alt-D / Alt-Delete | Delete the next word. |
| Ctrl-Z / Ctrl-Shift-Z | Undo/redo. Insert shares the draft history with Normal u/Ctrl-R; single-line fields have local history for the current interaction. |
| Native clipboard paste | Insert literal text. In single-line fields, convert each line break to a space, treating CRLF as one; one undo step. In composer, preserve newlines. Never submit or execute pasted content. |

Ctrl-Shift-Z redo requires distinguishable terminal delivery. In Insert, Esc then Ctrl-R is the existing fallback; single-line fields gain no fallback chord. Removing private Ctrl-Y/Alt-Y paste history also applies to these fields.

## 6. Composer Insert: local controls

| Keys | Action |
| --- | --- |
| Enter / Alt-Enter | Insert newline and stay in Insert, across legacy and enhanced encodings. Never send. |
| Shift-Enter / Ctrl-J | Retained ordinary editor newline aliases, subject to received encoding; never send while Insert is active. |
| Up / Down | Move through displayed rows, including wraps. At first/last displayed row, first reach line start/end, then another press recalls older/newer prompt. |
| Esc | Return to Normal, completing the current Insert undo group. |
| Tab / Shift-Tab | No indentation or focus traversal; Tab has no visible effect while completion is unwired. |

History recall preserves the unfinished draft/cursor, stops without wrapping, and is undoable. Editing a recalled prompt ends history browsing without changing sent history. Ctrl-N/Ctrl-P history aliases are removed; Ctrl-P opens the palette. Ctrl-A/Ctrl-X do not archive/stop here, and Ctrl-T does not open New tab.

## 7. Visual selection controls shared by composer and timeline

Also inherit globals, shared motions and text objects. Composer selects logical lines; Timeline selects displayed rows. No Visual Block.

| Keys | Action |
| --- | --- |
| v / V | Enter/switch character or line selection. Repeating the currently active type exits to Normal. Switching keeps the anchor. |
| o / O | Swap active endpoint and anchor. |
| gv | Exchange current and previous selection in the same buffer. From Normal, restore the previous selection. |
| y | Copy selected text to system clipboard; return to corresponding Normal mode. |
| Y | Copy all lines/rows touched by the selection; return to Normal. |
| Enter, idle | No action; do not send. |
| Enter, unfinished replacement/command | Cancel pending command, preserve selection/mode, never send. |
| Enter during search | Confirm search and return to the selection. |
| Esc | Cancel query/unfinished command first; otherwise exit selection to corresponding Normal at the active endpoint. |

Selection motion never recalls composer history. No direct tab/session/settings actions, gx or za in selection modes. Saved selections are scoped to their own draft/Session and remapped or invalidated after content changes.

## 8. Composer Visual: editing

Timeline Visual does not inherit any row in this table.

| Keys / input | Action | Result |
| --- | --- | --- |
| d / x | Delete selection into shared clipboard. | Normal |
| c / s | Change selection, writing removed text to clipboard. | Insert |
| D / X | Delete complete logical lines touched by selection. | Normal |
| C / S / R | Change complete logical lines touched by selection. | Insert |
| p | Replace selection from clipboard, then write removed text to clipboard. | Normal |
| P | Replace selection from clipboard, preserving clipboard contents. | Normal |
| Native clipboard paste | Replace selection as one undoable edit; preserve clipboard; cursor after inserted text. | Insert |
| u / U / ~ | Lowercase / uppercase / toggle case of selected letters. | Normal |
| r{char} | Replace selected characters with supplied character. | Normal |
| J | Join touched lines, remove following indentation and add spaces as needed. | Normal |
| gJ | Join touched lines by removing line breaks, preserving existing spaces. | Normal |
| > / < | Shift touched nonblank lines right/left by two spaces. | Normal |
| {count}> / {count}< | Repeat the two-space shift; one undo step for the complete command. | Normal |

Joins include the next line when selection touches only one line and a next line exists. Left indentation stops at zero; blank/whitespace-only lines remain unchanged. Convert affected leading tabs to equivalent displayed-width spaces, leaving body tabs alone.

## 9. Normal application commands

These are CN/TN bindings only unless the Scope column explicitly includes another context. Visual and Insert do not inherit them.

| Keys | Scope | Action |
| --- | --- | --- |
| gt / gT | CN, TN | Next/previous Tab in Active workspace; wrap. |
| {n}gt | CN, TN | Activate numbered Tab from one in visible order; invalid index is a no-op. |
| {n}gT | CN, TN | Move backward n Tabs with wrapping. Resolve target before switching. |
| Ctrl-T | CN, TN | New tab picker in Active workspace. |
| Ctrl-T | Sidebar | New tab picker in highlighted eligible Workspace. |
| Ctrl-T | New workspace composer Normal | Choose first-tab type/profile; do not create it yet. |
| Ctrl-X | CN, TN | Stop Active session after confirmation, when eligible. |
| Ctrl-A | CN, TN | Archive Active session after confirmation, when eligible. |
| mp | CN, TN; Session draft only | Provider picker. Existing Sessions cannot change provider. |
| mm | CN, TN | Model picker for Session draft or supported Active session. |
| mt | CN, TN | Thinking-level picker when supported. |
| mo | CN, TN | Operational-mode picker when supported. |

Changing provider on a draft resets model, thinking and operational mode to the provider/model defaults. Changing model resets thinking to that model's default, preserving operational mode. Changing thinking or operational mode changes only that setting. Reconfirming the current value closes without resets. Settings never send a prompt or clear draft editing state.

## 10. Timeline local controls and read-only rules

Inherits the relevant globals, shared motion/object/selection tables and Normal application commands. Timeline has no Insert mode.

| Keys / input | Scope | Action |
| --- | --- | --- |
| Ctrl-B / Ctrl-F, PageUp / PageDown | TN, TV | Page up/down with a small overlap; use the Timeline viewport size. Visual retains its inherited selection-motion behavior; Ctrl-U/Ctrl-D have the separate selection-preserving rule. |
| H / M / L | TN, TV | First nonblank on top/middle/bottom visible row; move the active endpoint in Visual. |
| G | TN | Go to latest output and resume following. Numbered G and Visual G do not resume following. |
| yy / Y, {count}yy / {count}Y | TN | Copy current displayed row or counted rows directly to clipboard. |
| y{motion}, yi{object}, ya{object} | TN | Copy approved motion/object range. No copy picker. |
| gx | TN | Open link under cursor; no link means no action. |
| za | TN | Expand/collapse current entry. |
| [t / ]t | TN | Previous/next turn. |
| [e / ]e | TN | Previous/next timeline error; never retry it. |
| Esc | TN | Cancel query/unfinished command first; otherwise return to composer with its saved mode/cursor. |
| Enter | TN, TV | Confirm query when entering one; otherwise no action. Never send composer. |
| Native paste | TN, TV | Consume as a single payload; no editing, command execution or forwarding to composer. |
| Editing commands | TN, TV | No insert/delete/change/replace/paste/case/join/indent/undo actions. i/a remain object prefixes only in Visual/operator context; o/O remain Visual endpoint controls only. |

Cursor is a block with a distinct current-row background. Preserve centered layout, content indentation and stable anchors through streaming, history loading, folds and resize. Characterwise copies rejoin soft wraps and retain real line breaks; rowwise copies keep selected displayed rows as separate lines and record linewise clipboard type. Neither includes terminal styling or decorative padding.

## 11. Sidebar

Rows are Projects and Workspaces. Moving the highlight does not activate another Workspace. Globals and g? apply.

| Keys | Action |
| --- | --- |
| j / k, Down / Up | Highlight next/previous visible row. |
| h / l, Left / Right | Collapse/expand selected branch. |
| gg / G | First/last visible row. Bare g is only a prefix. |
| Enter | Activate highlighted Workspace. Project rows use collapse/expand controls. |
| Esc | Return to composer or active terminal. |
| n | Open/resume New workspace composer. |
| c | Open/reuse Session draft in the target existing Workspace. |
| Ctrl-T | New tab picker for highlighted eligible Workspace. |
| Ctrl-A | Archive highlighted Workspace after confirmation. Unavailable on Project rows; no fallback to Active workspace. |
| / | Open Project/Workspace name filter. |
| v | Show/hide archived Workspaces. |
| ! | Toggle needs-attention filter using combined Workspace activity. |
| p | Open permission requests. |
| [ / ] | Narrow/widen Sidebar. |
| o | Toggle alphabetical/needs-attention ordering. |

The three filters combine without changing the Active workspace/Tab; retain parent Projects for matching Workspaces. Keep ordering stable while Sidebar is focused. Sidebar has no tab navigation, Session Stop/Archive/Rename/Detach or Session setting shortcuts. Ctrl-X is unassigned here.

## 12. Terminal direct input

| Keys | Deck action |
| --- | --- |
| Ctrl-S | Focus Sidebar. |
| Ctrl-Tab | Next Tab in current Workspace. |
| Ctrl-Shift-Tab | Previous Tab in current Workspace. |
| All other input, including paste | Pass to running program. |

There is no Deck Terminal Normal/Insert toggle. Esc, Ctrl-C/U/D/K/P/T/A/X, ordinary Tab/Shift-Tab and literal g?, gt/gT, q/n/i belong to the program. Modified tab chords must arrive distinctly; ordinary Tab/Shift-Tab cannot be intercepted as substitutes. A terminal destination immediately accepts input.

Routes through Sidebar are sequences of separate focused actions: Ctrl-S then Ctrl-P for palette; Ctrl-S then Ctrl-T for New tab; Ctrl-S then n for New workspace; Ctrl-S then Ctrl-C for Deck quit. Once a Deck overlay owns input, its normal Deck controls apply.

## 13. Searchable pickers

Applies to command palette, New tab/first-tab picker, provider/model/thinking/mode pickers and Project/Local-Worktree/Base-ref pickers. Also inherits the ordinary single-line editing table and Deck globals.

| Keys / input | Action |
| --- | --- |
| Printable text, including j/k | Edit filter. |
| Down / Ctrl-J | Next result; stop at last. |
| Up / Ctrl-K | Previous result; stop at first. Local Ctrl-K overrides Timeline focus. |
| Enter | Run/apply selected available result. No result or disabled result does nothing. |
| Esc | Cancel without applying; restore originating focus/mode/selection. |

Legacy LF is navigation, not confirmation; CR or distinct enhanced Enter confirms. Disabled results remain visible with a reason. Clearing query unfilters without clearing the chosen setting. Reconfirming an existing setting closes without resetting dependents; executable palette/New tab results still execute their action.

## 14. Search, filter and rename input

All inherit ordinary single-line editing and Deck globals. Buffer query text is displayed at the bottom of the screen in the main pane, outside composer and right of Sidebar.

| Context | Keys | Action |
| --- | --- | --- |
| Composer/Timeline search query | Enter | Confirm and return to originating Normal/Visual, retaining highlights for n/N. |
| Composer/Timeline search query | Esc | Cancel and restore pre-search cursor/selection; also restore Timeline viewport. |
| Sidebar filter | Enter | Apply query and close; empty query removes only the name filter. |
| Sidebar filter | Esc | Cancel edits, retain prior applied filter and restore origin. |
| Rename Session/Workspace/Terminal | Enter | Trim surrounding whitespace and save nonempty valid name; unchanged name closes. Failure/invalid name keeps input for correction. |
| Rename Session/Workspace/Terminal | Esc | Cancel and restore origin. |

These fields have no local picker-navigation exception unless they actually own a selectable result list. Ctrl-K focuses Timeline. Their local undo cannot reverse the underlying prompt, an applied setting or a saved rename. Plain n/N and g? are text during entry.

## 15. Help and Error details

Deck globals apply; these are read-only scrolling views, not searchable pickers.

| Keys | Action |
| --- | --- |
| j / k, Down / Up | Scroll down/up one displayed row. |
| PageDown / PageUp | Scroll down/up a page. |
| gg / G | Beginning/end. |
| Esc | Close and restore origin. Error details opened from Notifications returns to the same notice in that list. |

No extra search, copy/selection, retry or bare-question-mark close binding. Ctrl-U/Ctrl-D scroll the background Timeline; Ctrl-K focuses it.

## 16. Notifications

Open through the palette; Deck globals apply.

| Keys | Action |
| --- | --- |
| j / k, Down / Up | Select next/previous notification. |
| Enter | Open selected notice's full message and any diagnostic details. |
| r | Retry that notice's failed action when available. |
| Esc | Close and restore origin. |

Keep selection tied to notification identity as new notices arrive. No picker Ctrl-J/Ctrl-K aliases here.

## 17. Permission requests

Open with Sidebar p or the palette; Deck globals apply.

| Keys | Action |
| --- | --- |
| a | Allow displayed request. |
| d | Deny displayed request. |
| h / l, Left / Right | Previous/next pending request. |
| r | Retry sending the same failed allow/deny decision. |
| Esc | Close without answering; restore origin. |
| Enter | No permission-decision action. |

## 18. Confirmations

Applies to quit, discard, Stop/Archive, Detach and terminate terminal where confirmation is required. Deck globals apply.

| Keys | Action |
| --- | --- |
| Enter | Confirm the named action against the displayed captured target, once. |
| Esc | Cancel and restore previous view/dialog and its input/selection. |
| Ctrl-C while quit confirmation is already open | Keep confirmation open; do not confirm or bypass it. |

No y/n shortcuts or searchable Yes/No list. If target becomes unavailable, retain dialog/input with reason and disable confirmation. Dismissing a busy dialog does not cancel an already-sent backend request or allow its completion to act on a new target.

## 19. New Session and New Workspace

Existing-Workspace Session creation opens its draft composer directly. Choosing Terminal/profile from an existing-Workspace New tab picker creates and focuses it immediately; no naming wizard.

| Keys / entry | Scope | Action |
| --- | --- | --- |
| Sidebar c; New tab picker → Session | Existing Workspace | Open/reuse draft composer with current defaults and existing prompt. |
| Sidebar n; palette → New workspace | Eligible Deck contexts | Open/resume one New workspace draft; fresh draft starts in Normal. |
| md | New workspace composer Normal | Choose Project/directory. |
| mw | New workspace composer Normal | Choose Local or Worktree. Default is Worktree. |
| mb | New workspace composer Normal, Worktree selected | Choose Base ref. Default resolves origin's actual remote default, displayed in full. |
| Ctrl-T | New workspace composer Normal | Choose Session/Terminal/profile as first Tab; return without creating. |
| mp / mm / mt / mo | New Session draft Normal; New workspace Normal with Session selected | Provider/model/thinking/operational mode settings. |
| Enter, idle Normal | Existing-Workspace Session draft | With nonempty prompt and valid settings, create Session and send. |
| Enter, idle Normal | New workspace, Session selected | Create Workspace and Session, then send valid nonempty prompt. |
| Enter, idle Normal | New workspace, Terminal/profile selected | Create Workspace and terminal; prompt not required or sent. |
| Enter / Alt-Enter in Insert | Composer text entry | Newline, never creation/submission. |
| Esc | New workspace composer | Ordinary pending-command cancellation / Visual or Insert exit; never discard the draft. |
| Palette → Discard draft | Active draft | Untouched: discard immediately. Dirty prompt/settings: confirm. Restore previous view. |

Display Workspace controls in their own row above composer; Session settings in composer's last row. Switching first-tab type preserves Session prompt/settings for a switch back. Local hides mb and uses original checkout; Worktree restores a valid same-Project prior Base ref or origin default. Project changes reset Base ref for that Project. Unresolved required fields block creation, with no silent local-branch fallback.

## 20. Palette-only actions and targets

Access is Ctrl-P in Deck, or Ctrl-S then Ctrl-P from terminal input. The command palette can also expose the reviewed actions that have direct shortcuts, subject to the same eligibility and target rules.

| Action | Target / availability |
| --- | --- |
| Discard draft | Active Session or New workspace draft only. Untouched immediate; dirty requires confirmation. No shortcut alias. |
| Rename Session | Eligible Active session, palette opened from composer/timeline. |
| Detach Session | Eligible Active session, palette opened from composer/timeline; confirmation identifies it. |
| Rename Workspace | Highlighted Workspace, Sidebar palette. Unavailable on Project rows. |
| Rename active terminal | Explicitly named Terminal in Active tab, Sidebar palette reached via Ctrl-S. Show Terminal and Workspace identity. |
| Reconnect / terminate active terminal | Applicable active-terminal utility in palette, reached through Sidebar; terminate uses agreed confirmation. |
| Refresh directory / reconnect | Refresh application directory; reconnect when disconnected. |
| Notifications | Open notification history. |
| Retry failed action | Selected failure/notification with an available retry; never infer target from Sidebar highlight. |
| Error details | Selected applicable notice; open read-only full details. |
| Sidebar name filter / archived visibility / needs-attention / permissions | Palette access from composer/timeline; Sidebar retains its direct controls. |
| New workspace | Open/resume New workspace draft, even without an Active workspace. |

Sidebar does not gain Session settings, Rename Session or Detach through the palette. Active-terminal utilities are explicitly labelled exceptions to highlighted-Workspace targeting. Rename changes display names only; no directory/branch rename or terminal restart.

## 21. Conflicts, relocations and removals

“Removed” means no Deck action in the stated context; printable characters still enter text fields, and terminal programs retain all keys except their three reserved chords. Backslash sequences below describe the old application leader, which is removed throughout Deck.

| Old key / conflicting family | Agreed resolution |
| --- | --- |
| Backslash+n / backslash+t | Ctrl-S Sidebar / Ctrl-K Timeline, with picker and terminal exceptions. |
| Backslash+i | Remove. Composer uses i; Timeline Esc returns to saved composer; no Timeline Insert. |
| Backslash+s | Remove. Idle CN Enter sends. |
| Backslash+h / backslash+H | Remove. Use reviewed prompt-history j/k or Insert Up/Down boundaries. |
| Backslash+T; old bare T for New tab | Ctrl-T in approved navigation contexts. Buffer T{char} remains character-find. |
| Backslash+[ / backslash+] | gT / gt in CN/TN; modified tab chords in terminal input. No Sidebar tab navigation. |
| Backslash+D; gc | Discard draft is palette-only everywhere. |
| Backslash+?; bare ? Help/open-close | g? opens Help in navigation/selection; Esc closes it. Buffer ? remains reverse search. |
| Backslash+q; standalone q quit/focus | Remove. Ctrl-C is sole Deck quit key; terminal q is input. |
| Backslash+x / backslash+A | Ctrl-X Stop / Ctrl-A Archive Active session in CN/TN. |
| Backslash+d / backslash+e | Detach/Rename Session palette-only from composer/timeline. |
| Backslash+p / backslash+m / backslash+z / backslash+o | mp / mm / mt / mo in approved Normal contexts. |
| Backslash+f / backslash+P / backslash+v / backslash+! | Sidebar controls through palette from composer/timeline; direct Sidebar /, p, v, ! remain. |
| Backslash+r / backslash+N / backslash+R / backslash+E | Refresh/Notifications/Retry/Error details through palette. Notifications uses local r and Enter. |
| Published backslash+K in composer | Remove invalid listing; terminate terminal is a palette utility with an eligible terminal target. |
| Ctrl-K palette | Relocate palette to Ctrl-P. Ctrl-K is Timeline focus or picker previous-result. |
| Cmd-P-labelled ESC+p / Alt-P alias | Remove alias and inaccurate label. Ctrl-P is sole Deck palette shortcut. |
| Ctrl-N/Ctrl-P composer line/history; Ctrl-P timeline search results | Remove old meanings. j/k or arrows move; Insert arrows recall; confirmed buffer searches use n/N. Ctrl-P is palette. |
| Ctrl-U line-start deletion / composer half-page motion | Remove editing/motion meaning; global Timeline scroll. |
| Ctrl-D character deletion / composer half-page motion | Remove editing/motion meaning; global Timeline scroll. |
| Ctrl-K line-end deletion | Remove, without another Insert deletion shortcut. Normal D remains. |
| Ctrl-A/Ctrl-X Vim number increment/decrement | Excluded. CN/TN use Archive/Stop; Sidebar Ctrl-A archives highlighted Workspace and Ctrl-X is unassigned. Text fields retain Ctrl-A start-of-line/field. |
| Ctrl-B/Ctrl-F composer Normal/Visual page motions | Remove there. Insert/text fields retain character movement; Timeline retains page scroll. |
| Ctrl-F timeline search | Remove search alias; use / or ?. Ctrl-F scrolls a Timeline page. |
| H / M / L in composer | Remove viewport motions; do not assign focus actions. Timeline keeps viewport motions. |
| Numbered column motion (vertical bar); gm / gM | Remove from buffers. Ordinary line-boundary motions remain. |
| + / -; Enter next-line motion | Remove. Enter follows mode-specific send/newline/confirm/no-op meanings. |
| Count + % | Remove percentage motion; bare % matches delimiters. |
| Standard between-line / linewise underscore | Replace with exact ^ alias, including d_/c_/y_. |
| g* / g# | Remove partial-word searches. * / # remain whole-word. |
| Mark setting/jumping: m{char}, quote/backtick + mark | Remove. m is settings prefix in approved Normal contexts. |
| Ctrl-O, Ctrl-I / Tab jump history | Remove. No marks or jump-list system. |
| Ctrl-V and Visual Block family | Remove block entry/state/actions. v/V remain; native clipboard paste is handled as a payload, not a new Ctrl-V Deck shortcut. |
| iv / av / yiv / yav entry object | Remove, including whole-entry copy/unfold behavior; no replacement entry shortcut. |
| ib / ab parentheses-only alias | General nearest bracket pair; explicit parenthesis objects remain. Plain b stays backward-word. |
| zt / zz / zb; Ctrl-E/Ctrl-Y Timeline fine scroll | Excluded. Use agreed row/page/viewport controls. Ctrl-E remains ordinary text-field line-end movement. |
| Ctrl-- editor undo | Replace with Ctrl-Z / Ctrl-Shift-Z in Insert/text fields. Normal keeps u/Ctrl-R. |
| Ctrl-Y / Alt-Y private paste history | Remove from Deck text fields. System clipboard supplies paste. Terminal input passes these through. |
| Ctrl-] / Ctrl-Alt-] inherited character jumps | Remove. |
| Ctrl-Up/Down, Ctrl-Shift-Up/Down inherited prompt jumps | Remove from Deck. |
| Ctrl-PageUp/Down composer pages | Remove. |
| PageUp/PageDown composer background interception | Remove; Ctrl-U/Ctrl-D scroll Timeline globally. Page keys remain in Timeline, Help and Error details. |
| Ctrl-Shift-F fullscreen search, its Ctrl-G/Ctrl-Shift-G navigation | Remove separate overlay and controls; use reviewed buffer / and ? searches. |
| Sidebar bare g | gg first row, preserving g? Help prefix. |
| Sidebar x / A / e / d Session actions | Remove; Sidebar targets Projects/Workspaces, never an inferred Session. |
| Sidebar m / t / z and proposed mp/mm/mt/mo | Remove Session settings, including Sidebar-specific palette variants. |
| Sidebar r / N / R / E | Palette-only utilities. |
| Sidebar gt/gT and numbered forms | Remove; tab navigation belongs to active main-section Normal modes. |
| Visual tab/session/settings commands | Excluded; use Normal. Shared globals and g? remain. |
| Terminal i, q/n, g?, gk, r, gt/gT and old scrolling handlers | Remove Deck interception; pass through under the single direct-input mode. |
| Permission Enter; confirmation y/n; optional list/search extras | No added actions. Keep only the reviewed local controls. |
