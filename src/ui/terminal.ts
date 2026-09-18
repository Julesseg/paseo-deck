import type { Terminal, TUI } from "@earendil-works/pi-tui";
import xterm, { type Terminal as XtermTerminal } from "@xterm/headless";

/** A narrow lifecycle owner so every exit path restores the user's terminal. */
export class TerminalLifecycle {
  private stopped = false;

  constructor(
    private readonly tui: TUI,
    private readonly terminal: Terminal,
  ) {}

  start(): void {
    this.tui.start();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      await this.terminal.drainInput();
    } finally {
      this.tui.stop();
    }
  }
}

/** Deterministic Terminal seam for controller and restoration tests. */
export class RecordingTerminal implements Terminal {
  readonly writes: string[] = [];
  columns: number;
  rows: number;
  kittyProtocolActive = false;
  started = false;
  stopped = false;
  private input: ((data: string) => void) | undefined;
  private resize: (() => void) | undefined;
  private readonly xterm: XtermTerminal;

  constructor(columns = 100, rows = 30) {
    this.columns = columns;
    this.rows = rows;
    this.xterm = new xterm.Terminal({
      cols: columns,
      rows,
      disableStdin: true,
      allowProposedApi: true,
    });
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.started = true;
    this.input = onInput;
    this.resize = onResize;
  }
  stop(): void {
    this.stopped = true;
    this.input = undefined;
    this.resize = undefined;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
    this.xterm.write(data);
  }
  moveBy(_lines: number): void {}
  hideCursor(): void {
    this.writes.push("hide-cursor");
  }
  showCursor(): void {
    this.writes.push("show-cursor");
  }
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  sendInput(data: string): void {
    this.input?.(data);
  }
  setSize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.xterm.resize(columns, rows);
    this.resize?.();
  }
  async flush(): Promise<void> {
    await new Promise<void>((resolve) => this.xterm.write("", resolve));
  }
  async waitForRender(): Promise<void> {
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await this.flush();
  }
  viewport(): string[] {
    const buffer = this.xterm.buffer.active;
    return Array.from(
      { length: this.xterm.rows },
      (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? "",
    );
  }
}
