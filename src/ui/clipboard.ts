import { spawn } from "node:child_process";
export type ClipboardKind = "character" | "line";
export interface ClipboardAdapter {
  read(): string | Promise<string>;
  write(text: string): void | Promise<void>;
}
/** The clipboard is the source of truth. Ownership is discarded after an external change. */
export class SharedClipboard {
  private owned: { text: string; kind: ClipboardKind } | undefined;
  constructor(private readonly adapter: ClipboardAdapter) {}
  async write(text: string, kind: ClipboardKind = "character"): Promise<void> {
    await this.adapter.write(text);
    this.owned = { text, kind };
  }
  async read(): Promise<{ text: string; kind: ClipboardKind }> {
    const text = await this.adapter.read();
    if (this.owned?.text !== text) this.owned = undefined;
    return { text, kind: this.owned?.kind ?? "character" };
  }
}
function clipboardProcess(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`Clipboard command failed (${code}).`)),
    );
    child.stdin.end(input);
  });
}
/** Native commands provide acknowledged reads/writes; OSC52 cannot confirm write success. */
export const systemClipboard: ClipboardAdapter = {
  read: () =>
    process.platform === "darwin"
      ? clipboardProcess("pbpaste", [])
      : process.platform === "win32"
        ? clipboardProcess("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"])
        : process.env.WAYLAND_DISPLAY
          ? clipboardProcess("wl-paste", ["--no-newline"])
          : clipboardProcess("xclip", ["-selection", "clipboard", "-o"]),
  write: (text) =>
    (process.platform === "darwin"
      ? clipboardProcess("pbcopy", [], text)
      : process.platform === "win32"
        ? clipboardProcess("powershell", ["-NoProfile", "-Command", "$input | Set-Clipboard"], text)
        : process.env.WAYLAND_DISPLAY
          ? clipboardProcess("wl-copy", [], text)
          : clipboardProcess("xclip", ["-selection", "clipboard"], text)
    ).then(() => undefined),
};
