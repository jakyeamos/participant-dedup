import { serve } from "@hono/node-server";
import { loadApiConfig } from "./config";
import { createApiApp } from "./app";
import { GoogleWorkbookBridge } from "./googleWorkbookBridge";
import { ScanJobRegistry } from "./scanJobs";

const config = loadApiConfig();
const bridge = new GoogleWorkbookBridge(config.googleServiceAccountJson);
const jobs = new ScanJobRegistry(bridge);
const app = createApiApp({ apiKey: config.apiKey, jobs });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`dedup api listening on :${info.port}`);
});
