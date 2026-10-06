import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("loads the base config with every cache on", () => {
    const c = loadConfig("configs/base.yaml");
    expect(c.caches.exact.enabled).toBe(true);
    expect(c.caches.semantic.enabled).toBe(true);
  });

  it("applies an ablation override without touching other fields", () => {
    const c = loadConfig("configs/base.yaml", "configs/ablations/all_off.yaml");
    expect(c.caches.exact.enabled).toBe(false);
    expect(c.caches.semantic.enabled).toBe(false);
    expect(c.caches.semantic.threshold).toBe(0.9); // kept from base
    expect(c.seed).toBe(42);
  });
});
