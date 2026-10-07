# Complete keyboard reference

Keys depend on the active region. In composer and timeline Normal or Visual mode, `\` is the Deck application leader: press it, then the next key. A number before a Vim motion repeats it. The timeline is a read-only buffer; text changes apply only in the composer.

## Global and application actions

| Context | Key | Action |
| --- | --- | --- |
| Everywhere | `Ctrl-C` | Quit Deck, including from an overlay or terminal Insert mode. |
| Everywhere | `Ctrl-K`, `Cmd-P` | Command palette. `Cmd-P` requires a terminal that sends the supported escape sequence. |
| Composer and timeline Normal/Visual | `\?` | Contextual help. |
| Composer and timeline Normal/Visual | `\q` | Quit Deck. |
| Composer and timeline Normal/Visual | `\T` | New tab. |
| Composer and timeline Normal/Visual | `\D` | Discard the workspace session draft, after confirmation. |
| Composer and timeline Normal/Visual | `\K` | Terminate the active terminal after confirmation, when one is selected. |
| Composer and timeline Normal/Visual | `\[`, `\]` | Previous or next tab. |
| Composer and timeline Normal/Visual | `\r` | Refresh directory and connection. |
| Composer and timeline Normal/Visual | `\R` | Retry the selected failure. |
| Composer and timeline Normal/Visual | `\E` | Error details. |
| Composer and timeline Normal/Visual | `\N` | Notification history. |
| Composer and timeline Normal/Visual | `\f` | Filter sessions. |
| Composer and timeline Normal/Visual | `\P` | Pending permissions. |
| Composer and timeline Normal/Visual | `\v` | Toggle archived sessions. |
| Composer and timeline Normal/Visual | `\!` | Toggle needs-attention filter. |
| Composer and timeline Normal/Visual | `\x`, `\A`, `\d` | Stop, archive, or detach the active session, with confirmation. |
| Composer and timeline Normal/Visual | `\e` | Rename the active session. |
| Composer and timeline Normal/Visual | `\z` | Thinking level. |
| Composer Normal/Visual | `\n`, `\t` | Focus sidebar or timeline. |
| Timeline Normal/Visual | `\n` | Focus sidebar. |
| Timeline Normal/Visual | `\i` | Focus composer Insert mode. |
| Composer Normal/Visual | `\s` | Send the current prompt. |
| Composer Normal/Visual | `\h`, `\H` | Previous or next prompt from history. |
| Composer Normal/Visual | `\o` | Operational mode. |
| Composer Normal/Visual | `\m` | Model control; live switching is currently unavailable. |
| Launch composer Normal/Visual | `\c` | Toggle Session or Terminal while creation has not started. |
| Launch Session composer Normal/Visual | `\p`, `\m`, `\z`, `\o` | Choose provider, model, thinking level, or operational mode. |
| Launch Terminal composer Normal/Visual | `\p` | Choose the default shell or a daemon terminal profile. |
| Launch composer Normal/Visual | `\s` | Launch the resource with the first message or single-line command; retry failed input on the resource already created. |
| Session draft composer Normal/Visual | `\p`, `\m`, `\z`, `\o` | Choose provider, model, thinking level, or operational mode for the draft. |
| Tree or terminal Normal | `T` | New tab, where available. |
| Tree or terminal Normal | `q`, `?`, `r`, `N`, `R`, `E`, `/`, `p`, `v`, `!`, `x`, `A`, `d`, `e`, `z` | Quit; help; refresh; notifications; retry; error details; filter; permissions; archived/attention filters; stop/archive/detach/rename session; thinking level, where available. Terminal `q` focuses the sidebar. |
| Tree or terminal Normal | `gt`, `gT`, count + `gt`/`gT` | Next/previous tab or indexed tab. |
| Timeline Normal/Visual | `gt`, `gT` | Next/previous tab. |
| Tree or terminal Normal | `gc` | Discard session draft. |
| Terminal Normal | `gk` | Terminate active terminal after confirmation. |
| Command palette only | Theme, terminal creation, and other listed actions | Run actions without a dedicated direct key. |

## Reviewed Composer Normal

Composer motions use logical lines, including `gj/gk`, `g0/g^/g$` and counted inclusive `g_`. `_` is exactly `^`, also after `d/c/y`. Bare `%` matches delimiters; numbered `%`, viewport motions, marks/jumps, column motions and `g*/g#` are excluded from Composer.

`h/l` (arrows, Backspace/Space), `j/k` (arrows), `w/W/b/B/e/E/ge/gE`, `0/^/$`, `gg/G`, sentence `(`/`)`, paragraph `{`/`}`, section `[[/]]/[]/][` and `f/F/t/T` with `;/,` repeats also work after `d/c/y`. Operator and motion counts multiply (`2d3w`), and each edit is one undo step. Unsupported count combinations cancel.

Use `i/a/I/A/o/O` to enter Insert; `x/X/s/S/D/C`, `d/c/y` plus a motion/object, `dd/cc/yy/Y`, `r`, `J`, `~`, `p/P`, `u/Ctrl-R` edit or copy. `J` joins two lines by default; a count names the number of lines. `r` cannot cross a logical newline.

Objects are `iw/aw`, `iW/aW`, `is/as`, `ip/ap`, explicit quote/bracket pairs, `iq/aq` (nearest complete quote pair) and `ib/ab` (nearest complete bracket pair), even outside every pair. Plain `b` remains backward-word; `iB/aB` remains braces. Objects do not accept counts. Missing targets preserve the draft, cursor, mode and clipboard; complete empty pairs can be changed.

Delete, change and yank write the shared system clipboard. Every `p/P` reads its current value; failures are reported without a private-register fallback. Only a successful Deck-owned linewise value retains linewise type, inserting complete lines below/above. External text is characterwise, including multiline text.

## Shared Vim buffer motions

These work in composer and timeline Normal/Visual modes unless the context column says otherwise. The timeline moves across rendered lines; the composer moves across editable text. Some `g` screen-line variants share the same rendered-line movement in the timeline.

| Context | Keys | Action |
| --- | --- | --- |
| Both | `h`, `l`, `Left`, `Right`; composer also `Backspace`, `Space` | Left/right by character. |
| Both | `j`, `k`, `Down`, `Up`; composer also `Ctrl-N`, `Ctrl-P` | Down/up by line, preserving the target column. |
| Both | `0`, `^`, `$`, `g0`, `g^`, `g$`, `g_`, `\|` | Line start, first nonblank, end, display-line variants, last nonblank, or counted column. |
| Both | `+`, `-`, `_`, `Enter` | Next/previous line at first nonblank, counted line, or next line via Enter. |
| Both | `w`, `W`, `b`, `B`, `e`, `E`, `ge`, `gE` | Word and whitespace-delimited WORD starts/ends. |
| Both | `f{char}`, `F{char}`, `t{char}`, `T{char}`, `;`, `,` | Find/till a character on this line; repeat in the same/opposite direction. |
| Both | `gg`, `G`, `{count}gg`, `{count}G` | First/last or numbered line. |
| Both | `(`, `)`, `{`, `}` | Previous/next sentence or paragraph. |
| Both | `[[`, `]]`, `[]`, `][` | Section boundaries (first-column braces in text). |
| Both | `%`, `{count}%` | Matching delimiter or percentage through the buffer. |
| Both | `H`, `M`, `L` | Top/middle/bottom visible line. |
| Both | `/query Enter`, `?query Enter`, `n`, `N` | Search forward/backward, repeat/opposite direction. Timeline search uses its search overlay. |
| Both | `*`, `#`, `g*`, `g#` | Search the word under the cursor forward/backward; timeline `g` variants allow partial-word matches. |
| Both | `m{char}`, `'{char}`, `` `{char} `` | Set a mark, jump to its first nonblank line column, or jump to its exact column. |
| Both | `Ctrl-O`, `Ctrl-I`/`Tab` | Backward/forward in the buffer jump list. Most terminals encode `Ctrl-I` as Tab. |
| Timeline | `gj`, `gk`, `gm`, `gM` | Rendered-line down/up or center-column motions. |
| Timeline | `Ctrl-D`, `Ctrl-U`; `Ctrl-F`, `Ctrl-B` | Half-page or full-page down/up. |
| Composer | `Ctrl-D`, `Ctrl-U`; `Ctrl-F`, `Ctrl-B` | Move the cursor a half-page or page down/up within the composer. |
| Timeline | `Ctrl-E`, `Ctrl-Y` | Scroll the viewport down/up one rendered line. |
| Timeline | `zz`, `zt`, `zb` | Align cursor line at middle/top/bottom of viewport. |
| Timeline | `PageDown`, `PageUp` | Scroll timeline down/up. |

## Selection and text actions

| Context | Keys | Action |
| --- | --- | --- |
| Composer and timeline | `v`, `V`, `Ctrl-V` | Character, line, or rectangular Visual selection. |
| Composer and timeline | Visual `i{object}`, `a{object}` | Select inside/around a text object. |
| Composer and timeline | `iw`/`aw`, `iW`/`aW`, `is`/`as`, `ip`/`ap` | Word, WORD, sentence, and paragraph objects. |
| Composer and timeline | `i(`/`a(`, `i[`/`a[`, `i{`/`a{`, `i<`/`a<`; `b` and `B` aliases | Paired delimiter objects. Closing delimiter aliases also work. |
| Composer and timeline | `i"`/`a"`, `i'`/`a'`, `` i` ``/`` a` `` | Quote objects. |
| Timeline | `y` in Visual, `yy`, `Y`, `yi{object}`, `ya{object}` | Yank selection, line, or object to the clipboard. |
| Timeline | `yiv` | Yank the current timeline event. |
| Timeline | `gx` | Open the link under the cursor. |
| Timeline | `za` | Expand/collapse the current event. |
| Timeline | `[t`, `]t`; `[e`, `]e` | Previous/next turn boundary or timeline error. |
| Composer | `i`, `a`, `A`, `I`, `o`, `O` | Enter Insert mode at cursor, after cursor, line end, first nonblank, or on a new line. |
| Composer | `x`, `X`, `s`, `S`, `D`, `C` | Delete/substitute a character or line, or delete/change through line end. |
| Composer | `d{motion}`, `c{motion}`, `y{motion}`, `dd`, `cc`, `yy`, `Y`, `di{object}`, `da{object}`, `ci{object}`, `ca{object}`, `yi{object}`, `ya{object}` | Delete, change, or yank by motion, line, or object. |
| Composer | Visual `d`, `x`, `c`, `y` | Delete, change, or yank selection. |
| Composer | `r{char}`, `p`, `P`, `u`, `Ctrl-R`, `J`, `~` | Replace a character, paste current system clipboard, undo/redo, join lines, or toggle case. |
| Composer Insert | Type, `Enter`, `Ctrl-U`, `Ctrl-W`, `Esc` | Enter text/newline, delete to line start/previous word, or return to Normal. |
| Composer Insert | `Ctrl-P`, `Ctrl-N` | Previous/next prompt from history. |
| Composer Insert | `PageUp`, `PageDown`, `Ctrl-Up`, `Ctrl-Down` | Scroll the background timeline. |
| Composer Normal/Visual | `Esc` | Cancel a prefix or selection and return to Normal. |
| Timeline Visual | `Esc` | Clear selection and return to Normal. |
| Timeline Normal | `Esc` | Focus composer. |

## Sidebar, terminal, and dialogs

| Context | Keys | Action |
| --- | --- | --- |
| Sidebar | `j`/`k`, `Down`/`Up`; `h`/`l`, `Left`/`Right` | Move selection; collapse/expand branch. |
| Sidebar | `g`, `G`, `Enter` | First/last row; activate workspace or open selection. |
| Sidebar | `[`, `]`, `o`, `c`, `m`, `t` | Resize tree, toggle order, create workspace, choose operational mode, or choose thinking level. |
| Sidebar | `Esc` | Return to composer or active terminal. |
| Terminal Normal | `i`, `Esc`, `q`, `n`, `r` | Enter terminal Insert, focus sidebar, or reconnect terminal. |
| Terminal Normal | `Up`, `Down`, `Ctrl-U`, `Ctrl-D` | Scroll captured terminal output. |
| Terminal Insert | All ordinary keys, `Esc` | Forward bytes to terminal; Escape returns to Normal. |
| Permission dialog | `a`, `d`, `h`, `l`, `Left`, `Right`, `r`, `Esc` | Allow/deny, previous/next request, retry failed decision, close. |
| Notifications | `j`, `k`, `Down`, `Up`, `Enter`, `Esc` | Move selection, open, close. |
| Timeline search overlay | Type, `Ctrl-N`, `Ctrl-P`, `Enter`, `Esc` | Enter query, next/previous result, choose next result, cancel. |
| Palette | Type, `Up`, `Down`, `Enter`, `Esc` | Filter, move selection, run command, close. |
| Help overlay | `?`, `Esc` | Close help and return to the previous view or overlay. |
| Confirmation, new-tab, draft-setting, mode, thinking, error-details and other dialogs | Type or `Up`/`Down` where offered, `Enter`, `Esc` | Filter/edit/select/confirm or cancel according to the dialog. |

The terminal combines some keys: `Ctrl-I`/Tab, `Ctrl-M`/Enter, `Ctrl-H`/Backspace, and `Ctrl-[`/Escape are indistinguishable without an enhanced keyboard protocol. File, tag, syntax, and window motions have no target inside these buffers. Marks currently retain numeric positions after earlier text edits or timeline reflow; place the mark again if its content shifts.

Vim references: [motion commands](https://vimhelp.org/motion.txt.html), [complete command index](https://vimhelp.org/index.txt.html), and [Visual mode](https://vimhelp.org/visual.txt.html).

An existing empty workspace shows the Launch composer with no tab row. Session and Terminal retain separate input when switching. Creation keeps the composer visible until the first message or command has been sent. After a resource has been created, its type and settings remain fixed during retry to avoid creating a duplicate resource.

Sidebar `c` opens the New workspace composer with the highlighted project's original checkout selected (or the highlighted workspace's project). `\j` changes the project and `\n` edits the optional workspace title. Local uses the original checkout; repeated creation makes fresh workspaces for that same directory. The Launch composer controls above also apply here. `Esc` leaves Insert or Visual mode first; a second `Esc` in Normal mode cancels creation and returns to sidebar navigation. `T` is unavailable until creation finishes or is cancelled. If workspace creation succeeds but launch fails, the new workspace stays active with its inputs in the Launch composer; `\s` retries the resource without creating another workspace.
