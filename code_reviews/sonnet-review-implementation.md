# Umsetzung: Code Review `sonnet-review.md`

**Datum:** 2026-07-24
**Basis:** `code_reviews/sonnet-review.md` (Claude Sonnet 4.6, 2026-03-16)

Dieses Dokument hält fest, welche Findings umgesetzt wurden, welche bewusst verworfen wurden (mit Begründung), und welche Nebeneffekte beim Umsetzen aufgetaucht sind.

## Umgesetzt

### #1 — API-Key-Prüfung vor Konvertierung, Modul-Variable statt `process.env`-Re-Read
`app.post("/v1/messages", ...)` prüft `OPENAI_API_KEY` (Modul-Variable, gesetzt in `readEnvironmentVariables()`) jetzt als Erstes, vor `anthropicToOpenAI()` und vor dem Logging der eingehenden Anfrage. Die Route liest `process.env.A2O_OPENAI_API_KEY` nicht mehr selbst.

**Nebeneffekt:** Mehrere bestehende Tests (`streaming.test.js`, `toolUsage.test.js`, `error_paths.test.js`) setzten `A2O_OPENAI_API_KEY` bisher *nach* dem `require("../index")`-Aufruf und verliessen sich auf das alte Live-Re-Read-Verhalten. Da der Key jetzt beim Modul-Load in eine Variable eingelesen wird, mussten diese drei Testdateien so angepasst werden, dass die Env-Variable **vor** dem `require` gesetzt wird.

### #3 / #19 — `LOG_FILE`-Default auf opt-in umgestellt
`LOG_FILE` defaultet jetzt auf `null` statt `"messages.log"`. Ohne explizit gesetztes `A2O_LOG_FILE` wird nichts mitgeschnitten. README-Tabelle und Feature-Liste wurden entsprechend korrigiert (vorher stand in der Tabelle fälschlich `messages.log` als Default, im Fliesstext aber "opt-in" — beides ist jetzt konsistent).

**Verhaltensänderung:** Das Logging-Feature wurde erst im letzten Commit (`d29189e`) eingeführt und lief bisher standardmässig (Default-on). Mit diesem Fix ist es standardmässig aus (Default-off, wie ursprünglich in der Feature-Beschreibung dokumentiert). Da das Feature erst einen Commit alt ist, hängt vermutlich noch nichts von der alten Default-Logik ab.

### #7 — Warnung bei gesetztem, aber nicht weitergereichtem `top_k`
`anthropicToOpenAI()` loggt jetzt `console.warn(...)`, wenn `top_k` gesetzt ist. Der Wert wird weiterhin nicht an OpenAI weitergereicht (kein Äquivalent vorhanden).

### #8 — `tool_choice` wird jetzt gemappt
Neue Funktion `mapToolChoice()`: `auto→"auto"`, `any→"required"`, `tool→{type:"function",function:{name}}`, `none→"none"`.

**Guard ergänzt (über das Review hinaus):** `tool_choice` wird nur weitergereicht, wenn `tools` auch tatsächlich gesetzt sind. OpenAI lehnt `tool_choice` ohne `tools` mit einem 400 ab; ohne diesen Guard hätte ein Client, der bisher (mangels Mapping) folgenlos `tool_choice` ohne `tools` senden konnte, plötzlich einen Fehler bekommen.

### #15 — Model-Map: einzelne ungültige Einträge statt ganzer Map verwerfen
`A2O_MODEL_MAP`-Parsing behält jetzt gültige Einträge, auch wenn andere Einträge in derselben Map ungültig sind. Ungültige Einträge werden weiterhin geloggt (`console.error`).

### #17 — README: Hot-Restart lädt `.env` nicht neu
Abschnitt "Development mode (hot restart)" ergänzt um den Hinweis, dass Ctrl+R nur `process.env` neu einliest, nicht aber `.env`-Dateien.

## Bewusst nicht umgesetzt

### #2 — "Duplicate tool_use arguments" — **nicht reproduzierbar**
Das Review behauptet, beim Übergang von "unvollständigen" zu "vollständigen" Tool-Call-Infos (`blockIndex === null` → gesetzt) würden bereits gepufferte `arguments` sowohl geflusht als auch am Ende des Iterationsschritts nochmals angehängt.

Bei genauer Codeanalyse sind die beiden Pfade (`if (!toolCallAccum[idx])` für Erstanlage vs. `else` für Update) pro Chunk-Iteration gegenseitig exklusiv, und der abschliessende unbedingte Append (Zeile ~491 alt) verwendet ausschliesslich `tc.function.arguments` des **aktuellen** Chunks, nicht den bereits gepufferten `argsJson`-Wert. Ein gezielter Repro-Test (Chunk 1 puffert Teil-Argumente, Chunk 2 liefert `id`+`name`+weitere Argumente im selben Delta) zeigt korrektes, nicht-dupliziertes Verhalten:

```
partial_json: '{"query":"weather"'   // aus Chunk 1 geflusht
partial_json: ',"city":"NYC"}'       // aus Chunk 2 angehängt
```

Die Fixhistorie (`git log -- index.js`) zeigt mehrere frühere Review-Runden ("Fix remaining open issues from Kimi 2.5 code review" etc.) — der beschriebene Bug wurde vermutlich in einer davon bereits behoben, oder das Review-Modell hat den Kontrollfluss falsch gelesen. **Keine Code-Änderung vorgenommen**, um kein funktionierendes Verhalten zu regressieren.

### #5, #10, #12 (Low Priority)
Nicht umgesetzt — geringe Priorität, kein akuter Handlungsbedarf laut Review selbst (`content_filter`-Mapping, 50-MB-Limit, Funktionsbenennung `readEnvironmentVariables`).

## Zusätzlich gefundener Bug (nicht Teil des Reviews)

Beim Testen von #1 fiel auf: Die Request-Logging-Zeile (`messagesContent`-Konstruktion) lag **ausserhalb** des `try`-Blocks und crashte ungefangen (`.filter` auf einem nicht-Array `messages`-Feld, z. B. `messages: 123` oder `messages: [null]`). Da dies ein synchroner Wurf innerhalb einer `async`-Routen-Handler-Funktion ist, führte das nicht zu einer sauberen Fehlerantwort, sondern zu einer unbehandelten Promise-Rejection (Request bleibt hängen, keine Antwort an den Client).

**Fix:** Die Logging-Konstruktion wurde in den `try`-Block verschoben (nach der API-Key-Prüfung) und gegen Nicht-Array/`null`-Einträge abgesichert (`Array.isArray(...)`, `m && m.role === ...`). Ein verbleibender `null`-Eintrag in `messages` führt weiterhin zu einem Fehler in `anthropicToOpenAI()` selbst (dort gibt es keinen Null-Guard) — das ist jetzt aber ein sauberer, gefangener 500er statt eines hängenden Requests. Tests dafür: `test/message_route.test.js` ("returns a 500 error instead of hanging …").

## Testergebnis

`npx jest`: 8 Suiten, 57 Tests, alle grün. Coverage 89.7 % Statements / 79.5 % Branches / 80.6 % Funktionen / 90.7 % Lines — über den in `package.json` konfigurierten Schwellwerten (85/75/80/85).
