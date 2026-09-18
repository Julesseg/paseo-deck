import type { TimelineEvent, TimelineItem } from "../contracts/domain.js";

export interface TimelineSearchEntry {
  id: string;
  event: TimelineEvent;
  text: string;
}

export function timelineSearchEntries(
  events: readonly TimelineEvent[],
): readonly TimelineSearchEntry[] {
  return events.map((event) => ({
    id: `${event.epoch}:${event.sequence}`,
    event,
    text: searchableText(event.item),
  }));
}

export function findTimelineMatches(
  events: readonly TimelineEvent[],
  query: string,
): readonly TimelineSearchEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle
    ? timelineSearchEntries(events).filter((entry) =>
        entry.text.toLocaleLowerCase().includes(needle),
      )
    : [];
}

export function searchableText(item: TimelineItem): string {
  switch (item.type) {
    case "user-message":
    case "assistant-message":
    case "reasoning":
      return item.text;
    case "tool":
      return [item.name, item.summary, item.output, item.failureSummary].filter(Boolean).join("\n");
    case "error":
      return [item.message, item.detail].filter(Boolean).join("\n");
    case "permission":
      return item.request.title;
    case "turn":
      return [item.status, item.detail].filter(Boolean).join("\n");
    case "unknown":
      return [item.sourceType, item.summary].join("\n");
  }
}

export function copyTargets(item: TimelineItem): readonly { label: string; text: string }[] {
  switch (item.type) {
    case "user-message":
    case "assistant-message":
    case "reasoning":
      return [{ label: "message", text: item.text }, ...fencedCodeTargets(item.text)];
    case "tool":
      return item.output
        ? [{ label: "tool output", text: item.output }]
        : item.summary
          ? [{ label: "tool summary", text: item.summary }]
          : [];
    case "error":
      return [{ label: "error", text: item.detail ?? item.message }];
    default:
      return [];
  }
}

function fencedCodeTargets(text: string): readonly { label: string; text: string }[] {
  return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match, index) => ({
    label: `code ${index + 1}`,
    text: match[1] ?? "",
  }));
}

/** Removes terminal controls without changing source whitespace. */
export function clipboardPlainText(value: string): string {
  const esc = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === esc && value[index + 1] === "]") {
      const bellIndex = value.indexOf(bell, index + 2);
      const stIndex = value.indexOf(`${esc}\\`, index + 2);
      const end = [bellIndex, stIndex]
        .filter((candidate) => candidate >= 0)
        .sort((a, b) => a - b)[0];
      if (end !== undefined) {
        index = end + (value[end] === bell ? 0 : 1);
        continue;
      }
    }
    if (value[index] === esc && value[index + 1] === "[") {
      index += 2;
      while (index < value.length && !/[\x40-\x7e]/.test(value[index] ?? "")) index += 1;
      continue;
    }
    const code = value.charCodeAt(index);
    if (
      value[index] === "\t" ||
      value[index] === "\n" ||
      (code >= 32 && code !== 127 && !(code >= 128 && code <= 159))
    )
      result += value[index];
  }
  return result;
}
