import { describe, expect, it } from "vitest";
import { PaseoGatewayError, paseoFailure, redactTransportDetail } from "./errors.js";

describe("Paseo failures", () => {
  it.each([
    ["ECONNREFUSED 127.0.0.1", "daemon-unavailable"],
    ["Unauthorized: password rejected", "authentication"],
    ["invalid wire payload", "protocol"],
  ] as const)("classifies %s as %s", (detail, kind) => {
    expect(paseoFailure(new Error(detail), "protocol").kind).toBe(kind);
  });

  it.each([
    ["daemon-unavailable", new Error("ECONNREFUSED"), "daemon-unavailable"],
    ["authentication", new Error("Unauthorized password"), "command"],
    ["protocol", new Error("unexpected response"), "protocol"],
    ["subscription", new Error("listener stopped"), "subscription"],
    ["command", new Error("request rejected"), "command"],
  ] as const)("keeps the %s category visible at the adapter seam", (_name, error, fallback) => {
    expect(paseoFailure(error, fallback).kind).toBe(_name);
  });

  it("preserves a closed adapter failure and redacts its detail", () => {
    const failure = new PaseoGatewayError(
      "failed",
      "Authorization: secret-token https://user:pass@example.test/ws?token=abc",
      "subscription",
    );
    expect(paseoFailure(failure, "command")).toBe(failure);
    expect(failure.detail).toContain("[redacted]");
    expect(failure.detail).not.toContain("secret-token");
    expect(failure.detail).not.toContain("pass");
  });

  it("redacts credential-like transport fragments", () => {
    expect(redactTransportDetail("password=hunter2; access_token=abc")).toBe(
      "password=[redacted]; access_token=[redacted]",
    );
  });
});
