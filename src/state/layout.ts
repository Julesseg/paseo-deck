export interface LayoutDecision {
  showTree: boolean;
  showTimeline: boolean;
  showComposer: boolean;
  showSecondaryDetails: boolean;
  compactTree: boolean;
}

/** Preserve the three task-critical panes as terminal width declines. */
export function narrowLayout(columns: number): LayoutDecision {
  return {
    showTree: true,
    showTimeline: true,
    showComposer: true,
    showSecondaryDetails: columns >= 100,
    compactTree: columns < 90,
  };
}
