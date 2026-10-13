import { expect, it } from "vitest";
import { SingleLineField } from "./single-line-field.js";

it.each(["\u001b[D", "\u0002"])("moves a grapheme left with %j", (key) => {
  const field = new SingleLineField();
  field.handleInput("A👩🏽‍💻B");
  field.handleInput("\u0005");
  field.handleInput(key);
  field.handleInput("!");
  expect(field.getValue()).toBe("A👩🏽‍💻!B");
});

it.each(["\u001b[1;3D", "\u001b[1;5D", "\u001bb"])("moves one word left with %j", (key) => {
  const field = new SingleLineField();
  field.handleInput("one two");
  field.handleInput(key);
  field.handleInput("!");
  expect(field.getValue()).toBe("one !two");
});

it.each(["\u001b[1;3C", "\u001b[1;5C", "\u001bf"])("moves one word right with %j", (key) => {
  const field = new SingleLineField();
  field.handleInput("one two");
  field.handleInput("\u0001");
  field.handleInput(key);
  field.handleInput("!");
  expect(field.getValue()).toBe("one! two");
});

it.each(["\u0017", "\u001b\u007f"])("deletes previous word with %j", (key) => {
  const field = new SingleLineField();
  field.handleInput("one two");
  field.handleInput(key);
  expect(field.getValue()).toBe("one ");
});

it.each(["\u001bd", "\u001b[3;3~"])("deletes next word with %j", (key) => {
  const field = new SingleLineField();
  field.handleInput("one two");
  field.handleInput("\u0001");
  field.handleInput(key);
  expect(field.getValue()).toBe(" two");
});

it.each([
  "\u0019",
  "\u001by",
  "\u001b[93;5u",
  "\u001b[1;5A",
  "\u001b[5;5~",
  "\t",
  "\u001b[Z",
  "\u001f",
])("unreviewed editing key %j has no effect", (key) => {
  const field = new SingleLineField();
  field.handleInput("one two");
  field.handleInput(key);
  expect(field.getValue()).toBe("one two");
});

it("preserves literal paste, isolates history after initialization and discards redo on a fresh edit", () => {
  const field = new SingleLineField();
  field.setValue("name");
  field.handleInput("\u001b[200~\r\n\n\r\u001b[201~");
  expect(field.getValue()).toBe("   name");
  field.handleInput("\u001a");
  expect(field.getValue()).toBe("name");
  field.handleInput("\u001b[122;6u");
  expect(field.getValue()).toBe("   name");
  field.handleInput("\u001a");
  field.handleInput("x");
  field.handleInput("\u001b[122;6u");
  expect(field.getValue()).toBe("xname");
});
