import { isKeyRelease, matchesKey, type Terminal } from "@earendil-works/pi-tui";

/** Frame escape sequences and paste before any Deck or inherited handler sees input. */
export function ownedInputTerminal(
  terminal: Terminal,
  direct: () => boolean = () => false,
): Terminal {
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Proxy(terminal, {
    get(target, property) {
      if (property === "stop")
        return () => {
          clearTimeout(timer);
          pending = "";
          target.stop();
        };
      if (property === "start")
        return (input: (data: string) => void, resize: () => void) => {
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
                if (!isKeyRelease(sequence)) input(matchesKey(sequence, "enter") ? "\r" : sequence);
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
          target.start((data) => {
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
          }, resize);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
