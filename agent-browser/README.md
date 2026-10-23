# 🤖 AgentBrowser — Navegador web diseñado para agentes de IA

Un navegador controlado por agentes donde un **mouse virtual** se mueve, hace clic y
escribe **como una persona real**, y un **panel de observación en vivo** muestra una
miniatura del navegador y toda la actividad del agente en tiempo real.

## Arquitectura

```
 Agente de IA (agente.py / REST API)          Persona que observa
        │  POST /api/action                       │  WebSocket /ws
        ▼                                         ▼
 ┌─────────────────────  server.js  ──────────────────────┐
 │  Mouse virtual humano  │  Screencast CDP  │  Log shared │
 └──────────────┬──────────────────┬──────────────────────┘
               ▼                  ▼
       Chromium (Playwright)   Panel web (public/index.html)
                               · vista en vivo + miniaturas
                               · feed de acciones en tiempo real
```

- **Motor**: Playwright + Chromium (headless), ventana 1280×800.
- **Mouse virtual**: cursor sintético inyectado en la página con trayectoria Bézier curva,
  velocidad variable, ripple al hacer clic, burbuja "AGENTE" y aviso de tecleo: la persona
  que observa ve exactamente lo que haría un humano.
- **Optimizado para agentes**: API de percepción estructurada (`interactiveElements` con
  índices tipo *set-of-marks*, `pageSummary`, `extractText`) + ejecución por lotes (`/api/batch`).
- **Observación en tiempo real**: streaming de fotogramas vía CDP screencast por WebSocket,
  con miniaturas históricas cada 2 s, contador de FPS, posición del cursor y feed de
  "pensamiento/acción/resultado" del agente.

## Instalación

```bash
cd agent-browser
npm install
npx playwright install chromium --with-deps
```

## Uso

### 1. Arrancar el navegador + panel de observación

```bash
node server.js                 # panel en http://localhost:3000
AUTO_DEMO=1 node server.js     # además ejecuta una demo autónoma del agente al arrancar
```

Abre **http://localhost:3000** verás:
- La **vista en vivo** del navegador (con el mouse virtual moviéndose).
- **Miniaturas** recientes (clic para revisarlas).
- El **feed de actividad del agente** en tiempo real (piensa → actúa → resultado).
- Botones ▶ demo y ⏸ pausa.

### 2. Controlarlo desde un agente (Python)

```python
from agente import AgentBrowserClient

ab = AgentBrowserClient("http://localhost:3000")
ab.goto("https://duckduckgo.com")
print(ab.list_elements())                      # percepción estructurada
ab.type('input[name="q"]', "agentes IA", enter=True)   # el mouse virtual escribe solo
print(ab.summary())
```

O por CLI:

```bash
python agente.py demo
python agente.py goto https://example.com
python agente.py elements
python agente.py click "#some-button"
```

### 3. API REST cruda (para cualquier lenguaje/framework de agentes)

```bash
# Una acción
curl -X POST localhost:3000/api/action -H 'Content-Type: application/json' \
     -d '{"action":"goto","url":"https://news.ycombinator.com"}'

curl -X POST localhost:3000/api/action -H 'Content-Type: application/json' \
     -d '{"action":"click","selector":"a[href*=github]"}'

curl -X POST localhost:3000/api/action -H 'Content-Type: application/json' \
     -d '{"action":"type","selector":"input[name=q]","text":"hola","pressEnter":true}'

# Secuencia atómica por lotes
curl -X POST localhost:3000/api/batch -H 'Content-Type: application/json' \
     -d '{"steps":[{"action":"goto","params":{"url":"https://example.com"}},
                   {"action":"screenshot","params":{"name":"evidencia"}}]}'

# Estado actual (URL, cursor, log)
curl localhost:3000/api/state
```

### Acciones disponibles

| Acción | Parámetros | Descripción |
|---|---|---|
| `goto` | `url` | Navegar |
| `click` / `doubleClick` / `rightClick` | `selector` | Clic con el mouse virtual (trayectoria humana) |
| `hover` | `selector` | Mover el cursor sobre un elemento |
| `type` | `selector, text, pressEnter?, clear?` | Clic para enfocar + tecleo con cadencia humana |
| `press` | `key` | Tecla especial |
| `scroll` | `direction, amount` | Rueda del ratón |
| `select` | `selector, value` | `<select>` |
| `screenshot` | `name` | Captura PNG a disco |
| `extractText` | `selector?` | Texto de la página |
| `interactiveElements` | `limit?` | Lista numerada de elementos accionables (percepción de agente) |
| `pageSummary` | — | Título, H1, descripción, preview |
| `back` / `forward` / `reload` | — | Navegación |

## Cómo se comunica el agente con las aplicaciones

El agente no usa hooks internos del sitio: interactúa igual que una persona —
el **mouse virtual mueve el cursor hasta el objetivo, hace clic, espera, teclea con
ritmo humano** y luego *percibe* el resultado (`pageSummary`, `interactiveElements`,
capturas). Todo queda transmitido en vivo al panel, de modo que un humano puede
auditar cada movimiento del agente mientras ocurre.
