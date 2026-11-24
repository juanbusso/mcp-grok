import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { SETTINGS_FILE as SETTINGS_PATH, PROFILE_DIR, CHROME_PATH, PORTAL_URL, notify } from "./config.mjs";

const PORT = Number(process.env.GROK_PORTAL_PORT || 8089);

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    }
  } catch (err) {
    console.error("[grok-portal] Error reading settings:", err.message);
  }
  return {};
}

function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

// Shared Playwright Browser State
let browserContext = null;
let activePage = null;
let startingBrowser = null;
let screenshotInterval = null;
const clients = new Set();

async function ensureBrowser(targetUrl = "https://accounts.x.ai/sign-in") {
  if (activePage && !activePage.isClosed()) {
    return activePage;
  }
  if (startingBrowser) {
    return startingBrowser;
  }
  startingBrowser = (async () => {
    try {
      const { chromium } = await import("playwright-core");
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      // Remove stale SingletonLock if any
      for (const lockFile of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        const p = path.join(PROFILE_DIR, lockFile);
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {}
      }

      browserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
        executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
        headless: true,
        viewport: { width: 1280, height: 800 },
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-sandbox",
          "--disable-setuid-sandbox",
        ],
      });

      const pages = browserContext.pages();
      activePage = pages.length > 0 ? pages[0] : await browserContext.newPage();

      // Listen to popups (e.g. "Sign in with X" or Google OAuth popup) so user sees the popup automatically
      browserContext.on("page", async (newPage) => {
        try {
          await newPage.setViewportSize({ width: 1280, height: 800 });
          activePage = newPage;
          newPage.on("close", () => {
            const remaining = browserContext ? browserContext.pages() : [];
            if (remaining.length > 0) {
              activePage = remaining[remaining.length - 1];
            }
          });
        } catch {}
      });

      await activePage.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
      return activePage;
    } finally {
      startingBrowser = null;
    }
  })();
  return startingBrowser;
}

async function closeBrowserAndSaveCookies() {
  let cookieString = "";
  let cookiesArray = [];
  let cookiesCount = 0;
  let currentUrl = "";

  if (browserContext) {
    try {
      if (activePage && !activePage.isClosed()) {
        currentUrl = activePage.url();
      }
      cookiesArray = await browserContext.cookies([
        "https://grok.com",
        "https://accounts.x.ai",
        "https://x.ai",
        "https://console.x.ai",
        "https://x.com",
      ]);
      cookiesCount = cookiesArray.length;
      const grokCookies = cookiesArray.filter(
        (c) => c.domain.includes("grok.com") || c.domain.includes("x.ai")
      );
      cookieString = (grokCookies.length > 0 ? grokCookies : cookiesArray)
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
    } catch (err) {
      console.error("[grok-portal] Cookie extraction error:", err.message);
    }

    try {
      await browserContext.close();
    } catch {}
    browserContext = null;
    activePage = null;
  }

  const current = loadSettings();
  const saved = saveSettings({
    cookieHeader: cookieString || current.cookieHeader || "",
    cookies: cookiesArray.length > 0 ? cookiesArray : (current.cookies || []),
    authMethod: current.apiKey ? "api_key" : "web_session",
    browserProfileReady: true,
    lastInteractiveLoginAt: new Date().toISOString(),
  });

  await notify(
    `Grok MCP connected: web session saved from the portal (${PORTAL_URL}). Cookies captured: ${cookiesCount}. Browser profile ready.`
  );

  return { ok: true, cookiesCount, currentUrl, hasApiKey: Boolean(saved.apiKey) };
}

async function broadcastScreenshot() {
  if (clients.size === 0 || !activePage || activePage.isClosed()) return;
  try {
    const buffer = await activePage.screenshot({ type: "jpeg", quality: 65, timeout: 3000 });
    const payload = JSON.stringify({
      type: "frame",
      url: activePage.url(),
      data: buffer.toString("base64"),
    });
    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(payload);
      }
    }
  } catch {
    // Ignore transient screenshot errors during navigation
  }
}

function startStreamingLoop() {
  if (screenshotInterval) return;
  screenshotInterval = setInterval(broadcastScreenshot, 450);
}

function stopStreamingLoopIfIdle() {
  if (clients.size === 0 && screenshotInterval) {
    clearInterval(screenshotInterval);
    screenshotInterval = null;
  }
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <meta property="og:title" content="Conectar Grok (xAI) — Portal de Acceso" />
  <meta property="og:description" content="Iniciá sesión con tu cuenta de Grok / X o cargá una API Key para habilitar Grok MCP." />
  <meta property="og:type" content="website" />
  <title>Conectar Grok (xAI) — Portal de Acceso</title>
  <style>
    :root {
      --bg: #090a0f;
      --card: #12141d;
      --border: #232736;
      --text: #f3f4f6;
      --muted: #9ca3af;
      --accent: #ffffff;
      --success: #10b981;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 16px;
    }
    .container {
      max-width: 980px;
      margin: 0 auto;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      padding: 16px 20px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      margin-bottom: 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: #fff;
      color: #000;
      font-weight: 900;
      font-size: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .brand h1 { font-size: 18px; font-weight: 700; }
    .brand p { font-size: 13px; color: var(--muted); }
    .status-badge {
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    .tab-btn {
      flex: 1;
      padding: 12px 16px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--muted);
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .tab-btn.active {
      background: #fff;
      color: #000;
      border-color: #fff;
    }
    .panel {
      display: none;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px;
    }
    .panel.active { display: block; }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 12px;
      align-items: center;
    }
    .btn {
      padding: 9px 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: #1d2130;
      color: var(--text);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn:hover { background: #272c40; }
    .btn-primary {
      background: #fff;
      color: #000;
      border-color: #fff;
    }
    .btn-primary:hover { background: #e5e7eb; }
    .btn-success {
      background: var(--success);
      color: #052e16;
      border-color: var(--success);
      font-weight: 700;
    }
    .input-bar {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .input-bar input {
      flex: 1;
      min-width: 200px;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: #090a0f;
      color: #fff;
      font-size: 14px;
    }
    .screen-wrap {
      position: relative;
      width: 100%;
      background: #000;
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      aspect-ratio: 16 / 10;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #remote-screen {
      width: 100%;
      height: 100%;
      object-fit: contain;
      cursor: pointer;
      display: none;
    }
    .screen-placeholder {
      text-align: center;
      color: var(--muted);
      padding: 24px;
    }
    .url-bar {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 8px;
      word-break: break-all;
      font-family: monospace;
    }
    .form-group { margin-bottom: 16px; }
    .form-group label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .form-group input, .form-group textarea {
      width: 100%;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: #090a0f;
      color: #fff;
      font-size: 14px;
      font-family: monospace;
    }
    .alert {
      margin-top: 12px;
      padding: 12px 14px;
      border-radius: 8px;
      font-size: 14px;
      display: none;
    }
    .alert.ok {
      display: block;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid var(--success);
      color: #6ee7b7;
    }
    .alert.err {
      display: block;
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid var(--danger);
      color: #fca5a5;
    }
    .steps {
      font-size: 13px;
      color: var(--muted);
      margin-bottom: 12px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="logo">𝕏</div>
        <div>
          <h1>Acceso a Grok (xAI)</h1>
          <p>Conectá tu cuenta SuperGrok / X o pegá una API Key de xAI</p>
        </div>
      </div>
      <div id="status-pill" class="status-badge">Cargando estado...</div>
    </header>

    <div class="tabs">
      <button class="tab-btn active" onclick="switchTab('browser')">🖥️ Opción 1: Iniciar Sesión con tu Cuenta (Grok / X)</button>
      <button class="tab-btn" onclick="switchTab('apikey')">🔑 Opción 2: Pegar API Key (xai-...)</button>
    </div>

    <!-- PANEL 1: INTERACTIVE BROWSER -->
    <div id="panel-browser" class="panel active">
      <div class="steps">
        <strong>¿Cómo funciona?</strong> Tocá <strong>"Abrir Navegador de Login"</strong>, hacé clic en la pantalla para elegir cómo entrar (con tu cuenta de X, Google o email), usá la barra de abajo para escribir tu usuario/contraseña o código, y cuando ya estés adentro de Grok tocá el botón verde <strong>"✅ Guardar y Activar Grok"</strong>.
      </div>

      <div class="toolbar">
        <button class="btn btn-primary" onclick="startRemoteBrowser('https://accounts.x.ai/sign-in')">🚀 Abrir Login xAI / Grok</button>
        <button class="btn" onclick="navigateRemote('https://grok.com')">Ir a grok.com</button>
        <button class="btn" onclick="navigateRemote('https://x.com/i/flow/login')">Login en X.com</button>
        <button class="btn btn-success" onclick="saveBrowserSession()">✅ Ya inicié sesión — Guardar y Activar Grok</button>
      </div>

      <div class="input-bar">
        <input type="text" id="type-input" placeholder="Escribí acá tu usuario, clave o código 2FA para enviarlo al campo activo..." onkeydown="if(event.key==='Enter') sendTypedText(true)" />
        <button class="btn btn-primary" onclick="sendTypedText(false)">Escribir texto</button>
        <button class="btn" onclick="sendTypedText(true)">Escribir + Enter ↵</button>
        <button class="btn" onclick="sendKey('Enter')">Enter ↵</button>
        <button class="btn" onclick="sendKey('Backspace')">⌫ Borrar</button>
        <button class="btn" onclick="sendKey('Tab')">Tab ⇥</button>
      </div>

      <div class="url-bar" id="current-url">URL actual: (navegador apagado)</div>

      <div class="screen-wrap" id="screen-container">
        <div class="screen-placeholder" id="screen-placeholder">
          Tocá <strong>"🚀 Abrir Login xAI / Grok"</strong> arriba para iniciar el navegador interactivo en vivo.
        </div>
        <img id="remote-screen" alt="Pantalla remota de Grok" />
      </div>

      <div id="browser-alert" class="alert"></div>
    </div>

    <!-- PANEL 2: API KEY & COOKIES -->
    <div id="panel-apikey" class="panel">
      <div class="steps">
        Si preferís usar una <strong>API Key oficial de xAI</strong> (desde <a href="https://console.x.ai" target="_blank" style="color:#fff">console.x.ai</a>), pegala acá abajo y se valida en el acto:
      </div>

      <div class="form-group">
        <label>API Key de xAI (empieza con <code>xai-...</code>)</label>
        <input type="password" id="api-key-input" placeholder="Paste your xAI API key here" />
      </div>

      <div class="form-group">
        <label>Cookies de sesión de grok.com (Opcional, solo si las copiaste manualmente)</label>
        <textarea id="cookies-input" rows="3" placeholder="sso=...; sso-rw=..."></textarea>
      </div>

      <button class="btn btn-success" onclick="saveApiKey()">✅ Validar y Guardar Credenciales</button>
      <div id="apikey-alert" class="alert"></div>
    </div>
  </div>

  <script>
    let ws = null;
    const screenImg = document.getElementById('remote-screen');
    const placeholder = document.getElementById('screen-placeholder');
    const urlBar = document.getElementById('current-url');

    async function refreshStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        const pill = document.getElementById('status-pill');
        if (data.hasApiKey || data.hasCookies || data.browserProfileReady) {
          pill.textContent = '✅ Conectado (' + [
            data.hasApiKey ? 'API Key' : null,
            (data.hasCookies || data.browserProfileReady) ? 'Sesión Web' : null
          ].filter(Boolean).join(' + ') + ')';
        } else {
          pill.textContent = '⏳ Pendiente de vinculación';
        }
      } catch {}
    }
    refreshStatus();

    function switchTab(tab) {
      document.querySelectorAll('.tab-btn').forEach((b, i) => {
        b.classList.toggle('active', (tab === 'browser' && i === 0) || (tab === 'apikey' && i === 1));
      });
      document.getElementById('panel-browser').classList.toggle('active', tab === 'browser');
      document.getElementById('panel-apikey').classList.toggle('active', tab === 'apikey');
    }

    function connectWs() {
      if (ws && ws.readyState <= 1) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/ws');
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'frame') {
            placeholder.style.display = 'none';
            screenImg.style.display = 'block';
            screenImg.src = 'data:image/jpeg;base64,' + msg.data;
            urlBar.textContent = 'URL actual: ' + (msg.url || '');
          }
        } catch {}
      };
    }

    async function startRemoteBrowser(url) {
      placeholder.innerHTML = '⏳ Abriendo navegador Chrome seguro en el servidor...';
      placeholder.style.display = 'block';
      connectWs();
      await fetch('/api/browser/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
    }

    async function navigateRemote(url) {
      connectWs();
      await fetch('/api/browser/navigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
    }

    screenImg.addEventListener('click', (e) => {
      if (!ws || ws.readyState !== 1) return;
      const rect = screenImg.getBoundingClientRect();
      const xRatio = (e.clientX - rect.left) / rect.width;
      const yRatio = (e.clientY - rect.top) / rect.height;
      ws.send(JSON.stringify({
        type: 'click',
        x: Math.round(xRatio * 1280),
        y: Math.round(yRatio * 800)
      }));
    });

    function sendTypedText(pressEnter) {
      const input = document.getElementById('type-input');
      const text = input.value;
      if (!text && !pressEnter) return;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'type', text, pressEnter }));
        input.value = '';
      }
    }

    function sendKey(key) {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'key', key }));
      }
    }

    async function saveBrowserSession() {
      const alertBox = document.getElementById('browser-alert');
      alertBox.className = 'alert ok';
      alertBox.textContent = '⏳ Guardando sesión y cookies...';
      try {
        const res = await fetch('/api/browser/save', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          alertBox.className = 'alert ok';
          alertBox.textContent = '✅ ¡Listo! Sesión de Grok guardada con éxito (' + data.cookiesCount + ' cookies).';
          refreshStatus();
        } else {
          alertBox.className = 'alert err';
          alertBox.textContent = '❌ Error: ' + (data.error || 'No se pudo guardar');
        }
      } catch (err) {
        alertBox.className = 'alert err';
        alertBox.textContent = '❌ Error de red: ' + err.message;
      }
    }

    async function saveApiKey() {
      const apiKey = document.getElementById('api-key-input').value.trim();
      const cookies = document.getElementById('cookies-input').value.trim();
      const alertBox = document.getElementById('apikey-alert');
      alertBox.className = 'alert ok';
      alertBox.textContent = '⏳ Validando y guardando...';
      try {
        const res = await fetch('/api/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, cookies })
        });
        const data = await res.json();
        if (data.ok) {
          alertBox.className = 'alert ok';
          alertBox.textContent = '✅ ¡Excelente! Credenciales guardadas y activadas. ' + (data.message || '');
          refreshStatus();
        } else {
          alertBox.className = 'alert err';
          alertBox.textContent = '❌ ' + (data.error || 'Error al validar credenciales');
        }
      } catch (err) {
        alertBox.className = 'alert err';
        alertBox.textContent = '❌ Error: ' + err.message;
      }
    }
  </script>
</body>
</html>`;

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : HTML_PAGE);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const s = loadSettings();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        hasApiKey: Boolean(s.apiKey),
        hasCookies: Boolean(s.cookieHeader || (Array.isArray(s.cookies) && s.cookies.length > 0)),
        browserProfileReady: Boolean(s.browserProfileReady || fs.existsSync(PROFILE_DIR)),
        updatedAt: s.updatedAt || null,
      })
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/browser/start") {
    const body = await readBody(req);
    try {
      const page = await ensureBrowser(body.url || "https://accounts.x.ai/sign-in");
      await broadcastScreenshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, url: page.url() }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/browser/navigate") {
    const body = await readBody(req);
    try {
      const page = await ensureBrowser(body.url || "https://grok.com");
      if (body.url) {
        await page.goto(body.url, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
      }
      await broadcastScreenshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, url: page.url() }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/browser/save") {
    try {
      const result = await closeBrowserAndSaveCookies();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/credentials") {
    const body = await readBody(req);
    const patch = {};
    let validationMsg = "";

    if (body.apiKey) {
      try {
        const check = await fetch("https://api.x.ai/v1/models", {
          headers: { Authorization: `Bearer ${body.apiKey.trim()}` },
        });
        if (!check.ok) {
          const errTxt = await check.text();
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: `La API Key fue rechazada por xAI (${check.status}): ${errTxt.slice(0, 200)}`,
            })
          );
          return;
        }
        patch.apiKey = body.apiKey.trim();
        validationMsg = "API Key de xAI verificada contra api.x.ai.";
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
        return;
      }
    }

    if (body.cookies) {
      patch.cookieHeader = body.cookies.trim();
      if (!patch.apiKey) patch.authMethod = "web_session";
    }
    if (patch.apiKey) {
      patch.authMethod = "api_key";
    }

    if (!patch.apiKey && !patch.cookieHeader) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Ingresá una API Key o Cookies." }));
      return;
    }

    saveSettings(patch);
    await notify(
      `Grok MCP configured from the portal (${PORTAL_URL}). xAI API key: ${patch.apiKey ? "verified" : "unchanged"}. Web cookies: ${patch.cookieHeader ? "loaded" : "unchanged"}.`
    );

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: validationMsg }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  clients.add(ws);
  startStreamingLoop();
  broadcastScreenshot();

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const page = await ensureBrowser();
      if (!page || page.isClosed()) return;

      if (msg.type === "click" && typeof msg.x === "number" && typeof msg.y === "number") {
        await page.mouse.click(msg.x, msg.y);
        setTimeout(broadcastScreenshot, 150);
      } else if (msg.type === "type" && typeof msg.text === "string") {
        if (msg.text) {
          await page.keyboard.type(msg.text, { delay: 25 });
        }
        if (msg.pressEnter) {
          await page.keyboard.press("Enter");
        }
        setTimeout(broadcastScreenshot, 200);
      } else if (msg.type === "key" && typeof msg.key === "string") {
        await page.keyboard.press(msg.key);
        setTimeout(broadcastScreenshot, 150);
      }
    } catch (err) {
      console.error("[grok-portal] WS action error:", err.message);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    stopStreamingLoopIfIdle();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[grok-portal] Listening on http://127.0.0.1:${PORT}`);
});
