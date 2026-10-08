# Interaction performance

Common idle interactions must remain below 50 ms p95 from key input to the first terminal write with approximately 1,000 Timeline items. This measures application and renderer work before the terminal emulator paints. ADR-0002 retains TypeScript and the public Paseo SDK; optimize measured bottlenecks rather than changing languages.

## Repeatable assembled measurement

Run `npm run bench:navigation -- 1000 100 <symbols> <context> <color>` with `symbols` = `unicode` or `ascii`, `context` = `composer`, `tree` (Sidebar), or `timeline`, and `color` = `none`, `ansi16`, `ansi256`, or `truecolor`. Defaults are 1,000 items, 100 samples, Unicode Sidebar, and no color. Each process uses 10 additional warmup keys, excluded from the sample statistics. Run contexts and modes sequentially without concurrent test/build/benchmark jobs.

All contexts use the same 120×35 RecordingTerminal, DeckTui, ApplicationController/store, FakePaseoGateway fixture: one Project, 30 Workspaces, 90 idle Sessions, and 1,000 assistant messages. Each message contains `A completed response with enough predictable content to wrap across several terminal lines.` Item and message IDs are `message-0` through `message-999`, with one turn per five messages. The initial active Workspace and Session are `workspace-0` and `session-0`. Sidebar movement changes only its selection; Timeline navigation starts near the beginning on a visible interior row. Composer Insert alternates `x` and Backspace; Sidebar and Timeline alternate `j` and `k`. The history is restored to the identical original fixture before idle sampling in every context.

The script timestamps the first `terminal.write` inside the write callback, before xterm parsing. Dispatch is measured separately. Every sample then flushes the headless terminal and asserts the actual outcome: inserted/deleted Composer text in the store and visible cells; Sidebar selection and unchanged Active workspace/content; Timeline hardware-cursor row movement with unchanged visible text. These assertions are outside the measured latency. It fails if the idle p95 reaches 50 ms. Percentiles use the nearest-rank method.

Cold display and full replacement each have one separate observation per process, excluded from idle statistics and the idle target. Cold display starts at `deck.start()` and ends at the first content-bearing frame; it excludes module loading, fixture construction and DeckTui construction. Replacement starts at the subscribed FakePaseoGateway's `replaced` event, replacing all 1,000 messages with newly allocated events whose text starts `Replacement response`, and ends at the first terminal write. Visible cold and replacement content is asserted. These are different operations from warm unchanged-history navigation; no 50 ms cold/replacement claim is made.

The existing width-specific rendered-layout and canonical-text caches, and focused Timeline's two-row repaint, remain in place. No application optimization was introduced for this measurement task. Existing anchor, selection, streaming, reflow and layout regression checks remain the correctness guard around those caches.

## Measured results

Measured on 2026-10-08, Node v26.10.0, macOS 27.0 build 26A428 / Darwin 27.0.0, arm64, Apple M2 Pro, integration-based revision `b45480f15638c071d50c0674bf29f4122a079a08` plus the benchmark changes in this ticket. The first observation completed at 2026-10-08T07:33:47.258Z; the last completed at 2026-10-08T07:35:17.130Z. All 24 processes passed their outcome assertions and idle target, with 100 measured keys and 10 excluded warmups per process (2,400 measured idle keys total). Values below are the returned millisecond values, without rounding. Cold and replacement columns are single observations, not percentiles.

| Symbols | Color | Context | Median ms | p95 ms | Cold display ms | Replacement ms |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| unicode | none | Composer | 15.147958000000017 | 16.422791999999845 | 304.509083 | 289.1736669999999 |
| unicode | none | Sidebar | 15.127124999999978 | 16.41274999999996 | 303.9885 | 317.259584 |
| unicode | none | Timeline | 15.063874999999825 | 16.19012500000008 | 337.37149999999997 | 319.8132079999999 |
| unicode | ansi16 | Composer | 14.856083000000126 | 16.212584000000106 | 310.68929199999997 | 275.87983299999996 |
| unicode | ansi16 | Sidebar | 14.919167000000016 | 15.956125000000156 | 335.689167 | 296.479375 |
| unicode | ansi16 | Timeline | 14.687208000000282 | 16.577166999999918 | 317.56004200000007 | 311.132792 |
| unicode | ansi256 | Composer | 14.772915999999896 | 16.31354199999987 | 400.53162499999996 | 280.72612500000014 |
| unicode | ansi256 | Sidebar | 14.885041999999885 | 26.69549999999981 | 344.43041700000003 | 334.916833 |
| unicode | ansi256 | Timeline | 14.531999999999925 | 16.290583000000424 | 317.106 | 274.59733400000005 |
| unicode | truecolor | Composer | 14.719665999999961 | 15.915083999999752 | 472.045875 | 448.15162499999997 |
| unicode | truecolor | Sidebar | 14.953875000000153 | 16.090374999999767 | 308.982375 | 281.5310840000001 |
| unicode | truecolor | Timeline | 14.636415999999826 | 16.073374999999942 | 316.542125 | 284.88762499999996 |
| ascii | none | Composer | 15.099416999999903 | 15.937542000000121 | 279.454042 | 248.40724999999998 |
| ascii | none | Sidebar | 15.41924999999992 | 16.222541999999976 | 298.0885 | 267.707041 |
| ascii | none | Timeline | 14.943125000000009 | 16.347166000000016 | 320.033167 | 287.32741699999997 |
| ascii | ansi16 | Composer | 15.170583000000079 | 16.234750000000076 | 516.353333 | 486.09620900000004 |
| ascii | ansi16 | Sidebar | 15.159750000000258 | 16.321792000000187 | 311.12866600000007 | 499.42287499999986 |
| ascii | ansi16 | Timeline | 14.915874999999915 | 19.167832999999973 | 300.86808299999996 | 263.8494169999999 |
| ascii | ansi256 | Composer | 15.111708000000135 | 16.347000000000207 | 291.685667 | 295.9336249999999 |
| ascii | ansi256 | Sidebar | 15.095584000000144 | 16.99324999999999 | 301.9119579999999 | 322.0882080000001 |
| ascii | ansi256 | Timeline | 14.952374999999847 | 16.429208000000017 | 285.799625 | 266.15825000000007 |
| ascii | truecolor | Composer | 14.87887499999988 | 16.216875000000073 | 284.02662499999997 | 366.258958 |
| ascii | truecolor | Sidebar | 15.08704200000011 | 16.30445799999984 | 295.358417 | 262.2739999999999 |
| ascii | truecolor | Timeline | 14.78512499999988 | 16.14424999999983 | 303.283375 | 264.6460420000001 |

Exact sequential sweep command (run from the repository):

```sh
for symbols in unicode ascii; do
  for color in none ansi16 ansi256 truecolor; do
    for context in composer tree timeline; do
      npm run bench:navigation -- 1000 100 "$symbols" "$context" "$color"
    done
  done
done
```

No concurrent test/build/benchmark or isolated daemon jobs ran during the reserved measurement window. The rows include the injected appearance modes; they do not compare different fixture content. Timeline content assertions exclude its independently fading scrollbar gutter while retaining cell positions and text in the content region.


## Limits

RecordingTerminal uses a headless xterm emulator. These timings do not measure physical terminal paint, keyboard delivery, display refresh, the production daemon, provider execution or live-network latency. Cold display is not process launch. One cold/replacement observation per process does not establish a percentile or service-level target. A finite synthetic fixture cannot establish responsiveness for every message type, history size, terminal width, runtime pause or machine load. Supported color/symbol modes are measured with explicitly injected appearance; this does not verify capability detection in a physical terminal.

The September measurements recorded before spec #72 used different implementations, sample counts and in some cases different fixtures. They remain historical ADR context and are not evidence for these results.
