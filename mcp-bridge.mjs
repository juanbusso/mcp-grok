#!/usr/bin/env node
/**
 * MCP Bridge for Grok Agent & Antigravity
 * Allows Grok to discover and invoke any MCP tool installed in Antigravity.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { MCP_CONFIG_PATH as CONFIG_PATH, MCP_SCHEMAS_DIR as SCHEMAS_DIR } from './config.mjs';

export function getMcpConfig() {
  if (!existsSync(CONFIG_PATH)) return { mcpServers: {} };
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error(`[mcp-bridge] Failed to read ${CONFIG_PATH}: ${err.message}`);
    return { mcpServers: {} };
  }
}

export function listMcpServers() {
  const cfg = getMcpConfig();
  const servers = {};
  for (const [name, serverCfg] of Object.entries(cfg.mcpServers || {})) {
    if (name === 'grok') continue; // Avoid circular invocation
    let toolCount = 0;
    let sampleTools = [];
    const serverSchemaDir = path.join(SCHEMAS_DIR, name);
    if (existsSync(serverSchemaDir)) {
      const files = readdirSync(serverSchemaDir).filter((f) => f.endsWith('.json'));
      toolCount = files.length;
      sampleTools = files.slice(0, 5).map((f) => f.replace('.json', ''));
    }
    servers[name] = {
      command: serverCfg.command,
      toolCount,
      sampleTools,
      status: 'configured',
    };
  }
  return servers;
}

export function listMcpTools(serverName) {
  const serverSchemaDir = path.join(SCHEMAS_DIR, serverName);
  if (!existsSync(serverSchemaDir)) {
    return { error: `Server '${serverName}' not found in schemas at ${serverSchemaDir}` };
  }
  const files = readdirSync(serverSchemaDir).filter((f) => f.endsWith('.json'));
  const tools = [];
  for (const file of files) {
    try {
      const toolSchema = JSON.parse(readFileSync(path.join(serverSchemaDir, file), 'utf8'));
      tools.push({
        name: toolSchema.name || file.replace('.json', ''),
        description: toolSchema.description || '',
        inputSchema: toolSchema.inputSchema || {},
      });
    } catch {}
  }
  return tools;
}

export async function callMcpTool(serverName, toolName, args = {}, timeoutMs = 45000) {
  const cfg = getMcpConfig();
  const serverCfg = cfg.mcpServers?.[serverName];
  if (!serverCfg) {
    throw new Error(`MCP Server '${serverName}' not found in configuration (${CONFIG_PATH}).`);
  }
  if (serverName === 'grok') {
    throw new Error(`Circular call rejected: Cannot call grok from grok.`);
  }

  const transport = new StdioClientTransport({
    command: serverCfg.command,
    args: serverCfg.args || [],
    env: { ...process.env, ...(serverCfg.env || {}) },
  });

  const client = new Client(
    { name: 'grok-agent-bridge', version: '1.0.0' },
    { capabilities: {} }
  );

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout calling tool '${toolName}' on '${serverName}' after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([client.connect(transport), timeoutPromise]);
    const res = await Promise.race([
      client.callTool({ name: toolName, arguments: args || {} }),
      timeoutPromise,
    ]);
    return res;
  } finally {
    clearTimeout(timer);
    try {
      await client.close();
    } catch {}
  }
}

// CLI Interface
const isCli = (() => {
  try {
    if (!process.argv[1]) return false;
    const realArg = existsSync(process.argv[1]) ? path.resolve(process.argv[1]) : null;
    const realImport = new URL(import.meta.url).pathname;
    return realArg && (realArg === realImport || path.basename(realArg) === 'mcp-call');
  } catch {
    return false;
  }
})();

if (isCli) {
  const [,, cmd, arg1, arg2, arg3] = process.argv;

  (async () => {
    try {
      if (!cmd || cmd === 'list-servers' || cmd === 'servers') {
        const srvs = listMcpServers();
        console.log(JSON.stringify(srvs, null, 2));
        process.exit(0);
      }

      if (cmd === 'list-tools' || cmd === 'tools') {
        if (!arg1) {
          console.error('Usage: mcp-bridge tools <server_name>');
          process.exit(1);
        }
        const tools = listMcpTools(arg1);
        console.log(JSON.stringify(tools, null, 2));
        process.exit(0);
      }

      if (cmd === 'call') {
        if (!arg1 || !arg2) {
          console.error('Usage: mcp-bridge call <server_name> <tool_name> [json_args]');
          process.exit(1);
        }
        let parsedArgs = {};
        if (arg3) {
          try {
            parsedArgs = JSON.parse(arg3);
          } catch (e) {
            console.error('Error parsing JSON arguments:', e.message);
            process.exit(1);
          }
        }
        const res = await callMcpTool(arg1, arg2, parsedArgs);
        console.log(JSON.stringify(res, null, 2));
        process.exit(0);
      }

      console.error(`Unknown command: ${cmd}`);
      console.error('Available commands: servers, tools <server_name>, call <server_name> <tool_name> [json_args]');
      process.exit(1);
    } catch (err) {
      console.error(`[mcp-bridge] Error: ${err.message}`);
      process.exit(1);
    }
  })();
}
