import { describe, expect, it, vi } from "vitest";
import { ShutdownCoordinator } from "./lifecycle.js";

describe("ShutdownCoordinator", () => {
  it("releases observations, closes the gateway, and restores the terminal in order", async () => {
    const calls: string[] = [];
    const coordinator = new ShutdownCoordinator({
      releaseObservations: async () => calls.push("release"),
      closeGateway: async () => calls.push("close"),
      drainInput: async () => calls.push("drain"),
      restoreTerminal: async () => calls.push("restore"),
    });

    await coordinator.shutdown();

    expect(calls).toEqual(["release", "close", "drain", "restore"]);
  });

  it("is idempotent when shutdown paths race", async () => {
    const restoreTerminal = vi.fn(async () => undefined);
    const coordinator = new ShutdownCoordinator({
      releaseObservations: async () => undefined,
      closeGateway: async () => undefined,
      drainInput: async () => undefined,
      restoreTerminal,
    });

    await Promise.all([coordinator.shutdown(), coordinator.shutdown()]);

    expect(restoreTerminal).toHaveBeenCalledTimes(1);
  });

  it("restores the terminal even when earlier cleanup fails", async () => {
    const restoreTerminal = vi.fn(async () => undefined);
    const coordinator = new ShutdownCoordinator({
      releaseObservations: async () => {
        throw new Error("release failed");
      },
      closeGateway: async () => undefined,
      drainInput: async () => undefined,
      restoreTerminal,
    });

    await expect(coordinator.shutdown()).rejects.toThrow("release failed");
    expect(restoreTerminal).toHaveBeenCalledOnce();
  });
});
