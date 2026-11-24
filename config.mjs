import os from 'node:os';
import path from 'node:path';

// Every local path and endpoint can be overridden through environment variables (see .env.example).
const HOME = os.homedir();
const ANTIGRAVITY_DIR = path.join(HOME, '.gemini', 'antigravity');

export const SETTINGS_FILE = process.env.GROK_SETTINGS_FILE || path.join(ANTIGRAVITY_DIR, 'grok-mcp-settings.json');
export const PROFILE_DIR = process.env.GROK_PROFILE_DIR || path.join(ANTIGRAVITY_DIR, 'grok-browser-profile');
export const GROK_CLI_BIN = process.env.GROK_CLI_BIN || path.join(HOME, '.grok', 'bin', 'grok');
export const GROK_CLI_AUTH = process.env.GROK_CLI_AUTH || path.join(HOME, '.grok', 'auth.json');
export const MCP_CONFIG_PATH = process.env.MCP_CONFIG_PATH || path.join(HOME, '.gemini', 'config', 'mcp_config.json');
export const MCP_SCHEMAS_DIR = process.env.MCP_SCHEMAS_DIR || path.join(ANTIGRAVITY_DIR, 'mcp');

const DEFAULT_CHROME_PATHS = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  linux: '/usr/bin/google-chrome',
};
export const CHROME_PATH = process.env.CHROME_PATH || DEFAULT_CHROME_PATHS[process.platform] || DEFAULT_CHROME_PATHS.linux;

export const PORTAL_URL = process.env.GROK_PORTAL_URL || 'http://localhost:8089';
export const DEFAULT_MODEL = process.env.GROK_DEFAULT_MODEL || 'grok-4.7';
// Model sent to the public xAI API when the requested name is a Grok Build CLI alias the API does not serve.
export const API_MODEL = process.env.GROK_API_MODEL || 'grok-4.7';
export const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.env.ANTIGRAVITY_WORKSPACE || process.cwd();

/**
 * Optional notification hook. Disabled unless GROK_NOTIFY_WEBHOOK_URL is set; POSTs {"message": "..."} as JSON.
 */
export async function notify(message) {
  const url = process.env.GROK_NOTIFY_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
  } catch (err) {
    console.error('[grok-mcp] Notification webhook failed:', err.message);
  }
}
