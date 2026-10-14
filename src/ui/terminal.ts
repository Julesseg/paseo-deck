import type { Terminal, TUI } from "@earendil-works/pi-tui";
import unicode11 from "@xterm/addon-unicode11";
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
    const unicode = new unicode11.Unicode11Addon();
    // The official addon shares the headless Unicode API but types its browser terminal.
    unicode.activate(this.xterm as unknown as Parameters<typeof unicode.activate>[0]);
    this.xterm.unicode.activeVersion = "11";
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
  viewportCells(): Array<Array<{ text: string; width: number }>> {
    const buffer = this.xterm.buffer.active;
    return Array.from({ length: this.xterm.rows }, (_, row) => {
      const line = buffer.getLine(buffer.viewportY + row);
      return Array.from({ length: this.xterm.cols }, (_, column) => {
        const cell = line?.getCell(column);
        return { text: cell?.getChars() ?? "", width: cell?.getWidth() ?? 1 };
      });
    });
  }
  viewportCursor(): { row: number; column: number } {
    const buffer = this.xterm.buffer.active;
    return { row: buffer.cursorY + buffer.baseY - buffer.viewportY, column: buffer.cursorX };
  }
  /** Captures truecolor backgrounds from xterm cells for visual reports. */
  viewportBackgrounds(): Array<Array<string | undefined>> {
    return this.viewportColors("background");
  }
  viewportForegrounds(): Array<Array<string | undefined>> {
    return this.viewportColors("foreground");
  }
  private viewportColors(layer: "foreground" | "background"): Array<Array<string | undefined>> {
    const buffer = this.xterm.buffer.active;
    return Array.from({ length: this.xterm.rows }, (_, row) => {
      const line = buffer.getLine(buffer.viewportY + row);
      return Array.from({ length: this.xterm.cols }, (_, column) => {
        const cell = line?.getCell(column);
        if (!(layer === "foreground" ? cell?.isFgRGB() : cell?.isBgRGB())) return undefined;
        const color = layer === "foreground" ? cell?.getFgColor() : cell?.getBgColor();
        return `#${(color ?? 0).toString(16).padStart(6, "0")}`;
      });
    });
  }
  /** Captures reverse-video cells, including pi-tui's fake text cursor. */
  viewportInverseCells(): boolean[][] {
    const buffer = this.xterm.buffer.active;
    return Array.from({ length: this.xterm.rows }, (_, row) => {
      const line = buffer.getLine(buffer.viewportY + row);
      return Array.from({ length: this.xterm.cols }, (_, column) =>
        Boolean(line?.getCell(column)?.isInverse()),
      );
    });
  }
  /** Captures underline cells so visual reports can retain native selection fallback. */
  viewportUnderlineCells(): boolean[][] {
    const buffer = this.xterm.buffer.active;
    return Array.from({ length: this.xterm.rows }, (_, row) => {
      const line = buffer.getLine(buffer.viewportY + row);
      return Array.from({ length: this.xterm.cols }, (_, column) =>
        Boolean(line?.getCell(column)?.isUnderline()),
      );
    });
  }
}
