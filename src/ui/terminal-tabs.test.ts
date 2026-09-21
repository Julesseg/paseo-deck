import { describe, expect, it } from "vitest";
import { emptyDirectory } from "../contracts/app-state.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { TerminalTabs } from "./terminal-tabs.js";

describe("workspace terminal tabs", () => {
  it("discovers and opens terminals without treating them as sessions", async () => {
    const gateway = new FakePaseoGateway(emptyDirectory());
    await gateway.connect();
    const terminal = await gateway.createTerminal("workspace-1", { name: "build" });
    const tabs = new TerminalTabs();
    expect((await tabs.discover(gateway, "workspace-1")).map((item) => item.id)).toEqual([
      terminal.id,
    ]);
    await tabs.open(gateway, terminal);
    expect(tabs.active?.terminal.name).toBe("build");
  });

  it("forwards only insert-mode input and keeps close separate from kill", async () => {
    const gateway = new FakePaseoGateway(emptyDirectory());
    await gateway.connect();
    const terminal = await gateway.createTerminal("workspace-1");
    const tabs = new TerminalTabs();
    await tabs.open(gateway, terminal);
    tabs.input(gateway, "ignored");
    tabs.setMode("insert");
    tabs.input(gateway, "literal\u001b[A");
    expect(gateway.terminalInput).toEqual([{ terminalId: terminal.id, data: "literal\u001b[A" }]);
    tabs.close();
    expect(gateway.terminals).toHaveLength(1);
    await tabs.open(gateway, terminal);
    await tabs.kill(gateway);
    expect(gateway.terminals).toHaveLength(0);
  });

  it("sanitizes stream output and reconciles stale terminals", async () => {
    const gateway = new FakePaseoGateway(emptyDirectory());
    await gateway.connect();
    const terminal = await gateway.createTerminal("workspace-1");
    const tabs = new TerminalTabs();
    await tabs.open(gateway, terminal);
    gateway.emitTerminal({
      type: "output",
      terminalId: terminal.id,
      data: new TextEncoder().encode("ok\u001b]52;c;secret\u0007"),
    });
    expect(tabs.active?.lines.join("\n")).not.toContain("secret");
    await gateway.killTerminal(terminal.id);
    await tabs.discover(gateway, "workspace-1");
    expect(tabs.active?.stale).toBe(true);
  });
});
