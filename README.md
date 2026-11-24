# Grok MCP Server

A Model Context Protocol (MCP) server for **Grok (xAI)**. Supported backends, in priority order:

1. **Grok Build CLI** (`~/.grok/bin/grok`) using its saved OAuth login.
2. **xAI API key** (`XAI_API_KEY`, or saved through `grok_status` → `set_api_key`).
3. **SuperGrok web session**: cookies captured through the optional auth portal.

## Tools

| Tool | Description |
| --- | --- |
| `grok_chat` | Sends a prompt to Grok. Optional `model`, `system_prompt`, `temperature`, `search_enabled`. |
| `grok_search_x` | Searches X and the web in real time. Optional `handles`, `from_date`, `to_date` (`YYYY-MM-DD`). |
| `grok_generate_image` | Generates an image. Optional `output_path` saves it to disk. |
| `grok_status` | Shows auth status. Also handles `set_api_key` and `set_default_model`. |
| `grok_run_agent` | Runs a small ReAct agent with local file/shell tools in `cwd` (default `WORKSPACE_DIR`). |
| `grok_list_mcp_servers` / `grok_call_mcp_tool` | Lists and calls tools on other locally configured MCP servers (e.g. `github`, `playwright`, `filesystem`). |

### Search behavior

- **Grok Build CLI:** local tools always stay off (`--tools ''`). Backend web search stays on unless `search_enabled: false`, which adds `--disable-web-search`.
- **Web session:** `search_enabled: false` sets `disableSearch: true`.
- **xAI API:** `grok_chat` uses plain `chat/completions` unless `search_enabled: true`. `grok_search_x` always searches. Search calls go to the Responses API (`/v1/responses`) with the `web_search` and `x_search` tools. If that endpoint rejects the request, the server retries with the legacy `search_parameters` (Live Search) on `chat/completions`.
- The `model` argument takes precedence over the model saved with `set_default_model`, which takes precedence over `GROK_DEFAULT_MODEL` (default `grok-4.7`). CLI-only aliases such as `grok-4.7-build-fast` become `GROK_API_MODEL` when sent to the API.

### Quota guard

`quota-guard.mjs` covers every call that goes through the primary path (`grok_chat`, `grok_run_agent`, and `grok_search_x` without an API key). It caps them at 6 per rolling hour, blocks duplicate prompts for 1 hour, and requires 60 s between calls. It keeps its state in `quota-state.json`, which is git-ignored.

## Installation

```bash
npm install
cp .env.example .env   # optional; or pass the variables through your MCP client config
```

MCP client config example:

```json
{
  "mcpServers": {
    "grok": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-grok/server.mjs"],
      "env": {
        "XAI_API_KEY": "",
        "GROK_DEFAULT_MODEL": "grok-4.7",
        "WORKSPACE_DIR": "/ABSOLUTE/PATH/TO/your/project"
      }
    }
  }
}
```

## Auth portal (optional)

```bash
npm run portal   # listens on 127.0.0.1:${GROK_PORTAL_PORT:-8089}
```

The portal streams a local Chrome window, where you can sign in to grok.com and capture the session cookies, or paste an xAI API key instead. It binds only to `127.0.0.1`. To reach it from another device, put it behind an authenticated reverse proxy or tunnel and set `GROK_PORTAL_URL` to that address.

To get a notification when credentials are saved, set `GROK_NOTIFY_WEBHOOK_URL`. The server POSTs `{"message": "..."}` as JSON to that URL. Leave it empty to turn notifications off.

Helper scripts for the Grok Build CLI device-code login:

- `device-login-watcher.mjs`: runs `grok login --device-auth` and writes the device URL/code to `GROK_DEVICE_CODE_FILE`.
- `auto-approve-cli.mjs`: approves the device code in the saved browser profile.

## Configuration

Every variable is optional. See `.env.example` for the full list, including path overrides (`GROK_SETTINGS_FILE`, `GROK_PROFILE_DIR`, `GROK_CLI_BIN`, `GROK_CLI_AUTH`, `MCP_CONFIG_PATH`, `MCP_SCHEMAS_DIR`, `CHROME_PATH`).

Credentials are stored in `GROK_SETTINGS_FILE` and never in the repository.

## Security notes

- `grok_run_agent` can read and write files and run shell commands inside `cwd`. Only point it at directories you trust it with.
- `grok_call_mcp_tool` can start any MCP server defined in `MCP_CONFIG_PATH`.
