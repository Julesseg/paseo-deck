export class PaseoGatewayError extends Error {
  public readonly detail: string | undefined;

  public constructor(message: string, detail?: string) {
    super(message);
    this.name = "PaseoGatewayError";
    this.detail = detail;
  }
}

export class PaseoCliError extends PaseoGatewayError {
  public readonly exitCode: number | null;

  public constructor(message: string, exitCode: number | null, detail?: string) {
    super(message, detail);
    this.name = "PaseoCliError";
    this.exitCode = exitCode;
  }
}
