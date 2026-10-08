import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Pipeline, PipelineResult } from "../src/pipeline.js";
import { createApp } from "../src/server.js";

const result = (o: Partial<PipelineResult> = {}): PipelineResult => ({
  answer: "Denver Broncos", retrievedIds: ["0-0"], embedMs: 1, searchMs: 1, ttftMs: 5, llmMs: 5, totalMs: 7,
  usage: { promptTokens: 10, completionTokens: 3 }, cacheHit: false, cacheLayer: null, costUsd: 0.003, ...o,
});

let close: (() => void) | undefined;
afterEach(() => close?.());
async function start(pipeline: Pipeline, apiKey?: string, siteDir?: string) {
  const app = createApp({ pipeline, model: "fake-model", indexedParagraphs: 500, spentUsd: () => 0.0123, apiKey, siteDir });
  const server = app.listen(0);
  close = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/ask`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { base, post };
}

describe("gateway server", () => {
  it("answers a question and reports which layer served it", async () => {
    const { post } = await start(async () => result({ cacheHit: true, cacheLayer: "exact", costUsd: 0 }));
    const res = await post({ question: "Who won?" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ answer: "Denver Broncos", cacheLayer: "exact", refused: false, costUsd: 0 });
  });
  it("has a health check that needs no key and makes no model call", async () => {
    let calls = 0;
    const { base } = await start(async () => { calls++; return result(); }, "secret");
    const res = await fetch(`${base}/health`);
    expect(await res.json()).toEqual({ ok: true, model: "fake-model", indexedParagraphs: 500 });
    expect(calls).toBe(0);
  });
  it("rejects bad input with a JSON error", async () => {
    const { post } = await start(async () => result());
    expect((await post({})).status).toBe(400);
    expect((await post({ question: "" })).status).toBe(400);
    expect((await post({ question: "x".repeat(501) })).status).toBe(400);
    const bad = await post("{not json");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "bad request" });
  });
  it("requires the API key when one is configured, and not otherwise", async () => {
    const locked = await start(async () => result(), "secret");
    expect((await locked.post({ question: "q" })).status).toBe(401);
    expect((await locked.post({ question: "q" }, { "x-api-key": "wrong!" })).status).toBe(401);
    expect((await locked.post({ question: "q" }, { "x-api-key": "secret" })).status).toBe(200);
    expect((await fetch(`${locked.base}/stats`)).status).toBe(401);
    close?.();
    const open = await start(async () => result());
    expect((await open.post({ question: "q" })).status).toBe(200);
  });
  it("hides model errors from the caller and counts them", async () => {
    const { post, base } = await start(async () => { throw new Error("secret upstream detail FAKE-TOKEN-123"); });
    const res = await post({ question: "q" });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("FAKE-TOKEN");
    expect(text).not.toContain("upstream detail");
    expect((await (await fetch(`${base}/stats`)).json()).errors).toBe(1);
  });
  it("keeps running statistics", async () => {
    let n = 0;
    const { post, base } = await start(async () => (n++ === 0 ? result() : result({ cacheHit: true, cacheLayer: "semantic", costUsd: 0 })));
    await post({ question: "a" }); await post({ question: "b" }); await post({ question: "c" });
    const s = await (await fetch(`${base}/stats`)).json();
    expect(s).toMatchObject({ requests: 3, modelCalls: 1, semanticHits: 2, exactHits: 0, spentUsd: 0.0123 });
    expect(s.cacheHitRate).toBeCloseTo(2 / 3);
    expect(s.latencyMs.samples).toBe(3);
  });
  it("serves the demo page at / without a key, and the API routes still win", async () => {
    const dir = mkdtempSync(join(tmpdir(), "site-"));
    writeFileSync(join(dir, "index.html"), "<h1>demo</h1>");
    writeFileSync(join(dir, "health"), "a file that must not shadow the route");
    const { base, post } = await start(async () => result(), "secret", dir);
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("demo");
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true });
    expect((await post({ question: "q" })).status).toBe(401);
    expect((await fetch(`${base}/stats`)).status).toBe(401);
  });
  it("serves no pages when no site folder is given", async () => {
    const { base } = await start(async () => result());
    expect((await fetch(`${base}/`)).status).toBe(404);
  });
});
