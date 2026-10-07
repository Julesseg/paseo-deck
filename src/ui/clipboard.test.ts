import { expect, it } from "vitest";
import { SharedClipboard } from "./clipboard.js";

it("retains linewise ownership only while current clipboard matches a successful write", async () => {
  let value = "external\ntext";
  let fail = false;
  const clipboard = new SharedClipboard({
    read: () => value,
    write: (text) => {
      if (fail) throw Error("denied");
      value = text;
    },
  });
  expect(await clipboard.read()).toEqual({ text: value, kind: "character" });
  await clipboard.write("one\n", "line");
  expect(await clipboard.read()).toEqual({ text: "one\n", kind: "line" });
  fail = true;
  await expect(clipboard.write("two\n", "line")).rejects.toThrow("denied");
  expect(await clipboard.read()).toEqual({ text: "one\n", kind: "line" });
  value = "other\n";
  expect(await clipboard.read()).toEqual({ text: "other\n", kind: "character" });
  value = "one\n";
  expect(await clipboard.read()).toEqual({ text: "one\n", kind: "character" });
});
