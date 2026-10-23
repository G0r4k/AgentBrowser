/**
 * AgentBrowser — Navegador web diseñado para agentes de IA
 * ==========================================================
 * - Motor: Playwright (Chromium)
 * - Mouse virtual: cursor sintético visible que se mueve, hace clic y escribe
 *   como una persona real (movimientos curvos, velocidad variable, ripple al hacer clic).
 * - Streaming en vivo: captura de fotogramas del navegador vía CDP (screencast)
 *   enviada por WebSocket al panel de observación (thumbnail + acciones en tiempo real).
 * - API para agentes: REST (control) + WS (observación).
 */

const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3000;
const VIEWPORT = { width: 1280, height: 800 };

// ---------------------------------------------------------------------------
// Estado global del "agente"
// ---------------------------------------------------------------------------
const state = {
  browser: null,
  context: null,
  page: null,
  cdp: null,
  screencasting: false,
  lastFrame: null,        // { data: base64, ts }
  cursor: { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 },
  log: [],                // historial de acciones del agente
  running: false,
  paused: false,
  agentTask: null,
};

const clients = new Set(); // conexiones WS del panel de observación

function pushLog(type, message, extra = {}) {
  const entry = {
    id: state.log.length + 1,
    ts: Date.now(),
    type,            // 'action' | 'info' | 'result' | 'error' | 'thinking'
    message,
    ...extra,
  };
  state.log.push(entry);
  if (state.log.length > 500) state.log.shift();
  broadcast({ kind: 'log', entry });
  console.log(`[${type}] ${message}`);
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ---------------------------------------------------------------------------
// Inyección del cursor virtual en la página (se reinyecta tras cada navegación)
// ---------------------------------------------------------------------------
const CURSOR_SCRIPT = `(() => {
  if (window.__agentCursorInstalled) return;
  window.__agentCursorInstalled = true;

  const styles = document.createElement('style');
  styles.textContent = \`
    #__agent_cursor {
      position: fixed; left: 0; top: 0; width: 24px; height: 24px;
      pointer-events: none; z-index: 2147483647;
      transition: transform 60ms linear;
      will-change: transform;
    }
    #__agent_cursor svg { display:block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); }
    #__agent_cursor.clicking svg { transform: scale(.82); }
    .__agent_ripple {
      position: fixed; width: 36px; height: 36px; border-radius: 50%;
      border: 3px solid rgba(0, 150, 255, .9); pointer-events: none;
      z-index: 2147483646; transform: translate(-50%, -50%);
      animation: __ag_pop .55s ease-out forwards;
    }
    .__agent_ripple.right { border-color: rgba(255, 120, 0, .9); }
    @keyframes __ag_pop {
      from { opacity: 1; width: 10px; height: 10px; }
      to   { opacity: 0; width: 64px; height: 64px; }
    }
    #__agent_label {
      position: fixed; left: 0; top: 0; pointer-events: none; z-index: 2147483647;
      background: #0b74ff; color: #fff; font: 600 11px/1.4 system-ui, sans-serif;
      padding: 2px 8px; border-radius: 10px; transform: translate(14px, 20px);
      box-shadow: 0 1px 4px rgba(0,0,0,.35); white-space: nowrap; opacity: 0;
      transition: opacity .2s;
    }
    #__agent_typing {
      position: fixed; left: 0; top: 0; pointer-events: none; z-index: 2147483647;
      background: rgba(20,20,20,.85); color: #7CFC00; font: 600 12px/1.4 monospace;
      padding: 4px 10px; border-radius: 8px; transform: translate(18px, -34px);
      max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      opacity: 0; transition: opacity .2s;
    }
  \`;
  document.documentElement.appendChild(styles);

  const cur = document.createElement('div');
  cur.id = '__agent_cursor';
  cur.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24">' +
    '<path d="M4 2 L4 20 L9 15.5 L12 22 L15 20.7 L12 14 L19 13.5 Z" ' +
    'fill="#0b74ff" stroke="white" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.documentElement.appendChild(cur);

  const label = document.createElement('div');
  label.id = '__agent_label';
  label.textContent = 'AGENTE';
  document.documentElement.appendChild(label);

  const typing = document.createElement('div');
  typing.id = '__agent_typing';
  document.documentElement.appendChild(typing);

  window.__agentCursor = {
    move(x, y) {
      cur.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      label.style.transform = 'translate(' + (x + 14) + 'px,' + (y + 20) + 'px)';
      typing.style.transform = 'translate(' + (x + 18) + 'px,' + (y - 34) + 'px)';
      label.style.opacity = '1';
      clearTimeout(window.__agentCursor._hideT);
      window.__agentCursor._hideT = setTimeout(() => { label.style.opacity = '0'; }, 2500);
    },
    click(x, y, button) {
      this.move(x, y);
      cur.classList.add('clicking');
      const r = document.createElement('div');
      r.className = '__agent_ripple' + (button === 'right' ? ' right' : '');
      r.style.left = x + 'px'; r.style.top = y + 'px';
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 600);
      setTimeout(() => cur.classList.remove('clicking'), 180);
    },
    showTyping(text) {
      typing.textContent = '\\u2328\\uFE0F escribiendo: "' + text.slice(-40) + '"';
      typing.style.opacity = '1';
      clearTimeout(this._tHide);
      this._tHide = setTimeout(() => { typing.style.opacity = '0'; }, 1200);
    },
  };
})();`;

async function injectCursor() {
  try {
    await state.page.evaluate(CURSOR_SCRIPT);
    await state.page.evaluate(
      ([x, y]) => window.__agentCursor && window.__agentCursor.move(x, y),
      [state.cursor.x, state.cursor.y]
    );
  } catch (e) { /* página puede estar navegando */ }
}

// ---------------------------------------------------------------------------
// Mouse virtual "humano": trayectorias curvas, velocidad variable, pausas
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

async function moveCursorTo(x, y, opts = {}) {
  const { steps = null, fast = false } = opts;
  const sx = state.cursor.x, sy = state.cursor.y;
  const dist = Math.hypot(x - sx, y - sy);
  const n = steps ?? Math.max(8, Math.min(40, Math.round(dist / 22)));

  // Punto de control aleatorio para trayectoria curva (Bézier cuadrática)
  const cx = (sx + x) / 2 + rand(-dist * 0.18, dist * 0.18);
  const cy = (sy + y) / 2 + rand(-dist * 0.18, dist * 0.18);

  for (let i = 1; i <= n; i++) {
    if (state.paused) while (state.paused) await sleep(300);
    const t = i / n;
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    const px = (1 - ease) ** 2 * sx + 2 * (1 - ease) * ease * cx + ease ** 2 * x;
    const py = (1 - ease) ** 2 * sy + 2 * (1 - ease) * ease * cy + ease ** 2 * y;
    try {
      await state.page.evaluate(
        ([X, Y]) => window.__agentCursor && window.__agentCursor.move(X, Y),
        [px, py]
      );
    } catch (e) { break; }
    if (!fast) await sleep(rand(6, 16));
    state.cursor.x = px; state.cursor.y = py;
  }
  state.cursor.x = x; state.cursor.y = y;
}

async function virtualClick(x, y, button = 'left') {
  await moveCursorTo(x, y);
  try {
    await state.page.evaluate(
      ([X, Y, B]) => window.__agentCursor && window.__agentCursor.click(X, Y, B),
      [x, y, button]
    );
  } catch (e) {}
  await sleep(rand(80, 160)); // micro-pausa humana antes del clic real
  await state.page.mouse.click(x, y, { button, delay: Math.round(rand(40, 110)) });
}

async function virtualType(text, opts = {}) {
  const { pressEnter = false, elementDesc = 'campo' } = opts;
  const chunkSize = 8;
  for (let i = 0; i < text.length; i += chunkSize) {
    if (state.paused) while (state.paused) await sleep(300);
    const chunk = text.slice(i, i + chunkSize);
    await state.page.keyboard.type(chunk, { delay: 0 });
    try {
      await state.page.evaluate(
        (t) => window.__agentCursor && window.__agentCursor.showTyping(t),
        text.slice(0, i + chunk.length)
      );
    } catch (e) {}
    await sleep(rand(40, 130)); // cadencia de tecleo humano
  }
  if (pressEnter) { await sleep(150); await state.page.keyboard.press('Enter'); }
}

async function getViewportPos(selectorOrPoint) {
  if (typeof selectorOrPoint === 'object' && selectorOrPoint !== null) {
    return selectorOrPoint;
  }
  const el = state.page.locator(selectorOrPoint).first();
  const box = await el.boundingBox({ timeout: 8000 });
  if (!box) throw new Error(`No se encontró caja para el selector: ${selectorOrPoint}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

// ---------------------------------------------------------------------------
// Screencast en vivo vía CDP
// ---------------------------------------------------------------------------
async function startScreencast() {
  if (state.screencasting || !state.cdp) return;
  state.screencasting = true;
  await state.cdp.send('Page.startScreencast', {
    format: 'jpeg', quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height,
    everyNthFrame: 1,
  });
}

async function attachCdp() {
  state.cdp = await state.context.newCDPSession(state.page);
  state.cdp.on('Page.screencastFrame', async (frame) => {
    state.lastFrame = { data: frame.data, ts: Date.now() };
    broadcast({ kind: 'frame', data: frame.data, ts: frame.timestamp });
    try { await state.cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }); } catch (e) {}
  });
  state.cdp.on('Page.screencastRequestFrame', () => {});
  state.page.on('framenavigated', (f) => {
    if (f === state.page.mainFrame()) {
      setTimeout(injectCursor, 150);
      pushLog('info', `Navegando a: ${f.url()}`);
    }
  });
}

async function reattachCdpForNewPage() {
  // si el agente abre pestaña nueva
  state.page.on('popup', async (p) => {
    try {
      await p.waitForLoadState('domcontentloaded');
      state.context = state.context; // mismo contexto
      pushLog('info', `Nueva pestaña abierta: ${p.url()}`);
    } catch (e) {}
  });
}

// ---------------------------------------------------------------------------
// Acciones de alto nivel expuestas por la API (las usa el agente)
// ---------------------------------------------------------------------------
// Acciones base (reciben SIEMPRE un objeto de parámetros ya normalizado)
const rawActions = {
    async goto({ url }) {
      if (!url) throw new Error('goto requiere "url"');
      pushLog('action', `Navegar a ${url}`);
      await state.page.goto(String(url).startsWith('http') ? url : 'https://' + url, {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });
      await sleep(400);
      await injectCursor();
      return { title: await state.page.title(), url: state.page.url() };
    },

    async click({ selector }) {
      if (!selector) throw new Error('click requiere "selector"');
      pushLog('action', `Clic en "${selector}"`);
      const pos = await getViewportPos(selector);
      await virtualClick(pos.x, pos.y);
      await sleep(300);
      return { clicked: selector, at: { x: Math.round(pos.x), y: Math.round(pos.y) } };
    },

    async doubleClick({ selector }) {
      if (!selector) throw new Error('doubleClick requiere "selector"');
      pushLog('action', `Doble clic en "${selector}"`);
      const pos = await getViewportPos(selector);
      await virtualClick(pos.x, pos.y);
      await sleep(rand(60, 120));
      await state.page.mouse.dblclick(pos.x, pos.y);
      return { doubleClicked: selector };
    },

    async rightClick({ selector }) {
      if (!selector) throw new Error('rightClick requiere "selector"');
      pushLog('action', `Clic derecho en "${selector}"`);
      const pos = await getViewportPos(selector);
      await virtualClick(pos.x, pos.y, 'right');
      return { rightClicked: selector };
    },

    async hover({ selector }) {
      if (!selector) throw new Error('hover requiere "selector"');
      pushLog('action', `Pasar el ratón sobre "${selector}"`);
      const pos = await getViewportPos(selector);
      await moveCursorTo(pos.x, pos.y);
      await state.page.mouse.move(pos.x, pos.y);
      return { hovered: selector };
    },

    async press({ key }) {
      if (!key) throw new Error('press requiere "key"');
      pushLog('action', `Tecla: ${key}`);
      await state.page.keyboard.press(key);
      return { key };
    },

    async screenshot({ name = 'shot' } = {}) {
      const buf = await state.page.screenshot({ type: 'png' });
      const file = path.join(__dirname, 'screenshots', `${name}-${Date.now()}.png`);
      require('fs').mkdirSync(path.dirname(file), { recursive: true });
      require('fs').writeFileSync(file, buf);
      pushLog('result', `Captura guardada: ${path.basename(file)}`);
      return { file };
    },

    async extractText({ selector = 'body' } = {}) {
      const txt = await state.page.evaluate((s) => {
        const el = document.querySelector(s) || document.body;
        return el.innerText.slice(0, 20000);
      }, String(selector));
      pushLog('result', `Texto extraído de "${selector}" (${txt.length} chars)`);
      return { text: txt };
    },

    // Elementos interactivos etiquetados — formato optimizado para agentes:
    // el agente ve una lista numerada tipo "set-of-marks".
    async interactiveElements({ limit = 60 } = {}) {
      const items = await state.page.evaluate((max) => {
        const sel = 'a,button,input,textarea,select,[role=button],[onclick],[tabindex]:not([tabindex="-1"])';
        const out = [];
        const nodes = Array.from(document.querySelectorAll(sel)).filter((el) => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
        });
        nodes.slice(0, max).forEach((el, i) => {
          const r = el.getBoundingClientRect();
          let label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
            el.getAttribute('title') || el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
          if (!label && el.tagName === 'A' && el.href) label = el.href.slice(0, 80);
          let cssid = el.id ? '#' + el.id : null;
          if (!cssid) {
            const tag = el.tagName.toLowerCase();
            const name = el.getAttribute('name');
            cssid = name ? `${tag}[name="${name}"]` : `${tag}:nth-of-type(${Array.from(el.parentElement?.children || []).filter(c => c.tagName === el.tagName).indexOf(el) + 1})`;
          }
          out.push({
            index: i,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || undefined,
            label,
            selector: cssid,
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
          });
        });
        return out;
      }, Number(limit) || 60);
      pushLog('result', `Analizados ${items.length} elementos interactivos`);
      return { elements: items, count: items.length };
    },

  async type({ selector, text, pressEnter = false, clear = true } = {}) {
    if (!selector || text == null) throw new Error('type requiere "selector" y "text"');
    pushLog('action', `Escribir "${String(text).slice(0, 60)}${String(text).length > 60 ? '…' : ''}" en "${selector}"`);
    const pos = await getViewportPos(selector);
    await virtualClick(pos.x, pos.y);          // foco con el mouse virtual
    await sleep(120);
    if (clear) {
      await state.page.keyboard.press('Control+a');
      await state.page.keyboard.press('Delete');
    }
    await virtualType(String(text), { pressEnter, elementDesc: selector });
    return { typed: text, into: selector };
  },

  async scroll({ direction = 'down', amount = 500 } = {}) {
    pushLog('action', `Desplazar ${direction} (${amount}px)`);
    const delta = direction === 'up' ? -amount : amount;
    await state.page.mouse.wheel(0, delta);
    await sleep(250);
    return { direction, amount };
  },

  async select({ selector, value } = {}) {
    if (!selector) throw new Error('select requiere "selector" y "value"');
    pushLog('action', `Seleccionar "${value}" en "${selector}"`);
    await state.page.selectOption(selector, value);
    return { selector, value };
  },

  async pageSummary() {
    const info = await state.page.evaluate(() => ({
      title: document.title,
      url: location.href,
      h1: (document.querySelector('h1')?.innerText || '').slice(0, 200),
      description: (document.querySelector('meta[name=description]')?.content || '').slice(0, 300),
      textPreview: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1500),
      linkCount: document.querySelectorAll('a').length,
    }));
    pushLog('result', `Resumen de página: "${info.title}"`);
    return info;
  },

  async back() { pushLog('action', 'Ir atrás'); await state.page.goBack(); await injectCursor(); return {}; },
  async forward() { pushLog('action', 'Ir adelante'); await state.page.goForward(); await injectCursor(); return {}; },
  async reload() { pushLog('action', 'Recargar'); await state.page.reload(); await injectCursor(); return {}; },
};

// Clave del argumento único para cada acción de un solo parámetro
const SINGLE_KEY = {
  goto: 'url', click: 'selector', doubleClick: 'selector', rightClick: 'selector',
  hover: 'selector', press: 'key', screenshot: 'name', extractText: 'selector',
  interactiveElements: 'limit',
};

// Normalizador: acepta {"action":"goto","params":{...}}, {"action":"goto","url":...}
// o incluso {"action":"goto","value":"..."} / string suelto.
function normalizeArgs(action, body) {
  const { action: _a, params, ...rest } = body || {};
  let args = (params && typeof params === 'object') ? { ...rest, ...params } : rest;
  if (!args.value && typeof args !== 'object') args = {};
  if ('value' in args && typeof args.value !== 'object') {
    const k = SINGLE_KEY[action];
    if (k && !(k in args)) args[k] = args.value;
    delete args.value;
  }
  return args;
}

async function runAction(action, body) {
  const fn = rawActions[action];
  if (!fn) throw new Error(`Acción desconocida: ${action}`);
  return fn(normalizeArgs(action, body));
}

// ---------------------------------------------------------------------------
// Demostración autónoma del agente (para ver el navegador trabajando solo)
// ---------------------------------------------------------------------------
async function runDemo() {
  if (state.running) { pushLog('error', 'El agente ya está ejecutándose'); return; }
  state.running = true;
  state.paused = false;
  pushLog('thinking', '🤖 Agente iniciado: tarea demo — buscar en DuckDuckGo información sobre agentes IA');
  try {
    await rawActions.goto('https://duckduckgo.com');
    await sleep(1200);
    pushLog('thinking', 'Localizando la caja de búsqueda…');
    await rawActions.type({ selector: 'input[name="q"], #search_input_home, input[type="search"]', text: 'AI agents browser automation', pressEnter: true });
    pushLog('thinking', 'Esperando resultados…');
    await sleep(3500);
    pushLog('thinking', 'Analizando los resultados de búsqueda…');
    const els = await rawActions.interactiveElements({ limit: 30 });
    const resultLink = els.elements.find((e) => e.tag === 'a' && /wikipedia|github|mdn/.test(e.label || '') ) ||
                       els.elements.filter((e) => e.tag === 'a').find((e) => (e.label || '').length > 15);
    if (resultLink) {
      pushLog('thinking', `Voy a abrir: "${resultLink.label}"`);
      await rawActions.click({ selector: resultLink.selector });
      await sleep(3000);
      const summary = await rawActions.pageSummary();
      pushLog('result', `Página abierta: ${summary.title}`);
    } else {
      pushLog('info', 'No hubo enlaces claros; tomo una captura del estado actual.');
      await rawActions.screenshot({ name: "demo" });
    }
    pushLog('thinking', '✅ Tarea demo completada.');
  } catch (e) {
    pushLog('error', `Error en la demo: ${e.message}`);
  } finally {
    state.running = false;
  }
}

// ---------------------------------------------------------------------------
// Servidor HTTP + API REST + Panel de observación
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ kind: 'hello', log: state.log.slice(-100), cursor: state.cursor }));
  if (state.lastFrame) ws.send(JSON.stringify({ kind: 'frame', data: state.lastFrame.data, ts: state.lastFrame.ts }));
  ws.on('close', () => clients.delete(ws));
});

// --- API para el agente -----------------------------------------------------
app.post('/api/action', async (req, res) => {
  const { action } = req.body || {};
  if (!rawActions[action]) return res.status(400).json({ ok: false, error: `Acción desconocida: ${action}` });
  try {
    const result = await runAction(action, req.body || {});
    res.json({ ok: true, action, result });
  } catch (e) {
    pushLog('error', `Fallo en "${action}": ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Batch: el agente puede enviar una secuencia de pasos atómicos
app.post('/api/batch', async (req, res) => {
  const { steps = [] } = req.body || {};
  const results = [];
  for (const s of steps) {
    if (!rawActions[s.action]) { results.push({ action: s.action, ok: false, error: 'desconocida' }); continue; }
    try { results.push({ action: s.action, ok: true, result: await runAction(s.action, { action: s.action, ...(s.params || s) }) }); }
    catch (e) { results.push({ action: s.action, ok: false, error: e.message }); break; }
  }
  res.json({ ok: true, results });
});

app.get('/api/state', (req, res) => {
  res.json({
    url: state.page?.url() || null,
    title: null,
    cursor: state.cursor,
    running: state.running,
    paused: state.paused,
    log: state.log.slice(-50),
    clients: clients.size,
  });
});

app.get('/api/frame', (req, res) => {
  if (!state.lastFrame) return res.status(404).json({ error: 'sin fotogramas' });
  res.json(state.lastFrame);
});

app.post('/api/demo/start', (req, res) => { runDemo(); res.json({ ok: true }); });
app.post('/api/pause', (req, res) => { state.paused = !state.paused; pushLog('info', state.paused ? 'Agente en pausa' : 'Agente reanudado'); res.json({ paused: state.paused }); });

// ---------------------------------------------------------------------------
// Arranque del navegador
// ---------------------------------------------------------------------------
(async () => {
  state.browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
  state.context = await state.browser.newContext({ viewport: VIEWPORT });
  state.page = await state.context.newPage();
  await attachCdp();
  reattachCdpForNewPage();
  await startScreencast();
  await state.page.goto('about:blank');
  await injectCursor();
  pushLog('info', `🌐 AgentBrowser listo — ventana ${VIEWPORT.width}x${VIEWPORT.height}. Panel: http://localhost:${PORT}`);
  await state.page.goto('https://example.com').catch(() => {});
  await injectCursor();

  server.listen(PORT, () => console.log(`Panel de observación: http://localhost:${PORT}`));

  // Auto-demo opcional
  if (process.env.AUTO_DEMO === '1') setTimeout(runDemo, 2000);

  const shutdown = async () => {
    try { await state.browser.close(); } catch (e) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})();
