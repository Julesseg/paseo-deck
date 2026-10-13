# UI refinement verification

Issues #97–#103 implement the [accepted design](ui-refinement-design.md) on `implement-spec-all-7-open-issues`, tracked by [PR #104](https://github.com/Julesseg/paseo-deck/pull/104). Verification was performed on 2026-10-13 UTC against baseline `a2097b7`.

## Behavior exercised

| Issue | Verified behavior and seam |
| --- | --- |
| #97 | Gateway → store forwards native Workspace status/activity and Session attention. Displaying a visible completed Session acknowledges only its finished attention; Sidebar highlight, hidden completion, Terminal display, permission and error attention remain separate. Fragmented focus reports and literal paste retain input ownership. |
| #98 | Terminal input → DeckTui → controller/store exercises Status/Project grouping, recent/alphabetical ordering, expansion, filters, archived visibility and highlighted identity. Collapsed children retain their captured positions while Sidebar focus freezes membership/order; live badges update. Preferences load/save preserves grouping and ordering across reload. |
| #99 | Rendered terminal cells exercise two-line metadata, missing/native relative ages, heading spacing, default/custom Sidebar widths, drawer activation, label clipping and age priority in both groupings. |
| #100 | Enter restores active content and saved Composer state; bare `i` uses the displayed Workspace. Text objects, pending input, filter text, paste and direct Terminal input retain ownership. Delayed capture, observation and Launch discovery preserve later Sidebar focus or another Workspace activation. Failed Terminal attachment retains one created resource and the retry modal owns typing until attachment succeeds. |
| #101 | Rendered message/tool blocks preserve logical text, copy, semantic anchors and navigation through reflow, streaming, expansion, resize and Session switching. User blocks are right aligned with left aligned text; tools have full-width surfaces and dividers. |
| #102 | Composer spacing and constrained cropping preserve the prompt cursor/settings. The redundant bottom status row is removed. The reproduced fitting token count displays fully at the settings content edge. |
| #103 | Session/draft provider catalogs feed fuzzy suggestions with context/staleness guards. Token eligibility, whole-token replacement, one undo edit, Tab/Enter acceptance without submission, Escape/space/slash dismissal, literal paste and constrained popup geometry are exercised through terminal input. |

## Native daemon evidence

Paseo client, protocol and CI CLI are pinned to `0.11.2`. Checks used an isolated daemon home and loopback listener, leaving the user's daemon/resources alone. Task-owned daemon resources were stopped and removed afterward.

- Two unstarted Sessions were deliberately seeded with persisted `finished` attention while the daemon was stopped. Restart produced native Ready to review activity. Opening one through the production gateway/controller cleared only it; another restart preserved the cleared/unread distinction. Opening the second produced native Done. Creating and killing a Terminal preserved the native mixed-Workspace bucket. Native `activityAt` was null and remained unavailable.
- The production gateway → controller → DeckTui path rendered the isolated daemon's Workspace activity. This confirms real native data reaches the Sidebar.
- Existing Session command discovery returned 108 entries (106 skills, 2 commands). Configured Claude draft discovery returned 111 entries (101 skills, 10 commands); configured Codex draft discovery returned 74 (72 skills, 2 commands). Drafts without a model returned no entries.
- Two owned directory query handles restored after disconnect/reconnect with new subscription IDs and fresh snapshots, without another public subscribed-list call. Releasing both cleared their subscription IDs. Automated cases also cover repeated reconnect and partial startup failure cleanup.

The SDK lacks public per-Session attention clearing and public draft command discovery, so narrow adapters isolate those operations. Attention clearing refreshes the current native reason before sending; the backend RPC has no conditional reason parameter. No live provider turn, slash command or skill prompt was executed. Seeded attention establishes native persistence/RPC/update behavior, not provider turn completion.

## Checks and visual evidence

`npm run check` passed: Biome, TypeScript, 62 test files / 878 tests, coverage, build and packed `paseo-deck`/`pdeck` executable smoke. Coverage: statements 89.15%, branches 81.5%, functions 86.67%, lines 91.25%. Baseline checks passed 57 files / 806 tests. CI results for the final PR head are recorded in the PR.

Independent Standards and Spec reviews have no remaining actionable findings. Review corrections cover collapsed-group ordering and asynchronous Terminal focus; the retry test checks resource/modal identity instead of counting repeated labels across the whole frame.

The standalone HTML report contains 93 terminal-frame PNGs: 42 before and 51 after, including a real native gateway pair. New suggestion states have after captures; the existing no-popup layout has a matched pair. Captures cover both groupings, populated/collapsed/filter states, long/missing metadata, frozen live badges, drawer/short layouts, conversation/tools, Composer spacing/token counts, popup wrapping/selection, and light/plain/ASCII appearances.

Final integrated UI frames at `5745f91` reproduce the earlier rendered SVGs exactly. Native gateway frames were captured at the recorded earlier revisions. Each caption records its source revision and fixture. Chrome rasterization preserves the SVG's native dimensions at 1×; all 93 embedded images were opened and decoded successfully. The report lives locally under `~/.local/share/ui-reports/paseo-deck/implement-spec-all-7-open-issues/`, with its exact path in the PR.

## Idle navigation performance

Sequential final benchmarks used 1,000 Timeline items, 30 Workspaces, 90 Sessions, a 120×35 terminal, Unicode/no color, 100 keys and 10 warmup keys per context. All three passed the 50 ms p95 key-to-first-write target.

| Context | p95 ms | Measured at (UTC) |
| --- | --- | --- |
| tree | 16.3314170000001 | 2026-10-13T22:18:02.836Z |
| timeline | 16.017041999999947 | 2026-10-13T22:18:07.093Z |
| composer | 16.402250000000095 | 2026-10-13T22:18:10.389Z |

Environment: Node v26.10.0, Apple M2 Pro, darwin 27.0.0 / arm64. This measures application/renderer work before terminal painting, not physical display or provider latency. The Timeline setup waits for its transient auto scrollbar to disappear outside timing, then every motion verifies exact cursor movement and the complete terminal text/width cell grid. Other processes on this shared host remain outside the measurement's control.

## Acceptance limits

Physical keyboard delivery, cross-application clipboard, actual macOS visibility/occlusion, terminal focus-report support and live provider execution were not exercised. Terminals without focus reports default to visible while Deck runs. Synthetic captures record terminal text/background cells but use fixed SVG foreground colors, so light-mode foreground contrast and physical terminal painting remain unverified. Controlled fixtures and native catalog reads do not establish provider execution.
