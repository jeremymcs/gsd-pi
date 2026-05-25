#!/usr/bin/env node
import { listenGateway } from "./server.js";

const portArg = process.argv.indexOf("--port");
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : undefined;

listenGateway({ port }).then(({ url }) => {
  process.stderr.write(`[gsd-cloud-mcp-gateway] listening on ${url}\n`);
}).catch((err) => {
  process.stderr.write(`[gsd-cloud-mcp-gateway] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
