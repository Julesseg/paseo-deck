import { describe, expect, it } from "vitest";
import { CliArgumentError, parseArguments } from "./arguments.js";

describe("parseArguments", () => {
  it("uses the default local daemon without selectors", () => {
    expect(parseArguments([])).toEqual({ command: "run", target: { type: "default" } });
  });

  it("accepts home and host targets", () => {
    expect(parseArguments(["--home", "/tmp/paseo-home"])).toEqual({
      command: "run",
      target: { type: "home", path: "/tmp/paseo-home" },
    });
    expect(parseArguments(["--host", "devbox:6767"])).toEqual({
      command: "run",
      target: { type: "host", value: "devbox:6767" },
    });
  });

  it("recognizes help and version aliases", () => {
    expect(parseArguments(["-h"]).command).toBe("help");
    expect(parseArguments(["--version"]).command).toBe("version");
  });

  it("rejects conflicting selectors and missing values", () => {
    expect(() => parseArguments(["--home", "/tmp/a", "--host", "localhost:6767"])).toThrow(
      CliArgumentError,
    );
    expect(() => parseArguments(["--host"])).toThrow("--host requires a value");
  });

  it("rejects unknown options", () => {
    expect(() => parseArguments(["--ssh", "devbox"])).toThrow("Unknown option: --ssh");
  });
});
