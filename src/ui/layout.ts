export const MIN_TERMINAL_COLUMNS = 30;
export const MIN_TERMINAL_ROWS = 12;
export const MIN_TREE_WIDTH = 18;
export const MAX_TREE_WIDTH = 48;
export const NARROW_SIDEBAR_BREAKPOINT = 70;
export const NARROW_SIDEBAR_WIDTH = "90%";

export interface ShellLayout {
  supported: boolean;
  treeWidth: number;
  narrow: boolean;
}

/** Decides shell geometry without depending on terminal or application state. */
export function shellLayout(
  columns: number,
  rows: number,
  requestedTreeWidth: number,
): ShellLayout {
  return {
    supported: columns >= MIN_TERMINAL_COLUMNS && rows >= MIN_TERMINAL_ROWS,
    treeWidth: adjustTreeWidth(requestedTreeWidth, 0),
    narrow: columns < NARROW_SIDEBAR_BREAKPOINT,
  };
}

export function adjustTreeWidth(width: number, delta: number): number {
  return Math.max(MIN_TREE_WIDTH, Math.min(MAX_TREE_WIDTH, width + delta));
}

export const READING_COLUMN_WIDTH = 144;

/** Equal gutters inside the Main pane, including when Sidebar becomes a drawer. */
export function readingColumnLayout(mainWidth: number): {
  left: number;
  width: number;
  right: number;
} {
  const available = Math.max(1, Math.floor(mainWidth));
  const width = Math.min(READING_COLUMN_WIDTH, Math.max(1, available - 2));
  const left = Math.floor((available - width) / 2);
  return { left, width, right: available - width - left };
}
