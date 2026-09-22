import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildMcpServer, createHttpClient } from "./mcp.js";

const baseUrl = (process.env.BOTSUPPLY_BASE_URL ?? "https://botsupply.onrender.com").replace(/\/+$/, "");
const apiKey = process.env.BOTSUPPLY_API_KEY?.trim() || undefined;

const client = createHttpClient(baseUrl);

serveStdio(() => buildMcpServer(client, apiKey));
console.error(`botsupply MCP stdio calling ${baseUrl}`);
