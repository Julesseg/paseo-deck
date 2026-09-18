import { type TUI, TuiAltScreen } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { RecordingTerminal, TerminalLifecycle } from "./terminal.js";

describe("terminal lifecycle", () => {
  it("stops an alternate screen exactly once after draining input", async () => {
    const terminal = new RecordingTerminal();
    const tui: TUI = new TuiAltScreen(terminal);
    const lifecycle = new TerminalLifecycle(tui, terminal);

    lifecycle.start();
    await lifecycle.stop();
    await lifecycle.stop();

    expect(terminal.started).toBe(true);
    expect(terminal.stopped).toBe(true);
    expect(terminal.writes.join("")).toContain("\u001b[?1049l");
  });
});
