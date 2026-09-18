import { describe, expect, it } from "vitest";
import { PaseoGatewayError } from "./errors.js";
import { targetFromDaemonStatus, websocketUrlForTcpTarget } from "./target.js";

describe("Paseo target resolution", () => {
  it("maps a daemon listen address to a websocket endpoint and keeps home for CLI fallback", () => {
    expect(targetFromDaemonStatus({ home: "/tmp/paseo" }, { listen: "127.0.0.1:6767" })).toEqual({
      websocketUrl: "ws://127.0.0.1:6767/ws",
      cliArguments: ["--home", "/tmp/paseo"],
      originalTarget: "/tmp/paseo",
    });
  });

  it("uses direct TCP hosts without a local status call", () => {
    expect(targetFromDaemonStatus({ host: "tcp://deck.example:7000" }, {})).toMatchObject({
      websocketUrl: "ws://deck.example:7000/ws",
      cliArguments: ["--host", "tcp://deck.example:7000"],
    });
  });

  it.each(["ssh://me@example", "https://app.paseo.sh/#offer=secret", "example.test"])(
    "rejects unsupported v0.1 targets: %s",
    (target) => {
      expect(() => websocketUrlForTcpTarget(target)).toThrow(PaseoGatewayError);
    },
  );
});
