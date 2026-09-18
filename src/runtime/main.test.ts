import { describe, expect, it } from "vitest";
import { emptyDirectory } from "../contracts/app-state.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "../ui/terminal.js";
import { type RuntimeExitHandlers, runCli, runInteractive } from "./main.js";

function output() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (value: string) => {
        stdout += value;
      },
      stderr: (value: string) => {
        stderr += value;
      },
    },
    read: () => ({ stdout, stderr }),
  };
}

describe("runCli", () => {
  it("prints help without starting the terminal", async () => {
    const capture = output();
    await expect(runCli(["--help"], { io: capture.io })).resolves.toBe(0);
    expect(capture.read().stdout).toContain("Usage: paseo-deck");
    expect(capture.read().stderr).toBe("");
  });

  it("prints the package version", async () => {
    const capture = output();
    await expect(runCli(["--version"], { io: capture.io })).resolves.toBe(0);
    expect(capture.read().stdout).toBe("0.1.0\n");
  });

  it("reports invalid selectors with a help hint", async () => {
    const capture = output();
    await expect(
      runCli(["--home", "/tmp/a", "--host", "localhost:6767"], { io: capture.io }),
    ).resolves.toBe(2);
    expect(capture.read().stderr).toContain("Use either --home or --host");
    expect(capture.read().stderr).toContain("--help");
  });

  it("restores the alternate screen after q", async () => {
    const capture = output();
    const terminal = new RecordingTerminal();
    const gateway = new FakePaseoGateway(emptyDirectory());
    const running = runInteractive({ type: "default" }, capture.io, {
      gateway,
      terminal,
      bindExitHandlers: () => () => undefined,
    });
    await tick();

    terminal.sendInput("q");

    await expect(running).resolves.toBe(0);
    expect(terminal.writes.join("")).toContain("\u001b[?1049l");
    expect(terminal.stopped).toBe(true);
  });

  it("restores the alternate screen after Ctrl+C", async () => {
    const capture = output();
    const terminal = new RecordingTerminal();
    const gateway = new FakePaseoGateway(emptyDirectory());
    let handlers: RuntimeExitHandlers | undefined;
    const running = runInteractive({ type: "default" }, capture.io, {
      gateway,
      terminal,
      bindExitHandlers: (value) => {
        handlers = value;
        return () => undefined;
      },
    });
    await tick();

    handlers?.signal("SIGINT");

    await expect(running).resolves.toBe(130);
    expect(terminal.writes.join("")).toContain("\u001b[?1049l");
    expect(terminal.stopped).toBe(true);
  });

  it("restores the terminal when shutdown races a reconnecting observation", async () => {
    const capture = output();
    const terminal = new RecordingTerminal();
    const gateway = new FakePaseoGateway(emptyDirectory());
    const running = runInteractive({ type: "default" }, capture.io, {
      gateway,
      terminal,
      bindExitHandlers: () => () => undefined,
    });
    await tick();
    gateway.emitDirectory({ type: "connection-changed", state: "reconnecting", attempt: 2 });

    terminal.sendInput("q");

    await expect(running).resolves.toBe(0);
    expect(terminal.writes.join("")).toContain("\u001b[?1049l");
    expect(terminal.stopped).toBe(true);
  });
});

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
