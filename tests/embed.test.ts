import { describe, expect, test } from "bun:test";
import { lru } from "../src/embed/cache.ts";

describe("lru", () => {
  test("basic get/set", () => {
    const c = lru<string, number>(3);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.get("a")).toBe(1);
    expect(c.get("b")).toBe(2);
    expect(c.size()).toBe(2);
  });
  test("evicts oldest beyond max", () => {
    const c = lru<string, number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
    expect(c.get("c")).toBe(3);
  });
  test("get refreshes recency", () => {
    const c = lru<string, number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a");
    c.set("c", 3);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
  });
  test("clear works", () => {
    const c = lru<string, number>(3);
    c.set("a", 1);
    c.clear();
    expect(c.size()).toBe(0);
  });
});
