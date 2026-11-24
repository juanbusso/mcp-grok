import { reserveGrokCall } from './quota-guard.mjs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { runGrokAgent } from './agent-runner.mjs';
import { listMcpServers, listMcpTools, callMcpTool } from './mcp-bridge.mjs';
import {
  SETTINGS_FILE,
  PROFILE_DIR,
  PORTAL_URL,
  CHROME_PATH as CHROME_EXECUTABLE,
  GROK_CLI_BIN,
  GROK_CLI_AUTH,
  DEFAULT_MODEL,
  API_MODEL,
  WORKSPACE_DIR,
} from './config.mjs';

export function getSettings() {
  try {
    if (existsSync(SETTINGS_FILE)) {
      return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error(`[grok-mcp] Could not read ${SETTINGS_FILE}: ${err.message}`);
  }
  return {
    apiKey: process.env.XAI_API_KEY || '',
    cookieHeader: '',
    cookies: [],
    authMethod: 'none',
    updatedAt: null,
  };
}

export function saveSettings(patch) {
  const current = getSettings();
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const dir = path.dirname(SETTINGS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

async function callXaiApi(endpoint, body, apiKey) {
  const res = await fetch(`https://api.x.ai/v1${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`xAI API HTTP ${res.status}: ${data?.error?.message || data?.error || text.slice(0, 400)}`);
  }
  return data;
}

function recordGrokCall(modelName) {
  try {
    const s = getSettings();
    const cutoff = Date.now() - 2 * 3600 * 1000;
    const recent = Array.isArray(s.recentCalls)
      ? s.recentCalls.filter((c) => c && typeof c.timestamp === 'number' && c.timestamp > cutoff)
      : [];
    recent.push({ model: modelName, timestamp: Date.now() });
    saveSettings({ recentCalls: recent });
  } catch {}
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Grok Build CLI aliases that the public xAI API does not serve; they are swapped for API_MODEL on API calls.
const CLI_ONLY_MODELS = new Set(['grok-4.7-build-fast', 'build-cli', 'fast', 'grok-fast']);

function toApiModel(requestedModel) {
  return !requestedModel || CLI_ONLY_MODELS.has(requestedModel) ? API_MODEL : requestedModel;
}

// Grok Build CLI args: never enable local tools (--tools ''); backend web search stays on unless search === false.
function cliArgs(prompt, cliModel, search) {
  const args = ['-p', prompt, '-m', cliModel, '--tools', ''];
  if (search === false) args.push('--disable-web-search');
  return args;
}

function extractResponsesText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const parts = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (item?.type !== 'message') continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (typeof part?.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * xAI API call with server-side search tools (Responses API: web_search + x_search).
 * Falls back to the legacy chat/completions `search_parameters` (Live Search) when /responses rejects the request.
 */
async function callXaiSearch({ prompt, model, apiKey, handles = [], fromDate, toDate, temperature }) {
  const xTool = { type: 'x_search' };
  if (handles.length > 0) xTool.allowed_x_handles = handles;
  if (fromDate) xTool.from_date = fromDate;
  if (toDate) xTool.to_date = toDate;
  const responsesBody = { model, input: [{ role: 'user', content: prompt }], tools: [{ type: 'web_search' }, xTool] };
  if (typeof temperature === 'number') responsesBody.temperature = temperature;

  try {
    const data = await callXaiApi('/responses', responsesBody, apiKey);
    return { text: extractResponsesText(data), citations: data?.citations || [], endpoint: 'responses' };
  } catch (responsesErr) {
    if (!/HTTP (400|404|405|422)\b/.test(responsesErr.message)) throw responsesErr;
    console.error(`[grok-mcp] /responses search rejected (${responsesErr.message}); retrying with legacy search_parameters.`);
    const xSource = { type: 'x' };
    if (handles.length > 0) xSource.included_x_handles = handles;
    const searchParams = { mode: 'on', return_citations: true, sources: [xSource, { type: 'news' }, { type: 'web' }] };
    if (fromDate) searchParams.from_date = fromDate;
    if (toDate) searchParams.to_date = toDate;
    try {
      const data = await callXaiApi(
        '/chat/completions',
        {
          model,
          messages: [{ role: 'user', content: prompt }],
          search_parameters: searchParams,
          temperature: typeof temperature === 'number' ? temperature : 0.2,
        },
        apiKey,
      );
      return {
        text: data?.choices?.[0]?.message?.content || '',
        citations: data?.citations || [],
        endpoint: 'chat-completions-live-search',
      };
    } catch (legacyErr) {
      throw new Error(`xAI search failed. responses: ${responsesErr.message} | legacy: ${legacyErr.message}`);
    }
  }
}

async function getGrokCliWeeklyBilling() {
  try {
    if (!existsSync(GROK_CLI_AUTH)) return null;
    const raw = JSON.parse(readFileSync(GROK_CLI_AUTH, 'utf8'));
    const entry = Object.values(raw?.entries || raw || {}).find((v) => v && typeof v === 'object' && v.key);
    if (!entry?.key) return null;
    const res = await fetch('https://cli-chat-proxy.grok.com/v1/billing?format=credits', {
      headers: { Authorization: `Bearer ${entry.key}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const cfg = data?.config || data || {};
    const usedPercent = Number(cfg.creditUsagePercent ?? 0);
    const endIso = cfg?.currentPeriod?.end || cfg?.billingPeriodEnd || null;
    return {
      email: entry.email || null,
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      resetsAtIso: endIso,
    };
  } catch {
    return null;
  }
}

function mapToCliModel(requestedModel = 'grok-4.7') {
  if (
    requestedModel === 'grok-4.7' ||
    requestedModel === 'grok-4.7-build-fast' ||
    requestedModel === 'grok-4.6' ||
    requestedModel === 'grok-4.5'
  ) {
    return requestedModel;
  }
  if (requestedModel === 'grok-3' || requestedModel === 'fast' || requestedModel === 'grok-fast') {
    return 'grok-4.7-build-fast';
  }
  return 'grok-4.7';
}

/**
 * Consulta primaria mediante Grok Build CLI oficial (@xai-official/grok)
 * con fallback a API Key de xAI o sesión Web
 */
async function callGrokPrimary(prompt, requestedModel = DEFAULT_MODEL, { search, temperature } = {}) {
  reserveGrokCall(prompt);
  // 1) PRIORIDAD MÁXIMA: Grok Build CLI (@xai-official/grok) con OAuth persistido
  if (existsSync(GROK_CLI_BIN) && existsSync(GROK_CLI_AUTH)) {
    try {
      const cliModel = mapToCliModel(requestedModel);
      const { stdout } = await execFileAsync(
        GROK_CLI_BIN,
        cliArgs(prompt, cliModel, search),
        { timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
      );
      const cleaned = String(stdout || '')
        .replace(/\n?Finishing session…\s*$/i, '')
        .trim();
      if (cleaned) {
        recordGrokCall(cliModel);
        return { text: cleaned, mode: 'grok-build-cli', model: cliModel };
      }
    } catch (cliErr) {
      throw cliErr; // Fail closed: no quota-consuming fallback after errors.
    }
  }

  // 2) Fallback secundario: API Key oficial de xAI.
  // Búsqueda (web + X) sólo si search === true explícito, para no cambiar el costo/forma de las llamadas de chat simples.
  const settings = getSettings();
  if (settings.apiKey) {
    const apiModel = toApiModel(requestedModel);
    if (search === true) {
      const res = await callXaiSearch({ prompt, model: apiModel, apiKey: settings.apiKey, temperature });
      if (res.text) {
        recordGrokCall(apiModel);
        return { text: res.text, mode: `xai-api-${res.endpoint}`, model: apiModel, citations: res.citations };
      }
    } else {
      const body = {
        model: apiModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: typeof temperature === 'number' ? temperature : 0.3,
      };
      const data = await callXaiApi('/chat/completions', body, settings.apiKey);
      const reply = data?.choices?.[0]?.message?.content || '';
      if (reply) {
        recordGrokCall(apiModel);
        return { text: reply, mode: 'xai-api', model: data?.model || apiModel };
      }
    }
  }

  // 3) Fallback terciario: Sesión Web de grok.com si hubiera cookies
  if (settings.cookieHeader) {
    return await callGrokWebSession(prompt, settings.cookieHeader, requestedModel, search === false);
  }

  throw new Error('No se pudo ejecutar la consulta con Grok (Build CLI ni Web disponibles).');
}

/**
 * Fallback / Modo SuperGrok Web usando las credenciales guardadas
 */
async function callGrokWebSession(prompt, cookieHeader, requestedModel = 'grok-4', disableSearch = false) {
  const isExplicitCliModel =
    requestedModel === 'grok-4.7' ||
    requestedModel === 'grok-4.7-build-fast' ||
    requestedModel === 'grok-4.6' ||
    requestedModel === 'grok-4.5' ||
    requestedModel === 'build-cli';

  const modelName =
    requestedModel === 'grok-3' || requestedModel === 'grok-4-heavy' || requestedModel === 'grok-4-auto'
      ? requestedModel
      : 'grok-4';
  const modelMode =
    modelName === 'grok-4-heavy'
      ? 'MODEL_MODE_HEAVY'
      : modelName === 'grok-3'
      ? 'MODEL_MODE_FAST'
      : modelName === 'grok-4-auto'
      ? 'MODEL_MODE_AUTO'
      : 'MODEL_MODE_EXPERT';

  // 1) Si no se pide explícitamente el CLI, PRIORIZAR sesión web de SuperGrok (ventana móvil de 2 horas)
  if (!isExplicitCliModel && cookieHeader) {
    try {
      const res = await fetch('https://grok.com/rest/app-chat/conversations/new', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
          Origin: 'https://grok.com',
          Referer: 'https://grok.com/',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        },
        body: JSON.stringify({
          temporary: true,
          modelName,
          modelMode,
          message: prompt,
          fileAttachments: [],
          imageAttachments: [],
          disableSearch: Boolean(disableSearch),
          enableImageGeneration: false,
          returnImageBytes: false,
          returnRawGrokInXaiRequest: false,
          enableImageStreaming: false,
          imageGenerationCount: 1,
          forceConcise: true,
          toolOverrides: {},
          enableSideBySide: false,
          sendFinalMetadata: true,
          isReasoning: false,
        }),
      });

      if (res.ok) {
        const raw = await res.text();
        const lines = raw.split('\n').filter((l) => l.trim());
        let fullText = '';
        for (const line of lines) {
          try {
            const evt = JSON.parse(line);
            const token =
              evt?.result?.response?.token ||
              evt?.result?.response?.modelResponse?.message ||
              '';
            if (evt?.result?.response?.modelResponse?.message) {
              fullText = evt.result.response.modelResponse.message;
            } else if (token) {
              fullText += token;
            }
          } catch {}
        }
        if (fullText.trim()) {
          recordGrokCall(modelName);
          return { text: fullText.trim(), mode: 'supergrok-web-rest', model: modelName };
        }
      }
    } catch {}
  }

  // 2) Fallback a Grok Build CLI (@xai-official/grok) si la sesión web falla o se pidió grok-4.7 explícito
  if (existsSync(GROK_CLI_BIN) && existsSync(GROK_CLI_AUTH)) {
    try {
      const cliModel = isExplicitCliModel ? mapToCliModel(requestedModel) : 'grok-4.7';
      const { stdout } = await execFileAsync(
        GROK_CLI_BIN,
        cliArgs(prompt, cliModel, disableSearch ? false : undefined),
        { timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
      );
      const cleaned = String(stdout || '')
        .replace(/\n?Finishing session…\s*$/i, '')
        .trim();
      if (cleaned) {
        recordGrokCall(cliModel);
        return { text: cleaned, mode: 'grok-build-cli', model: cliModel };
      }
    } catch {}
  }

  // Fallback vía Playwright Headless sobre el perfil autenticado si no hay API key
  if (existsSync(PROFILE_DIR)) {
    let context;
    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        executablePath: existsSync(CHROME_EXECUTABLE) ? CHROME_EXECUTABLE : undefined,
        headless: true,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      });
      const page = context.pages()[0] || (await context.newPage());
      const result = await page.evaluate(async ({ userPrompt, noSearch }) => {
        const r = await fetch('https://grok.com/rest/app-chat/conversations/new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            temporary: false,
            modelName: 'grok-3',
            message: userPrompt,
            disableSearch: noSearch,
          }),
        });
        return { status: r.status, text: await r.text() };
      }, { userPrompt: prompt, noSearch: Boolean(disableSearch) });

      if (result.status >= 200 && result.status < 300) {
        let fullText = '';
        for (const line of result.text.split('\n').filter(Boolean)) {
          try {
            const evt = JSON.parse(line);
            if (evt?.result?.response?.modelResponse?.message) {
              fullText = evt.result.response.modelResponse.message;
            } else if (evt?.result?.response?.token) {
              fullText += evt.result.response.token;
            }
          } catch {}
        }
        if (fullText.trim()) {
          return { text: fullText.trim(), mode: 'supergrok-browser-session' };
        }
      }
    } finally {
      if (context) await context.close().catch(() => {});
    }
  }

  throw new Error(
    `No se pudo completar la consulta por sesión web. Verificá que la sesión de Grok esté activa en ${PORTAL_URL}`,
  );
}

const server = new Server(
  {
    name: 'grok',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'grok_chat',
      description:
        'Consulta a Grok (xAI: Grok 4 / Grok 3 / SuperGrok) con razonamiento y acceso en tiempo real a la web y a X (Twitter). Soporta tanto API Key de xAI como sesión web de SuperGrok.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Consulta, tarea o pregunta para Grok.',
          },
          system_prompt: {
            type: 'string',
            description: 'Instrucciones de sistema opcionales.',
          },
          model: {
            type: 'string',
            description:
              'Modelo de Grok a usar (ej. grok-4.7, grok-4, grok-3). Por defecto: el configurado con set_default_model o GROK_DEFAULT_MODEL.',
          },
          search_enabled: {
            type: 'boolean',
            description:
              'Búsqueda web + X en tiempo real. CLI y sesión web: activa salvo false. API xAI: sólo con true explícito (usa las tools web_search/x_search).',
          },
          temperature: {
            type: 'number',
            description: 'Temperatura de muestreo (default: 0.3).',
          },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'grok_search_x',
      description:
        'Busca posts, tendencias, discusiones en tiempo real y noticias de último minuto en X (Twitter) usando el motor nativo de Grok.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Tema, tendencia, búsqueda o pregunta sobre lo que está pasando en X (Twitter).',
          },
          handles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Lista opcional de cuentas de X (sin @) para filtrar la búsqueda.',
          },
          from_date: {
            type: 'string',
            description: 'Fecha inicial opcional en formato YYYY-MM-DD.',
          },
          to_date: {
            type: 'string',
            description: 'Fecha final opcional en formato YYYY-MM-DD.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'grok_generate_image',
      description:
        'Genera imágenes con IA usando el modelo de imagen de Grok / xAI (grok-2-image) y opcionalmente las guarda en disco.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Descripción detallada de la imagen a generar.',
          },
          output_path: {
            type: 'string',
            description: 'Ruta local absoluta opcional donde guardar la imagen generada (ej. /tmp/imagen.jpg).',
          },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'grok_status',
      description:
        'Verifica el estado de autenticación del MCP de Grok (API Key o Sesión Web SuperGrok), modelos disponibles y devuelve el link del portal remoto para compartir.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'set_api_key', 'set_default_model'],
            description: 'Acción a realizar (default: status).',
          },
          api_key: {
            type: 'string',
            description: 'Nueva API Key de xAI (xai-...) si action es set_api_key.',
          },
          default_model: {
            type: 'string',
            description: 'Modelo por defecto si action es set_default_model.',
          },
        },
      },
    },
    {
      name: 'grok_run_agent',
      description:
        'Ejecuta a Grok como un Agente Autónomo (ReAct) con acceso a herramientas locales (lectura/edición de archivos, ejecución de comandos, búsqueda de código). Utiliza la sesión de SuperGrok Web (ventana móvil gratuita de 2h) sin consumir la cuota semanal fija de Claude ni Gemini.',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Tarea, investigación, auditoría de código o desarrollo a realizar de forma autónoma.',
          },
          model: {
            type: 'string',
            description: 'Modelo de Grok a usar (ej. grok-4-heavy, grok-4, grok-3). Por defecto grok-4-heavy.',
          },
          cwd: {
            type: 'string',
            description: 'Directorio de trabajo para el agente (default: WORKSPACE_DIR o el directorio actual).',
          },
          max_turns: {
            type: 'number',
            description: 'Cantidad máxima de turnos iterativos de herramientas (default: 3; máximo: 3).',
          },
        },
        required: ['task'],
      },
    },
    {
      name: 'grok_list_mcp_servers',
      description:
        'Lista todos los servidores MCP configurados localmente (ej. GitHub, Playwright, Filesystem) y las herramientas disponibles para Grok.',
      inputSchema: {
        type: 'object',
        properties: {
          server: {
            type: 'string',
            description: 'Opcional: nombre del servidor MCP (ej. "github", "playwright") para listar sus herramientas específicas y schemas.',
          },
        },
      },
    },
    {
      name: 'grok_call_mcp_tool',
      description:
        'Ejecuta cualquier herramienta de cualquier servidor MCP configurado localmente desde el entorno de Grok.',
      inputSchema: {
        type: 'object',
        properties: {
          server: {
            type: 'string',
            description: 'Nombre del servidor MCP (ej. "github", "playwright", "filesystem").',
          },
          tool: {
            type: 'string',
            description: 'Nombre de la herramienta MCP a ejecutar.',
          },
          args: {
            type: 'object',
            description: 'Argumentos para la herramienta.',
          },
        },
        required: ['server', 'tool'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const settings = getSettings();

  try {
    if (name === 'grok_status') {
      if (args.action === 'set_api_key' && args.api_key) {
        const updated = saveSettings({
          apiKey: String(args.api_key).trim(),
          authMethod: 'api_key',
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message: 'API Key de Grok (xAI) guardada correctamente.',
                  authMethod: updated.authMethod,
                  defaultModel: updated.defaultModel,
                  portalUrl: PORTAL_URL,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (args.action === 'set_default_model' && args.default_model) {
        const updated = saveSettings({ defaultModel: String(args.default_model).trim() });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, defaultModel: updated.defaultModel }, null, 2),
            },
          ],
        };
      }

      const hasApiKey = Boolean(settings.apiKey && settings.apiKey.length > 8);
      const hasWebSession = Boolean(
        (settings.cookieHeader && settings.cookieHeader.length > 10) ||
          (Array.isArray(settings.cookies) && settings.cookies.length > 0),
      );
      const hasGrokCliAuth = existsSync(GROK_CLI_AUTH);
      const weeklyLimit = await getGrokCliWeeklyBilling();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                configured: hasApiKey || hasWebSession || hasGrokCliAuth,
                account: weeklyLimit?.email ?? null,
                hasApiKey,
                apiKeyPreview: hasApiKey
                  ? `${settings.apiKey.slice(0, 7)}...${settings.apiKey.slice(-4)}`
                  : null,
                hasGrokCliAuth,
                hasWebSession,
                cookiesCount: Array.isArray(settings.cookies) ? settings.cookies.length : 0,
                authMethod: hasGrokCliAuth
                  ? 'grok-cli-oauth + web_session'
                  : settings.authMethod || (hasApiKey ? 'api_key' : hasWebSession ? 'web_session' : 'none'),
                defaultModel: settings.defaultModel || DEFAULT_MODEL,
                weeklyLimit,
                updatedAt: settings.updatedAt,
                accessPortalUrl: PORTAL_URL,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === 'grok_chat') {
      const prompt = String(args.prompt || '');
      const systemPrompt = args.system_prompt
        ? String(args.system_prompt)
        : 'Sos Grok, asistente técnico y analítico de alta precisión. Respondé siempre en español rioplatense claro y directo.';
      const model = args.model || settings.defaultModel || DEFAULT_MODEL;
      const search = typeof args.search_enabled === 'boolean' ? args.search_enabled : undefined;
      const temperature = typeof args.temperature === 'number' ? args.temperature : undefined;

      try {
        const fullPrompt = `${systemPrompt}\n\nConsulta: ${prompt}`;
        const res = await callGrokPrimary(fullPrompt, model, { search, temperature });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  model: res.model || model,
                  mode: res.mode,
                  response: res.text,
                  ...(res.citations ? { citations: res.citations } : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error al consultar Grok (${model}): ${err.message}`,
            },
          ],
        };
      }
    }

    if (name === 'grok_search_x') {
      const query = String(args.query || '');
      const handles = Array.isArray(args.handles)
        ? args.handles.map((h) => String(h).trim().replace(/^@/, '')).filter(Boolean)
        : [];
      const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
      const fromDate = isDate(args.from_date) ? args.from_date : undefined;
      const toDate = isDate(args.to_date) ? args.to_date : undefined;
      const scope = [
        handles.length > 0 ? `Limitate a estas cuentas de X: ${handles.map((h) => `@${h}`).join(', ')}.` : '',
        fromDate ? `Desde: ${fromDate}.` : '',
        toDate ? `Hasta: ${toDate}.` : '',
      ]
        .filter(Boolean)
        .join(' ');
      const prompt = `Buscá en tiempo real en X (Twitter) y noticias recientes toda la información relevante sobre: "${query}". ${scope} Incluí qué dicen los usuarios, cuentas clave, fechas/horas y contexto verificable.`.trim();

      if (settings.apiKey) {
        const model = toApiModel(settings.defaultModel || DEFAULT_MODEL);
        const res = await callXaiSearch({ prompt, model, apiKey: settings.apiKey, handles, fromDate, toDate, temperature: 0.2 });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { query, mode: `xai-api-${res.endpoint}`, model, response: res.text, citations: res.citations },
                null,
                2,
              ),
            },
          ],
        };
      }

      try {
        const res = await callGrokPrimary(prompt, settings.defaultModel || DEFAULT_MODEL, { search: true });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ query, mode: res.mode, response: res.text }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error en grok_search_x: ${err.message}`,
            },
          ],
        };
      }
    }

    if (name === 'grok_generate_image') {
      const prompt = String(args.prompt || '');

      if (settings.apiKey) {
        const data = await callXaiApi(
          '/images/generations',
          {
            model: 'grok-2-image',
            prompt,
            n: 1,
            response_format: 'url',
          },
          settings.apiKey,
        );
        const imageUrl = data?.data?.[0]?.url;
        let savedTo = null;
        if (imageUrl && args.output_path) {
          const imgRes = await fetch(imageUrl);
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            const outDir = path.dirname(args.output_path);
            if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
            writeFileSync(args.output_path, buf);
            savedTo = args.output_path;
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, mode: 'xai-api', imageUrl, savedTo }, null, 2),
            },
          ],
        };
      }

      if (settings.cookieHeader) {
        const res = await fetch('https://grok.com/rest/app-chat/conversations/new', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: settings.cookieHeader,
            Origin: 'https://grok.com',
            Referer: 'https://grok.com/',
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
          },
          body: JSON.stringify({
            temporary: true,
            modelName: 'grok-3',
            message: `Generate an image: ${prompt}`,
            fileAttachments: [],
            imageAttachments: [],
            disableSearch: true,
            enableImageGeneration: true,
            returnImageBytes: false,
            enableImageStreaming: false,
            imageGenerationCount: 2,
            toolOverrides: { imageGen: true },
          }),
        });

        if (res.ok) {
          const raw = await res.text();
          let relUrl = null;
          for (const line of raw.split('\n').filter(Boolean)) {
            try {
              const evt = JSON.parse(line);
              const cardStr = evt?.result?.response?.cardAttachment?.jsonData;
              if (cardStr) {
                const card = JSON.parse(cardStr);
                if (card?.image_chunk?.progress === 100 && card?.image_chunk?.imageUrl) {
                  relUrl = card.image_chunk.imageUrl;
                }
              }
            } catch {}
          }
          if (relUrl) {
            const imageUrl = relUrl.startsWith('http') ? relUrl : `https://assets.grok.com/${relUrl.replace(/^\//, '')}`;
            let savedTo = null;
            if (args.output_path) {
              const imgRes = await fetch(imageUrl, {
                headers: {
                  Cookie: settings.cookieHeader,
                  Referer: 'https://grok.com/',
                  'User-Agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
                },
              });
              if (imgRes.ok) {
                const buf = Buffer.from(await imgRes.arrayBuffer());
                const outDir = path.dirname(args.output_path);
                if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
                writeFileSync(args.output_path, buf);
                savedTo = args.output_path;
              }
            }
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: true, mode: 'supergrok-web-rest', imageUrl, savedTo }, null, 2),
                },
              ],
            };
          }
        }
      }

      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Para generar imágenes por MCP se requiere vincular la cuenta o API Key en ${PORTAL_URL}`,
          },
        ],
      };
    }

    if (name === 'grok_run_agent') {
      const task = String(args.task || '');
      const model = args.model || 'grok-3';
      const cwd = args.cwd || WORKSPACE_DIR;
      const maxTurns = Number.isFinite(args.max_turns) ? Math.max(1, Math.min(3, Math.floor(args.max_turns))) : 3;

      const callGrokFn = async (prompt, requestedModel) => {
        return await callGrokPrimary(prompt, requestedModel);
      };

      const result = await runGrokAgent({
        task,
        callGrokFn,
        model,
        cwd,
        maxTurns,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'grok_list_mcp_servers') {
      if (args.server) {
        const tools = listMcpTools(String(args.server));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(tools, null, 2),
            },
          ],
        };
      }
      const srvs = listMcpServers();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(srvs, null, 2),
          },
        ],
      };
    }

    if (name === 'grok_call_mcp_tool') {
      const serverName = String(args.server || '');
      const toolName = String(args.tool || '');
      const toolArgs = args.args || {};
      const res = await callMcpTool(serverName, toolName, toolArgs);
      return res;
    }

    throw new Error(`Tool desconocida: ${name}`);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Error en Grok MCP (${name}): ${err.message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
