import {
  type Component,
  CURSOR_MARKER,
  decodeKittyPrintable,
  type Focusable,
  matchesKey,
  sliceByColumn,
} from "@earendil-works/pi-tui";
import { characterStep } from "./text-buffer.js";
import { sanitizeTerminalText, terminalDisplayWidth } from "./text-safety.js";

type Snapshot = { value: string; cursor: number };

/** Reviewed ordinary editing, with history owned by this field interaction. */
export class SingleLineField implements Component, Focusable {
  focused = false;
  onSubmit?: (value: string) => void;
  private value = "";
  private cursor = 0;
  private undo: Snapshot[] = [];
  private redo: Snapshot[] = [];
  constructor(private readonly options: { prompt?: string } = {}) {}
  getValue(): string {
    return this.value;
  }
  setValue(value: string): void {
    this.value = this.singleLine(value);
    this.cursor = Math.min(this.cursor, this.value.length);
    this.undo = [];
    this.redo = [];
  }
  invalidate(): void {}
  handleInput(data: string): void {
    if (data.startsWith("\u001b[200~") && data.endsWith("\u001b[201~")) {
      this.replace(this.cursor, this.cursor, this.singleLine(data.slice(6, -6)));
      return;
    }
    const key = (...keys: string[]) =>
      keys.some((name) => matchesKey(data, name as Parameters<typeof matchesKey>[1]));
    if (key("ctrl+shift+z")) {
      this.restore(this.redo, this.undo);
      return;
    }
    if (key("ctrl+z")) {
      this.restore(this.undo, this.redo);
      return;
    }
    if (data !== "\n" && key("enter")) {
      this.onSubmit?.(this.value);
      return;
    }
    if (key("left", "ctrl+b")) this.cursor = characterStep(this.value, this.cursor, -1);
    else if (key("right", "ctrl+f")) this.cursor = characterStep(this.value, this.cursor, 1);
    else if (key("alt+left", "ctrl+left", "alt+b")) this.cursor = this.word(-1);
    else if (key("alt+right", "ctrl+right", "alt+f")) this.cursor = this.word(1);
    else if (key("home", "ctrl+home", "ctrl+a")) this.cursor = 0;
    else if (key("end", "ctrl+end", "ctrl+e")) this.cursor = this.value.length;
    else if (key("backspace", "shift+backspace"))
      this.replace(characterStep(this.value, this.cursor, -1), this.cursor, "");
    else if (key("delete", "shift+delete"))
      this.replace(this.cursor, characterStep(this.value, this.cursor, 1), "");
    else if (key("ctrl+w", "alt+backspace")) this.replace(this.word(-1), this.cursor, "");
    else if (key("alt+d", "alt+delete")) this.replace(this.cursor, this.word(1), "");
    else {
      const printable = decodeKittyPrintable(data) ?? data;
      if (printable && !/[\p{Cc}\p{Cs}]/u.test(printable))
        this.replace(this.cursor, this.cursor, printable);
    }
  }
  render(width: number): string[] {
    const prompt = this.options.prompt ?? "> ";
    const available = Math.max(1, width - terminalDisplayWidth(prompt));
    const text = sanitizeTerminalText(this.value);
    const caret = terminalDisplayWidth(sanitizeTerminalText(this.value.slice(0, this.cursor)));
    const start = Math.max(0, caret - available + 1);
    const before = sliceByColumn(text, start, Math.max(0, caret - start), true);
    const after = sliceByColumn(
      text,
      caret,
      Math.max(1, available - terminalDisplayWidth(before)),
      true,
    );
    const next =
      [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(after)][0]?.segment ??
      " ";
    const rendered = `${before}${this.focused ? CURSOR_MARKER : ""}\u001b[7m${next}\u001b[27m${after.slice(next.length)}`;
    return [
      prompt +
        rendered +
        " ".repeat(Math.max(0, available - terminalDisplayWidth(before + (after || " ")))),
    ];
  }
  private singleLine(value: string): string {
    return value.replace(/\r\n|[\r\n\u2028\u2029]/g, " ");
  }
  private snapshot(): Snapshot {
    return { value: this.value, cursor: this.cursor };
  }
  private restore(from: Snapshot[], to: Snapshot[]): void {
    const state = from.pop();
    if (!state) return;
    to.push(this.snapshot());
    this.value = state.value;
    this.cursor = state.cursor;
  }
  private replace(start: number, end: number, text: string): void {
    const value = this.value.slice(0, start) + text + this.value.slice(end);
    if (value === this.value) return;
    this.undo.push(this.snapshot());
    this.redo = [];
    this.value = value;
    this.cursor = start + text.length;
  }
  private word(direction: -1 | 1): number {
    let at = this.cursor;
    const category = (char: string) => (/\s/u.test(char) ? 0 : /[\p{L}\p{N}_]/u.test(char) ? 1 : 2);
    const adjacent = () =>
      direction < 0
        ? this.value.slice(characterStep(this.value, at, -1), at)
        : this.value.slice(at, characterStep(this.value, at, 1));
    while (adjacent() && category(adjacent()) === 0) at = characterStep(this.value, at, direction);
    const kind = category(adjacent());
    while (adjacent() && category(adjacent()) === kind)
      at = characterStep(this.value, at, direction);
    return at;
  }
}

/** Legacy LF is Ctrl-J navigation; CR and distinguishable enhanced Enter confirm. */
export function choiceNavigation(data: string): -1 | 1 | undefined {
  if (matchesKey(data, "up") || matchesKey(data, "ctrl+k")) return -1;
  if (data === "\n" || matchesKey(data, "down") || matchesKey(data, "ctrl+j")) return 1;
  return undefined;
}
