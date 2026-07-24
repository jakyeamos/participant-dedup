import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ScanJobRegistry } from "./scanJobs";

export interface CreateApiAppOptions {
  apiKey: string;
  jobs: ScanJobRegistry;
}

function bearerOrHeaderKey(headerValue: string | undefined, apiKey: string): boolean {
  if (!headerValue) return false;
  if (headerValue === apiKey) return true;
  if (headerValue.startsWith("Bearer ") && headerValue.slice("Bearer ".length) === apiKey) {
    return true;
  }
  return false;
}

export function createApiApp(options: CreateApiAppOptions): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("/v1/*", async (c, next) => {
    const key = c.req.header("x-api-key") ?? c.req.header("authorization");
    if (!bearerOrHeaderKey(key, options.apiKey)) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    await next();
  });

  app.post("/v1/scans", async (c) => {
    const body = (await c.req.json()) as {
      spreadsheetId?: string;
      sheetName?: string;
      fallbackName?: string;
    };
    const spreadsheetId = (body.spreadsheetId ?? "").trim();
    const sheetName = (body.sheetName ?? "").trim();
    if (!spreadsheetId || !sheetName) {
      throw new HTTPException(400, { message: "spreadsheetId and sheetName are required" });
    }
    const result = await options.jobs.start({
      spreadsheetId,
      sheetName,
      fallbackName: body.fallbackName,
    });
    return c.json(result, 200);
  });

  app.get("/v1/scans/:batchId", async (c) => {
    const batchId = c.req.param("batchId");
    const spreadsheetId = (c.req.query("spreadsheetId") ?? "").trim();
    if (!spreadsheetId) {
      throw new HTTPException(400, { message: "spreadsheetId query param is required" });
    }
    try {
      const result = await options.jobs.get({
        spreadsheetId,
        batchId,
        fallbackName: c.req.query("fallbackName") ?? undefined,
      });
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "Batch not found") throw new HTTPException(404, { message });
      throw error;
    }
  });

  app.post("/v1/scans/:batchId/cancel", async (c) => {
    const batchId = c.req.param("batchId");
    const body = (await c.req.json().catch(() => ({}))) as {
      spreadsheetId?: string;
      fallbackName?: string;
    };
    const spreadsheetId = (body.spreadsheetId ?? "").trim();
    if (!spreadsheetId) {
      throw new HTTPException(400, { message: "spreadsheetId is required" });
    }
    const result = await options.jobs.cancel({
      spreadsheetId,
      batchId,
      fallbackName: body.fallbackName,
    });
    return c.json(result);
  });

  return app;
}
