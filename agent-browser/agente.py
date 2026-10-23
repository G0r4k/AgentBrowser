"""
agente.py — Cliente Python para que un agente de IA controle AgentBrowser.

Uso:
    from agente import AgentBrowserClient

    ab = AgentBrowserClient("http://localhost:3000")
    ab.goto("https://duckduckgo.com")
    ab.list_elements()            # visión estructurada de la página
    ab.type('input[name="q"]', "hola mundo", enter=True)
    ab.click("a.result__a")
    print(ab.summary())

También como CLI:
    python agente.py demo
    python agente.py goto https://example.com
    python agente.py elements
"""
import json
import sys
import urllib.request


class AgentBrowserClient:
    def __init__(self, base_url="http://localhost:3000"):
        self.base = base_url.rstrip("/")

    # ------------------------------------------------------------------ núcleo
    def _action(self, action, **params):
        body = json.dumps({"action": action, **params}).encode()
        req = urllib.request.Request(
            f"{self.base}/api/action", data=body,
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=60) as r:
            out = json.loads(r.read())
        if not out.get("ok"):
            raise RuntimeError(out.get("error", "fallo desconocido"))
        return out["result"]

    def batch(self, steps):
        """steps: [{"action": "goto", "params": {"url": "..."}}, ...]"""
        body = json.dumps({"steps": steps}).encode()
        req = urllib.request.Request(
            f"{self.base}/api/batch", data=body,
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())["results"]

    # ----------------------------------------------------------------- acciones
    def goto(self, url):        return self._action("goto", url=url)
    def click(self, selector):  return self._action("click", selector=selector)
    def double_click(self, selector): return self._action("doubleClick", selector=selector)
    def right_click(self, selector):  return self._action("rightClick", selector=selector)
    def hover(self, selector):  return self._action("hover", selector=selector)

    def type(self, selector, text, enter=False, clear=True):
        return self._action("type", selector=selector, text=text,
                            pressEnter=enter, clear=clear)

    def press(self, key):       return self._action("press", key=key)
    def scroll(self, direction="down", amount=500):
        return self._action("scroll", direction=direction, amount=amount)
    def select(self, selector, value):
        return self._action("select", selector=selector, value=value)
    def screenshot(self, name="agent"): return self._action("screenshot", name=name)
    def extract_text(self, selector="body"):
        return self._action("extractText", selector=selector)["text"]
    def back(self):   return self._action("back")
    def forward(self):return self._action("forward")
    def reload(self): return self._action("reload")

    # ------------------------------------------------------------- percepción
    def elements(self, limit=60):
        return self._action("interactiveElements", limit=limit)["elements"]

    def list_elements(self, limit=60):
        """Versión legible para el agente (texto compacto tipo 'set-of-marks')."""
        els = self.elements(limit)
        lines = []
        for e in els:
            label = e["label"] or "(sin etiqueta)"
            lines.append(f'[{e["index"]:>2}] <{e["tag"]}{("/" + e["type"]) if e.get("type") else ""}> '
                         f'"{label[:60]}"  →  {e["selector"]}  @({e["x"]},{e["y"]})')
        return "\n".join(lines)

    def summary(self):
        s = self._action("pageSummary")
        return (f"Título : {s['title']}\nURL    : {s['url']}\n"
                f"H1     : {s['h1']}\nDesc   : {s['description']}\n"
                f"Texto  : {s['textPreview'][:600]}…")

    def state(self):
        with urllib.request.urlopen(f"{self.base}/api/state", timeout=10) as r:
            return json.loads(r.read())


# ---------------------------------------------------------------------------
# Mini-agente demo con bucle percepción→razonamiento→acción
# ---------------------------------------------------------------------------
def demo():
    ab = AgentBrowserClient()
    print("→ Abriendo DuckDuckGo…"); ab.goto("https://duckduckgo.com")
    print("→ Elementos visibles:\n" + ab.list_elements(15))
    print("→ Escribiendo búsqueda…")
    ab.type('input[name="q"], input[type="search"]', "AgentBrowser navegador para agentes IA", enter=True)
    import time; time.sleep(4)
    print("→ Resultados:\n" + ab.list_elements(20))
    print("→ Resumen de página:\n" + ab.summary())
    print("✅ Demo del agente completada — mira el panel en http://localhost:3000")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(__doc__); sys.exit(0)
    cmd, ab = args[0], AgentBrowserClient()
    if cmd == "demo":
        demo()
    elif cmd == "goto":
        print(ab.goto(args[1]))
    elif cmd == "elements":
        print(ab.list_elements())
    elif cmd == "summary":
        print(ab.summary())
    elif cmd == "click":
        print(ab.click(args[1]))
    elif cmd == "type":
        print(ab.type(args[1], args[2], enter=(len(args) > 3 and args[3] == "--enter")))
    else:
        print("comando desconocido:", cmd)
