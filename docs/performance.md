# Interaction performance

The target for common idle actions is p95 under 50 ms from key input to the first terminal write, including when the active session has about 1,000 timeline items. This measures application and renderer work before the terminal emulator paints the frame.

Run the repeatable synthetic sidebar benchmark with `npm run bench:navigation -- 1000 20`. It uses 30 workspaces, 90 idle sessions, a 120×35 headless terminal, and 1,000 short assistant messages. It waits for the first frame before alternating `j` and `k`, then records dispatch and key-to-write times. It does not measure the live daemon, a particular terminal emulator, or a cold timeline load.

Pass `unicode timeline` as the third and fourth arguments to measure the focused timeline's rendered-line cursor. The benchmark verifies every `k`/`j` move. On 2026-09-26, the branch before width-specific layout caching took about 630 ms median and 953 ms p95 for 1,000 items. Caching rendered layouts by width, repainting only the old and new cursor lines, and reusing sanitized line arrays brought two 20-key runs to 15 ms median and 20/17 ms p95. Repeated runs vary with runtime pauses; this is a synthetic key-to-write check, not a live terminal paint measurement.

The third argument selects `unicode` (default) or `ascii` chrome. Six alternating runs of `npm run bench:navigation -- 1000 20 <symbols>` on 2026-09-25 gave Unicode p95 values of 17.5, 17.2, and 19.6 ms and ASCII p95 values of 16.7, 17.3, and 17.6 ms. Both meet the 50 ms target. The small difference does not justify a separate interactive symbol mode; ASCII remains available through capability detection and `PASEO_DECK_ASCII=1` for font compatibility. This comparison does not assess the separate printable ASCII text fast path.

On an Apple Silicon Mac on 2026-09-25, the same benchmark script produced:

| Revision | Median key to write | p95 key to write |
| --- | ---: | ---: |
| Base commit `0bbebdc` | 2,041 ms | 2,144 ms |
| Cached timeline rendering and ASCII text fast path | 15 ms | 20 ms |

The sidebar key itself dispatched in less than 2 ms at p95 in both runs. Profiling the base path showed repeated timeline rendering at several layout widths. The timeline view now reuses unchanged rendered lines by width; changes to history, disclosure, appearance, focus, and headings cause new output. Printable ASCII uses a direct grapheme and cell-width path while Unicode still uses grapheme segmentation.

Other synthetic checks with 1,000 timeline items measured 34 ms p95 for typing 20 characters and 30 ms for one switch away from the active session. These are different fixtures, so they are not substitutes for the live acceptance test.

A cold render of a 1,000-item timeline still took about 394 ms in the synthetic fixture after the text fast path. Opening a long session or receiving a large history replacement needs a separate measured fix, likely reducing work to the visible viewport. A live terminal and daemon run remains necessary before claiming the whole application meets the target.
