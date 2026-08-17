/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import here. No central list.
 */
import './core.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
import { startMcpServer } from './server.js';
import { createLogger } from '../log.js';

const log = createLogger('mcp-tools');

startMcpServer().catch((err) => {
  log.error(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
