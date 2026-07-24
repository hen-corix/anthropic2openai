# Umsetzung: Code Review `opus-review.md`

**Datum:** 2026-07-24
**Basis:** `code_reviews/opus-review.md` (Claude Opus 4.8, 2026-07-24)

Dieses Dokument hält fest, welche Findings umgesetzt wurden, welche bewusst offengelassen wurden (mit Begründung), und wie die Tests angepasst/ergänzt wurden.

Auftrag: „die wichtigen Findings umsetzen sowie diejenigen, die wenig Aufwand erfordern".

## Umgesetzt

### K1 (Hoch) — Upstream-Timeout / Abort
`app.post("/v1/messages", …)` erstellt vor dem `fetch` einen `AbortController` und (bei `UPSTREAM_TIMEOUT_MS > 0`) einen `setTimeout`, der den Controller nach Ablauf abbricht; `signal` wird an `fetch` durchgereicht. Der Timer wird in einem neuen `finally`-Block wieder gelöscht. Ein Abbruch wird im `catch` als erster Zweig (`err.name === 'AbortError'`) erkannt und mit **HTTP 504** (`upstream_error`, „Upstream request timed out.") beantwortet. Der Timer bleibt auch während des Streamings scharf; feuert er mitten im Stream, fängt die bestehende `try/catch`-Logik in `streamOpenAIToAnthropic` den Lese-Fehler ab und sendet ein `error`-SSE-Event.

Konfigurierbar über `A2O_UPSTREAM_TIMEOUT_MS` (Default `600000` ms = 10 min, `0` deaktiviert). Bewusst grosszügig, um langsame Modelle nicht abzuschneiden, aber echte Hänger zu begrenzen.

### K2 (Hoch) — Bindung an Loopback statt alle Interfaces
`startServer()` bindet jetzt standardmässig an `127.0.0.1` statt implizit `0.0.0.0`. Konfigurierbar über `A2O_BIND_HOST`. Für Loopback-Hosts zeigt die Startlog-Zeile weiterhin `localhost` (menschenfreundlich, hält bestehende `ssl.test.js`-Erwartungen grün), für andere Hosts den konfigurierten Wert. README und `.env.example` um einen Security-Hinweis ergänzt: Der Proxy hat **keine** Client-Authentifizierung und nutzt den serverseitigen Key für jede Anfrage — daher Loopback-Default.

**Smoke-Test (echte Verbindung, nicht nur Log):** Da die Bindung auf `127.0.0.1` nur IPv4-Loopback bedient und `localhost` auf Windows teils zu `::1` (IPv6) auflöst, wurde ein realer Start + `curl` gemacht: `http://localhost:PORT/health` → 200, `http://127.0.0.1:PORT/health` → 200, `http://[::1]:PORT/health` → kein Connect. Der in der README dokumentierte `localhost`-Pfad verbindet also (der Client löst zu IPv4 auf bzw. fällt via Happy Eyeballs zurück). Bekannter Vorbehalt: Ein Client, der ausschliesslich IPv6-Loopback (`[::1]`) ohne IPv4-Fallback ansteuert, würde nicht verbinden — kein Client wird dorthin verwiesen. Falls das je auftritt: entweder Dual-Stack binden (`127.0.0.1` **und** `::1`) oder `A2O_BIND_HOST` explizit setzen.

### R2 (Mittel) — Kaputter Request-Body → Anthropic-Fehlerformat
Neue Express-Error-Middleware (4-Argument-Signatur) nach den Routen. Wandelt Body-Parse-Fehler (z. B. ungültiges JSON, `entity.too.large`) in `{type:"error", error:{type:"invalid_request_error", message:"Invalid request body."}}` mit **HTTP 400**. Vorher lieferte Express seinen HTML-Default, den Anthropic-Clients nicht parsen können.

### R3 (Niedrig) — `err.message` nicht mehr an den Client
Der generische 500er-Zweig gibt jetzt „Internal proxy error." statt `err.message` zurück; Details bleiben im Server-Log. Zwei bestehende Tests in `error_paths.test.js` (die auf `err.message` prüften) wurden entsprechend angepasst.

### S1 (Mittel) — SSE-Debug-Log nur noch opt-in
`sendSSE` loggt den vollen Event-Payload nur noch bei gesetztem `A2O_DEBUG_SSE`. Wichtig, weil `console.debug` in Node **kein** stummer Debug-Level ist, sondern ein `console.log`-Alias — vorher wurde der komplette Inhalt jedes Chunks unbedingt nach stdout geschrieben.

### S2 (Mittel) — Klartext-Gesprächsvorschau nur noch opt-in
Die Request-Log-Zeile schreibt die Inhaltsvorschau der Assistant-Messages nur noch bei gesetztem `A2O_DEBUG_REQUESTS`. Ohne Flag wird nur noch Metadaten geloggt (Methode, Pfad, Body-Grösse). Der bisher immer aktive Truncation-Indikator (`…`) wurde entfernt (Branch-Reduktion).

### C2 (Niedrig) — `tool_result.is_error` bleibt erhalten
Bei `is_error: true` wird dem `content` der OpenAI-`tool`-Message ein `"[tool error] "`-Präfix vorangestellt, damit die Fehlerinformation nicht verloren geht.

### C5 (Niedrig) — Leeres `stop_sequences`-Array
Bedingung von `if (body.stop_sequences)` auf `if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0)` verschärft. Ein leeres Array setzt jetzt kein leeres `stop` mehr, das manche Backends ablehnen.

### C1 (Mittel) — `temperature`-Skala dokumentiert (statt geändert)
Verhalten bewusst **nicht** geändert (1:1-Durchreichung beibehalten), aber die Abweichung (Anthropic 0–1 vs. OpenAI 0–2) ist jetzt in der README-Feature-Liste explizit als bekanntes Verhalten festgehalten. Rescaling wäre eine semantische Verhaltensänderung, die Clients überraschen könnte.

## Bewusst nicht umgesetzt

### R1 (Mittel) — Client-Disconnect bricht Upstream-Stream nicht ab
Sauber zu testen (simulierter Client-Disconnect während Streaming über supertest) ist aufwendig; ein ungetesteter `req/res.on("close")`-Handler würde die knappe Funktions-Coverage-Marge gefährden. Der neue `AbortController` (K1) bietet aber den Anknüpfungspunkt für eine spätere Umsetzung. Offen gelassen.

### R4 (Niedrig) — Doppelter Config-Read
Der Top-Level-Aufruf `readEnvironmentVariables()` (Modul-Load) ist für die Tests **essenziell**: Sie setzen `process.env` vor `require("../index")` und verlassen sich darauf, dass die Config beim Modul-Load in die Variablen eingelesen wird (die Route-Tests rufen nie `startServer()` auf). Entfernen würde die gesamte Suite brechen. Damit ist die scheinbare Redundanz begründet: Modul-Load bedient require-Zeit-Konsumenten (Tests, `app`), `startServer()` liest für den Hot-Restart erneut.

### R5 (Niedrig), S3 (Niedrig), C3 (Niedrig), C4, Q1–Q4
Geringe Priorität / kein akuter Handlungsbedarf bzw. rein kosmetisch. Nicht Teil dieses Durchgangs.

## Testanpassungen

- **`error_paths.test.js`**: 2 Tests auf generische 500er-Meldung angepasst; neuer Test „Upstream timeout (AbortError) → 504".
- **`conversion.test.js`**: neue Tests für base64-Bild-Source (deckt zudem eine bisher ungetestete Zeile), `tool_result.is_error`-Präfix, leeres `stop_sequences`-Array.
- **`ssl.test.js`**: neuer Test für Nicht-Loopback-Bind-Host (`A2O_BIND_HOST=0.0.0.0` → Log zeigt `0.0.0.0`).
- **`test/robustness.test.js`** (neu): kaputtes JSON → 400, `A2O_UPSTREAM_TIMEOUT_MS=0` deaktiviert Timer, `A2O_DEBUG_REQUESTS`-Vorschau, `A2O_DEBUG_SSE`-Ausgabe.

## Testergebnis

`npx jest`: 9 Suiten, 66 Tests, alle grün. Coverage **90.86 % Statements / 81.76 % Branches / 84.21 % Funktionen / 91.53 % Lines** — über den in `package.json` konfigurierten Schwellwerten (85/75/80/85) und in allen vier Metriken höher als vor den Änderungen (vorher 89.7 / 79.49 / 80.55 / 90.69).
