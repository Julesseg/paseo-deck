import type { PaseoFailureKind } from "../contracts/app-state.js";

export type { PaseoFailureKind } from "../contracts/app-state.js";

/** A safe, actionable failure which may cross from the Paseo adapter into the UI. */
export class PaseoGatewayError extends Error {
  public readonly detail: string | undefined;
  public readonly kind: PaseoFailureKind;

  public constructor(message: string, detail?: string, kind: PaseoFailureKind = "protocol") {
    super(redactTransportDetail(message));
    this.name = "PaseoGatewayError";
    this.detail = detail === undefined ? undefined : redactTransportDetail(detail);
    this.kind = kind;
  }
}

export class PaseoCliError extends PaseoGatewayError {
  public readonly exitCode: number | null;

  public constructor(message: string, exitCode: number | null, detail?: string) {
    super(message, detail, "command");
    this.name = "PaseoCliError";
    this.exitCode = exitCode;
  }
}

/**
 * Classify arbitrary SDK and subprocess failures at the adapter seam. The UI
 * only receives this closed taxonomy and a redacted detail, never raw socket
 * errors, authorization headers, or password-bearing URLs.
 */
export function paseoFailure(error: unknown, fallback: PaseoFailureKind): PaseoGatewayError {
  if (error instanceof PaseoGatewayError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  const normalized = detail.toLowerCase();
  const kind: PaseoFailureKind = /auth|unauthori[sz]ed|forbidden|password|credential/.test(
    normalized,
  )
    ? "authentication"
    : /econnrefused|enotfound|ehostunreach|network|socket|offline|connect/.test(normalized)
      ? "daemon-unavailable"
      : fallback;
  return new PaseoGatewayError(
    `${failureMessage(kind)} ${redactTransportDetail(detail)}`,
    detail,
    kind,
  );
}

export function redactTransportDetail(detail: string): string {
  return detail
    .replace(/(password|token|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/(wss?|https?):\/\/([^\s/@:]+):([^\s/@]+)@/gi, "$1://[redacted]@")
    .replace(/([?&](?:password|token|access_token)=)[^&\s]+/gi, "$1[redacted]");
}

function failureMessage(kind: PaseoFailureKind): string {
  switch (kind) {
    case "daemon-unavailable":
      return "Paseo daemon is unavailable.";
    case "authentication":
      return "Paseo authentication failed.";
    case "subscription":
      return "A Paseo observation failed.";
    case "command":
      return "The Paseo command failed.";
    case "protocol":
      return "Paseo returned an unexpected response.";
  }
}
