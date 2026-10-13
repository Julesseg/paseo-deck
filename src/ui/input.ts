import {
  isKeyRelease,
  matchesKey,
  parseOsc11BackgroundColor,
  type Terminal,
} from "@earendil-works/pi-tui";

// Only exact Ctrl-letter chords collapse to their legacy bytes. Shift/Alt chords
// (including distinct Ctrl-Shift-Z redo) retain their enhanced identity.
const deckControlKeys = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
] as const;
function normalizeDeckKey(data: string): string {
  for (const key of deckControlKeys)
    if (matchesKey(data, `ctrl+${key}`)) return String.fromCharCode(key.charCodeAt(0) - 96);
  return matchesKey(data, "enter") ? "\r" : data;
}

/** Frame escape sequences and paste before any Deck or inherited handler sees input. */
export function ownedInputTerminal(
  terminal: Terminal,
  direct: () => boolean = () => false,
  owns: (data: string) => boolean = () => false,
): Terminal {
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let replyTimer: ReturnType<typeof setTimeout> | undefined;
  let reply = "";
  let replyChunks: string[] = [];
  let pasteActive = false;
  let pasteTail = "";
  return new Proxy(terminal, {
    get(target, property) {
      if (property === "stop")
        return () => {
          clearTimeout(timer);
          clearTimeout(replyTimer);
          pending = "";
          reply = "";
          replyChunks = [];
          pasteActive = false;
          pasteTail = "";
          target.stop();
        };
      if (property === "start")
        return (inheritedInput: (data: string) => void, resize: () => void) => {
          const input = (data: string) => {
            if (!owns(data)) inheritedInput(data);
          };
          const drain = () => {
            while (pending) {
              if (pending.startsWith("\u001b[200~")) {
                const end = pending.indexOf("\u001b[201~", 6);
                if (end < 0) return;
                input(pending.slice(0, end + 6));
                pending = pending.slice(end + 6);
              } else if (pending.startsWith("\u001b[")) {
                const body = pending.slice(1).match(/^\[[0-?]*[ -/]*[@-~]/)?.[0];
                const sequence = body ? `\u001b${body}` : undefined;
                if (!sequence) {
                  if (/[\r\n]/.test(pending)) pending = "";
                  return;
                }
                pending = pending.slice(sequence.length);
                if (!isKeyRelease(sequence)) input(normalizeDeckKey(sequence));
              } else if (pending === "\u001b") {
                timer = setTimeout(() => {
                  pending = "";
                  input("\u001b");
                }, 10);
                return;
              } else if (pending.startsWith("\u001b\r") || pending.startsWith("\u001b\n")) {
                pending = pending.slice(2);
                input("\u001b\r");
              } else if (pending.startsWith("\u001b")) {
                const sequence = pending.slice(0, 2);
                pending = pending.slice(2);
                input(sequence);
              } else {
                const escapeIndex = pending.indexOf("\u001b");
                const text = escapeIndex < 0 ? pending : pending.slice(0, escapeIndex);
                pending = escapeIndex < 0 ? "" : pending.slice(escapeIndex);
                // Native multiline delivery is a payload, never a sequence of commands.
                input(text.length > 1 ? `\u001b[200~${text}\u001b[201~` : text);
              }
            }
          };
          const deliver = (data: string) => {
            const stream = pasteTail + data;
            // biome-ignore lint/suspicious/noControlCharactersInRegex: bracketed paste uses ESC protocol markers.
            const markers = stream.matchAll(/\u001b\[20([01])~/g);
            for (const marker of markers) pasteActive = marker[1] === "0";
            pasteTail = stream.slice(-5);
            if (direct()) {
              input(data);
              return;
            }
            if (!pending && !data.startsWith("\u001b") && data.length > 1) {
              input(`\u001b[200~${data}\u001b[201~`);
              return;
            }
            clearTimeout(timer);
            pending += data;
            drain();
          };
          const clearReply = () => {
            clearTimeout(replyTimer);
            replyTimer = undefined;
            reply = "";
            replyChunks = [];
          };
          const flushReply = () => {
            const chunks = replyChunks;
            clearReply();
            // An incomplete/invalid candidate must not trap later program or editor input.
            if (chunks.length === 1 && chunks[0] === "\u001b") input("\u001b");
            else for (const chunk of chunks) deliver(chunk);
          };
          const receive = (data: string) => {
            const prefix = "\u001b]11;";
            if (!reply && (pasteActive || (!prefix.startsWith(data) && !data.startsWith(prefix)))) {
              deliver(data);
              return;
            }
            reply += data;
            replyChunks.push(data);
            if (!prefix.startsWith(reply) && !reply.startsWith(prefix)) {
              flushReply();
              return;
            }
            // Escape alone retains ordinary key framing; recognized OSC gets a finite deadline.
            if (reply === "\u001b") replyTimer = setTimeout(flushReply, 10);
            else if (
              replyChunks.length === 1 ||
              (replyChunks[0] === "\u001b" && replyChunks.length === 2)
            ) {
              clearTimeout(replyTimer);
              replyTimer = setTimeout(flushReply, 120);
            }
            if (reply.length > 4096) {
              flushReply();
              return;
            }
            const bell = reply.indexOf("\u0007", prefix.length);
            const st = reply.indexOf("\u001b\\", prefix.length);
            const endIndex = bell < 0 ? st : st < 0 ? bell : Math.min(bell, st);
            if (endIndex < 0) return;
            const end = endIndex + (endIndex === bell ? 1 : 2);
            const response = reply.slice(0, end);
            if (!parseOsc11BackgroundColor(response)) {
              flushReply();
              return;
            }
            const remainder = reply.slice(end);
            clearReply();
            // Protocol replies go directly to pi-tui's pending query, before Deck ownership.
            inheritedInput(response);
            if (remainder) receive(remainder);
          };
          target.start(receive, resize);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
