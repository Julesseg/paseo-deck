import { describe, expect, it } from "vitest";
import { emptyDirectory } from "../contracts/app-state.js";
import type { DirectorySnapshot } from "../contracts/domain.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "../ui/terminal.js";
import { type RuntimeExitHandlers, runCli, runInteractive } from "./main.js";
import { type PreferenceFileSystem, targetScope } from "./preferences.js";

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
      ...testRuntimeDependencies(),
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

  it("injects the runtime appearance once instead of reading environment in views", async () => {
    const capture = output();
    const terminal = new RecordingTerminal();
    const gateway = new FakePaseoGateway(emptyDirectory());
    const running = runInteractive({ type: "default" }, capture.io, {
      ...testRuntimeDependencies(),
      gateway,
      terminal,
      environment: { NO_COLOR: "1", LANG: "C", TERM: "dumb" },
      bindExitHandlers: () => () => undefined,
    });
    await tick();
    await terminal.waitForRender();
    terminal.sendInput("q");

    await expect(running).resolves.toBe(0);
    expect(terminal.writes.join("")).not.toContain("\u001b[38;");
  });

  it("restores the alternate screen after Ctrl+C", async () => {
    const capture = output();
    const terminal = new RecordingTerminal();
    const gateway = new FakePaseoGateway(emptyDirectory());
    let handlers: RuntimeExitHandlers | undefined;
    const running = runInteractive({ type: "default" }, capture.io, {
      ...testRuntimeDependencies(),
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
      ...testRuntimeDependencies(),
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

  it.each([
    ["corrupt JSON", "{PRIVATE_CORRUPT_CONTENT"],
    ["a future version", '{"version":99,"private":"PRIVATE_FUTURE_CONTENT"}'],
  ])("starts safely with %s preference data and never prints it", async (_name, bytes) => {
    const capture = output();
    const terminal = new RecordingTerminal();
    const running = runInteractive({ type: "default" }, capture.io, {
      gateway: new FakePaseoGateway(emptyDirectory()),
      terminal,
      preferencesPath: "/private/preferences.json",
      preferences: memoryPreferences(bytes),
      bindExitHandlers: () => () => undefined,
    });

    await tick();
    expect(terminal.started).toBe(true);
    expect(capture.read().stderr).toContain("Could not load saved preferences; using defaults.");
    expect(capture.read().stderr).not.toContain("PRIVATE_");
    expect(capture.read().stderr).not.toContain("/private/preferences.json");
    terminal.sendInput("q");
    await expect(running).resolves.toBe(0);
  });

  it("loads preferences before the first terminal render and daemon connection", async () => {
    const order: string[] = [];
    class OrderedTerminal extends RecordingTerminal {
      override write(data: string): void {
        order.push("render");
        super.write(data);
      }
    }
    class OrderedGateway extends FakePaseoGateway {
      override async connect(): Promise<void> {
        order.push("connect");
        await super.connect();
      }
    }
    const terminal = new OrderedTerminal();
    const running = runInteractive({ type: "default" }, output().io, {
      gateway: new OrderedGateway(emptyDirectory()),
      terminal,
      preferences: {
        readFile: async () => {
          order.push("read-preferences");
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        writeAtomic: async () => undefined,
        remove: async () => undefined,
      },
      preferencesPath: "/preferences.json",
      bindExitHandlers: () => () => undefined,
    });

    await tick();
    expect(order.indexOf("read-preferences")).toBeLessThan(order.indexOf("render"));
    expect(order.indexOf("read-preferences")).toBeLessThan(order.indexOf("connect"));
    terminal.sendInput("q");
    await expect(running).resolves.toBe(0);
  });

  it("retains saved rich choices on a low-capability launch and restores them on a capable one", async () => {
    let bytes = JSON.stringify({
      version: 1,
      global: { theme: "ember", symbolSet: "unicode" },
      targets: {},
    });
    const preferences: PreferenceFileSystem = {
      readFile: async () => bytes,
      writeAtomic: async (_path, value) => {
        bytes = value;
      },
      remove: async () => undefined,
    };
    const lowTerminal = new RecordingTerminal();
    const low = runInteractive({ type: "default" }, output().io, {
      gateway: new FakePaseoGateway(emptyDirectory()),
      terminal: lowTerminal,
      preferences,
      preferencesPath: "/preferences.json",
      environment: { NO_COLOR: "1", TERM: "dumb", LANG: "C" },
      bindExitHandlers: () => () => undefined,
    });
    await tick();
    await lowTerminal.waitForRender();
    expect(lowTerminal.writes.join("")).not.toContain("\u001b[38;");
    expect(lowTerminal.writes.join("")).not.toContain("·");
    lowTerminal.sendInput("q");
    await expect(low).resolves.toBe(0);
    expect(JSON.parse(bytes).global).toEqual({ theme: "ember", symbolSet: "unicode" });

    const richTerminal = new RecordingTerminal();
    const rich = runInteractive({ type: "default" }, output().io, {
      gateway: new FakePaseoGateway(emptyDirectory()),
      terminal: richTerminal,
      preferences,
      preferencesPath: "/preferences.json",
      environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
      bindExitHandlers: () => () => undefined,
    });
    await tick();
    await richTerminal.waitForRender();
    richTerminal.sendInput("q");
    await expect(rich).resolves.toBe(0);

    expect(richTerminal.writes.join("")).toContain("\u001b[38;5;");
    expect(richTerminal.writes.join("")).toContain("·");
  });

  it.each([
    ["ember", "plain", "\\u001b[38;2;"],
    ["terminal", "ember", "\\u001b[37m"],
  ] as const)(
    "configuration theme %s overrides saved theme %s",
    async (configured, saved, marker) => {
      const terminal = new RecordingTerminal();
      const running = runInteractive({ type: "default" }, output().io, {
        gateway: new FakePaseoGateway(emptyDirectory()),
        terminal,
        preferences: memoryPreferences(
          JSON.stringify({ version: 1, global: { theme: saved }, targets: {} }),
        ),
        preferencesPath: "/preferences.json",
        environment: { COLORTERM: "truecolor", LANG: "en_US.UTF-8", PASEO_DECK_THEME: configured },
        bindExitHandlers: () => () => undefined,
      });
      await tick();
      await terminal.waitForRender();
      expect(terminal.writes.join("")).toContain(marker.replace("\\u001b", "\u001b"));
      terminal.sendInput("q");
      await expect(running).resolves.toBe(0);
    },
  );

  it("loads target state before rendering, isolates tree state, and shares presentation choices", async () => {
    let bytes: string | undefined;
    const events: string[] = [];
    const preferences: PreferenceFileSystem = {
      readFile: async () => {
        events.push("read-preferences");
        if (bytes) return bytes;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      writeAtomic: async (_path, value) => {
        bytes = value;
      },
      remove: async () => undefined,
    };
    const launch = async (target: { type: "host"; value: string }) => {
      const terminal = new RecordingTerminal(100, 20);
      const gateway = new FakePaseoGateway(treeDirectory());
      const running = runInteractive(target, output().io, {
        gateway,
        terminal,
        preferences,
        preferencesPath: "/preferences.json",
        environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
        bindExitHandlers: () => () => undefined,
      });
      await tick();
      await terminal.waitForRender();
      return { terminal, running };
    };

    const firstA = await launch({ type: "host", value: "a:1" });
    await mutateTreePreferences(firstA.terminal, true);
    firstA.terminal.sendInput("\u000b");
    firstA.terminal.sendInput("toggle theme");
    firstA.terminal.sendInput("\r");
    await firstA.terminal.waitForRender();
    firstA.terminal.sendInput("\u000b");
    firstA.terminal.sendInput("toggle symbol set");
    firstA.terminal.sendInput("\r");
    await firstA.terminal.waitForRender();
    firstA.terminal.sendInput("q");
    await expect(firstA.running).resolves.toBe(0);

    const firstB = await launch({ type: "host", value: "b:1" });
    await mutateTreePreferences(firstB.terminal, false);
    firstB.terminal.sendInput("q");
    await expect(firstB.running).resolves.toBe(0);

    const restoredA = await launch({ type: "host", value: "a:1" });
    expect(events.indexOf("read-preferences")).toBeGreaterThanOrEqual(0);
    expect(restoredA.terminal.viewport().join("\n")).toContain("Persisted project");
    restoredA.terminal.sendInput("q");
    await expect(restoredA.running).resolves.toBe(0);

    const parsed = JSON.parse(bytes ?? "{}") as {
      global: unknown;
      targets: Record<string, unknown>;
    };
    expect(parsed.global).toEqual({ theme: "plain", symbolSet: "ascii" });
    expect(parsed.targets).toHaveProperty(targetScope({ type: "host", value: "a:1" }));
    expect(parsed.targets).toHaveProperty(targetScope({ type: "host", value: "b:1" }));
    expect(parsed.targets[targetScope({ type: "host", value: "a:1" })]).toMatchObject({
      treeWidth: 36,
      treeOrder: "alphabetical",
      showArchived: true,
      expandedIds: ["project"],
    });
    expect(parsed.targets[targetScope({ type: "host", value: "b:1" })]).toMatchObject({
      treeWidth: 32,
      treeOrder: "attention",
      showArchived: false,
      expandedIds: ["project"],
    });
  });
});

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function testRuntimeDependencies(): { preferences: PreferenceFileSystem; preferencesPath: string } {
  return {
    preferencesPath: "/preferences.json",
    preferences: {
      readFile: async () => {
        const error = Object.assign(new Error("missing"), { code: "ENOENT" });
        throw error;
      },
      writeAtomic: async () => undefined,
      remove: async () => undefined,
    },
  };
}

function memoryPreferences(initial?: string): PreferenceFileSystem {
  let bytes = initial;
  return {
    readFile: async () => {
      if (bytes !== undefined) return bytes;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    writeAtomic: async (_path, value) => {
      bytes = value;
    },
    remove: async () => undefined,
  };
}

function treeDirectory(): DirectorySnapshot {
  return {
    projects: [{ id: "project", name: "Persisted project" }],
    workspaces: [
      {
        id: "workspace",
        projectId: "project",
        title: "Persisted workspace",
        directory: "/safe",
        archived: false,
      },
    ],
    agents: [
      {
        id: "agent",
        workspaceId: "workspace",
        title: "Persisted agent",
        status: "idle",
        availableModeIds: [],
        availableThinkingLevels: [],
        pendingPermissions: [],
        needsAttention: false,
        archived: false,
      },
    ],
    providers: [],
  };
}

async function mutateTreePreferences(terminal: RecordingTerminal, widen: boolean): Promise<void> {
  terminal.sendInput("n");
  terminal.sendInput("j");
  await tick();
  terminal.sendInput("\r");
  await tick();
  terminal.sendInput("j");
  await tick();
  terminal.sendInput("\r");
  await tick();
  if (widen) {
    terminal.sendInput("o");
    terminal.sendInput("v");
    terminal.sendInput("]");
  } else {
    terminal.sendInput("[");
  }
  await terminal.waitForRender();
}
