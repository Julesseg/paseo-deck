# Interaction performance

The target for common idle actions is p95 under 50 ms from key input to the first terminal write, including when the active session has about 1,000 timeline items. This measures application and renderer work before the terminal emulator paints the frame.

Run the repeatable synthetic sidebar benchmark with `npm run bench:navigation -- 1000 20`. It uses 30 workspaces, 90 idle sessions, a 120×35 headless terminal, and 1,000 short assistant messages. It waits for the first frame before alternating `j` and `k`, then records dispatch and key-to-write times. It does not measure the live daemon, a particular terminal emulator, or a cold timeline load.

On an Apple Silicon Mac on 2026-09-25, the same benchmark script produced:

| Revision | Median key to write | p95 key to write |
| --- | ---: | ---: |
| Base commit `0bbebdc` | 2,041 ms | 2,144 ms |
| Cached timeline rendering and ASCII text fast path | 15 ms | 20 ms |

The sidebar key itself dispatched in less than 2 ms at p95 in both runs. Profiling the base path showed repeated timeline rendering at several layout widths. The timeline view now reuses unchanged rendered lines by width; changes to history, disclosure, appearance, focus, and headings cause new output. Printable ASCII uses a direct grapheme and cell-width path while Unicode still uses grapheme segmentation.

Other synthetic checks with 1,000 timeline items measured 34 ms p95 for typing 20 characters and 30 ms for one switch away from the active session. These are different fixtures, so they are not substitutes for the live acceptance test.

A cold render of a 1,000-item timeline still took about 394 ms in the synthetic fixture after the text fast path. Opening a long session or receiving a large history replacement needs a separate measured fix, likely reducing work to the visible viewport. A live terminal and daemon run remains necessary before claiming the whole application meets the target.
