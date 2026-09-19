import { describe, expect, it } from "vitest";
import { composerAvailability } from "./composer.js";
import { createInitialState, reduceApp } from "./store.js";

describe("composer availability", () => {
  it("distinguishes a detached agent from one that was never known", () => {
    const state = {
      ...createInitialState(),
      connection: "connected" as const,
      composer: { ...createInitialState().composer, detachedAgentIds: new Set(["detached"]) },
    };
    expect(composerAvailability(state, "detached")).toEqual({ canSend: false, reason: "detached" });
    expect(composerAvailability(state, "missing")).toEqual({ canSend: false, reason: "missing" });
  });

  it.each([
    ["disconnected", undefined, "disconnected"],
    ["missing", "connected", "missing"],
    ["archived", "connected", "archived"],
    ["stopped", "connected", "stopped"],
    ["failed", "connected", "failed"],
  ] as const)("reports %s destinations", (_name, connection, reason) => {
    let state = createInitialState();
    if (connection) state = { ...state, connection };
    if (reason !== "missing" && connection) {
      state = reduceApp(state, {
        type: "directory",
        update: {
          type: "snapshot",
          snapshot: {
            projects: [],
            workspaces: [],
            providers: [],
            agents: [
              {
                id: "agent",
                workspaceId: "workspace",
                title: "Agent",
                status: reason === "archived" ? "archived" : reason,
                availableModeIds: [],
                availableThinkingLevels: [],
                pendingPermissions: [],
                needsAttention: false,
                archived: reason === "archived",
              },
            ],
          },
        },
      });
    }
    expect(composerAvailability(state, "agent")).toEqual({ canSend: false, reason });
  });
});
