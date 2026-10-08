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

## Final #93 integration rerun

The declared 24-process sequential sweep was repeated after the final Composer cursor/selection repaint fix (base `63593ad` plus #93). All 24 processes passed visible outcome assertions and idle p95 <50 ms. Raw external evidence: `/tmp/paseo-spec-72/bench-93-final.jsonl`. Each used the unchanged 1,000-item/30-Workspace/90-Session/120x35 fixture, 10 excluded warmups and 100 measured keys. The earlier pre-fix sweep is retained separately as `bench-93-before-repaint.jsonl`; its values are not mixed into this table.

| Symbols | Color | Context | Idle median ms | Idle p95 ms | Cold single observation ms | Replacement single observation ms |
| --- | --- | --- | --- | --- | --- | --- |
| unicode | none | composer | 14.935457999999926 | 16.871583999999984 | 317.57108299999993 | 271.8811249999999 |
| unicode | none | tree | 14.960375000000113 | 17.907042000000274 | 332.456917 | 341.47733299999993 |
| unicode | none | timeline | 14.858957999999802 | 16.63779199999999 | 315.697125 | 300.8463750000001 |
| unicode | ansi16 | composer | 14.964958000000024 | 16.391166999999996 | 308.010167 | 283.05329200000006 |
| unicode | ansi16 | tree | 14.585250000000087 | 17.522917000000234 | 343.261709 | 327.4928749999999 |
| unicode | ansi16 | timeline | 14.448707999999897 | 18.96804199999997 | 449.550042 | 320.79287499999987 |
| unicode | ansi256 | composer | 14.745916000000307 | 18.467415999999957 | 352.531583 | 360.4458340000001 |
| unicode | ansi256 | tree | 14.750708000000031 | 16.363459000000148 | 366.96091700000005 | 312.3104169999999 |
| unicode | ansi256 | timeline | 14.60458299999982 | 15.638374999999996 | 407.32766699999996 | 277.455458 |
| unicode | truecolor | composer | 14.744333000000097 | 15.971708999999919 | 325.847542 | 388.545875 |
| unicode | truecolor | tree | 14.686584000000039 | 16.342291999999816 | 329.730875 | 326.757208 |
| unicode | truecolor | timeline | 14.78970900000013 | 21.009040999999797 | 310.67975 | 280.365458 |
| ascii | none | composer | 15.151375000000144 | 16.637916000000132 | 290.874834 | 261.4827909999999 |
| ascii | none | tree | 15.01545800000008 | 16.227750000000015 | 321.97716699999995 | 265.05725000000007 |
| ascii | none | timeline | 16.11658299999999 | 38.15929099999994 | 293.352541 | 389.575334 |
| ascii | ansi16 | composer | 14.880750000000262 | 17.43466699999999 | 422.116 | 299.2696669999999 |
| ascii | ansi16 | tree | 14.978582999999617 | 17.38149999999996 | 332.80054199999995 | 345.8341670000001 |
| ascii | ansi16 | timeline | 14.970749999999953 | 16.24504100000013 | 311.58579199999997 | 255.643959 |
| ascii | ansi256 | composer | 14.966875000000073 | 18.57400000000007 | 305.884334 | 317.9492909999999 |
| ascii | ansi256 | tree | 15.240166999999929 | 17.219750000000204 | 383.801458 | 307.2885 |
| ascii | ansi256 | timeline | 14.814542000000074 | 17.247542000000067 | 390.14104199999997 | 286.20170799999994 |
| ascii | truecolor | composer | 15.051124999999956 | 26.20404099999996 | 317.64379199999996 | 329.2618749999999 |
| ascii | truecolor | tree | 15.289209000000028 | 17.11245800000006 | 319.00095799999997 | 266.906833 |
| ascii | truecolor | timeline | 14.978542000000289 | 17.69404099999997 | 338.36354100000005 | 257.954834 |

Environment: {"measuredAt": "2026-10-08T13:13:02.536Z", "node": "v26.10.0", "platform": "darwin", "release": "27.0.0", "arch": "arm64", "cpu": "Apple M2 Pro"}. Native daemons were stopped and there were no concurrent tests/builds/captures/probes during this reserved sweep. Headless first-write, cold/replacement and physical-host limits above still apply.


## Final review input-ownership rerun

Moving Deck input ownership before inherited fullscreen handlers changed the measured idle input path, so the full declared 24-process sequential sweep was repeated on base `9d6f40e` plus the review fixes in this change. No later production changes followed this measurement. All 24 processes passed visible outcome assertions and idle p95 <50 ms. Raw external evidence: `/tmp/paseo-spec-72/bench-review-fixes.jsonl`. The same 1,000-item/30-Workspace/90-Session/120x35 fixture, 10 excluded warmups and 100 measured keys were used. The #93 table above remains historical evidence for its declared revision.

| Symbols | Color | Context | Idle median ms | Idle p95 ms | Cold single observation ms | Replacement single observation ms |
| --- | --- | --- | --- | --- | --- | --- |
| unicode | none | composer | 15.08504099999982 | 16.149582999999893 | 324.935917 | 294.647834 |
| unicode | none | tree | 15.198583999999983 | 16.099874999999884 | 341.15979200000004 | 301.97362499999997 |
| unicode | none | timeline | 14.912792000000081 | 16.047291999999743 | 311.715459 | 277.94000000000005 |
| unicode | ansi16 | composer | 14.67141700000002 | 15.848124999999982 | 335.05616599999996 | 319.5249170000001 |
| unicode | ansi16 | tree | 15.275333000000046 | 34.85470899999973 | 318.468625 | 272.08945800000015 |
| unicode | ansi16 | timeline | 21.31433299999935 | 43.37750000000051 | 1160.9085 | 730.9688329999999 |
| unicode | ansi256 | composer | 18.89624999999978 | 39.55762499999946 | 861.8482079999999 | 778.94875 |
| unicode | ansi256 | tree | 15.120957999999973 | 15.868207999999868 | 344.369792 | 275.27312500000005 |
| unicode | ansi256 | timeline | 14.863916000000245 | 20.87833300000011 | 331.3995 | 281.77750000000003 |
| unicode | truecolor | composer | 14.946500000000015 | 15.83508299999994 | 318.58904099999995 | 298.7805410000001 |
| unicode | truecolor | tree | 14.832292000000052 | 17.792167000000063 | 324.76775 | 358.660083 |
| unicode | truecolor | timeline | 14.878499999999804 | 21.10216700000001 | 375.66008300000004 | 310.35679200000015 |
| ascii | none | composer | 15.102166000000125 | 16.765249999999924 | 334.89662500000003 | 251.9375419999999 |
| ascii | none | tree | 15.06041600000026 | 16.29712500000005 | 284.291791 | 248.90983299999994 |
| ascii | none | timeline | 15.241791999999805 | 17.41608300000007 | 280.677209 | 249.93820799999992 |
| ascii | ansi16 | composer | 15.01120899999978 | 16.22008299999993 | 334.406333 | 286.6310830000001 |
| ascii | ansi16 | tree | 15.043083999999908 | 16.122666999999865 | 330.825208 | 266.89375000000007 |
| ascii | ansi16 | timeline | 14.981417000000192 | 16.544875000000047 | 287.147208 | 258.4865 |
| ascii | ansi256 | composer | 15.05054199999995 | 16.31708299999991 | 309.10566600000004 | 255.414583 |
| ascii | ansi256 | tree | 15.131417000000056 | 18.631875000000036 | 313.459459 | 302.060791 |
| ascii | ansi256 | timeline | 14.822165999999925 | 16.368167000000085 | 288.38545799999997 | 267.590291 |
| ascii | truecolor | composer | 15.043042000000241 | 16.737082999999984 | 289.82725 | 277.4747910000001 |
| ascii | truecolor | tree | 15.0864160000001 | 16.167124999999942 | 300.5615 | 254.50079099999994 |
| ascii | truecolor | timeline | 14.945875000000342 | 15.975374999999985 | 313.908334 | 304.68225000000007 |

First-process environment: `{"measuredAt": "2026-10-08T13:28:20.155Z", "node": "v26.10.0", "platform": "darwin", "release": "27.0.0", "arch": "arm64", "cpu": "Apple M2 Pro"}`. Root confirmed task-owned daemons and Chrome stopped; no concurrent tests/builds/captures/probes ran during this reserved sequential sweep. Headless first-write, single-observation cold/replacement and physical-host limitations above still apply.
