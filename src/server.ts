import { timingSafeEqual } from "node:crypto";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { percentile } from "./eval/metrics.js";
import type { Pipeline } from "./pipeline.js";

export interface ServerDeps {
  pipeline: Pipeline;
  model: string;
  indexedParagraphs: number;
  spentUsd: () => number;
  apiKey?: string; // when set, /ask and /stats require this key in the x-api-key header
  siteDir?: string; // when set, the files in this folder (the demo page) are served at / after the API routes
}

const MAX_QUESTION_CHARS = 500;

// Constant-time comparison, so response time does not leak how much of a guess was right.
function sameKey(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp(deps: ServerDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "4kb" }));

  const stats = { requests: 0, errors: 0, refusals: 0, exactHits: 0, semanticHits: 0, modelCalls: 0, startedAt: Date.now() };
  const recentMs: number[] = []; // the last 500 request times, for percentiles

  // A server that spends money per request must not be open to anyone who finds its address.
  const auth: RequestHandler = (req, res, next) => {
    if (deps.apiKey && !sameKey(req.header("x-api-key"), deps.apiKey)) {
      res.status(401).json({ error: "missing or wrong x-api-key" });
      return;
    }
    next();
  };

  // No auth and no model call: this is what a load balancer or the ECS health check hits.
  app.get("/health", (_req, res) => {
    res.json({ ok: true, model: deps.model, indexedParagraphs: deps.indexedParagraphs });
  });

  app.post("/ask", auth, async (req, res) => {
    const question: unknown = req.body?.question;
    if (typeof question !== "string" || question.trim().length === 0 || question.length > MAX_QUESTION_CHARS) {
      res.status(400).json({ error: `body must be JSON like {"question": "..."} with 1-${MAX_QUESTION_CHARS} characters` });
      return;
    }
    stats.requests++;
    const started = performance.now();
    try {
      const r = await deps.pipeline(question);
      const ms = performance.now() - started;
      recentMs.push(ms);
      if (recentMs.length > 500) recentMs.shift();
      if (r.cacheLayer === "exact") stats.exactHits++;
      else if (r.cacheLayer === "semantic") stats.semanticHits++;
      else stats.modelCalls++;
      if (r.refused) stats.refusals++;
      res.json({ answer: r.answer, refused: r.refused ?? false, cacheLayer: r.cacheLayer, latencyMs: Math.round(ms), retrievedIds: r.retrievedIds, costUsd: r.costUsd ?? 0 });
    } catch (e) {
      stats.errors++;
      console.error("ask failed:", (e as Error).message); // details stay in the server log, not in the response
      res.status(502).json({ error: "the model call failed; try again" });
    }
  });

  app.get("/stats", auth, (_req, res) => {
    res.json({
      ...stats,
      uptimeSeconds: Math.round((Date.now() - stats.startedAt) / 1000),
      cacheHitRate: stats.requests ? (stats.exactHits + stats.semanticHits) / stats.requests : 0,
      latencyMs: recentMs.length ? { p50: Math.round(percentile(recentMs, 50)), p95: Math.round(percentile(recentMs, 95)), samples: recentMs.length } : null,
      spentUsd: Number(deps.spentUsd().toFixed(4)),
    });
  });

  // The demo page is public (static files, no model call). It comes after the API routes so they always win.
  if (deps.siteDir) app.use(express.static(deps.siteDir));

  // Bad JSON and oversized bodies come here and get a JSON answer instead of an HTML error page.
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? "internal error" : "bad request" });
  };
  app.use(onError);
  return app;
}
