# Locale Jacket

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Deutsch** · [Français](README.fr.md) · [Español](README.es.md) · [Русский](README.ru.md) · [Português (Brasil)](README.pt-BR.md)

> Dies ist eine Übersetzung der englischen README. Bei Abweichungen gilt die [englische Fassung](../../README.md); dort finden Sie auch die Entwickler- und Technikdetails.

Locale Jacket ist eine Chrome-/Edge-Erweiterung (Manifest V3), die Websites **pro Website** ein anderes Browser-Gebietsschema zeigt (zum Beispiel `en-US` auf google.com und `ja-JP` auf apple.com), während die UI-Sprache des Browsers selbst unverändert bleibt.

Sie automatisiert, was **DevTools ▸ Sensoren ▸ Gebietsschema** tut, und wendet es auf jeden passenden Tab an, ohne dass DevTools geöffnet sein muss. Die Regeln funktionieren wie bei Clash, sing-box oder Shadowrocket: `DOMAIN`, `DOMAIN-SUFFIX`, `DOMAIN-KEYWORD`, `DOMAIN-REGEX`, `GEOSITE`, `IP-CIDR`, `IP-CIDR6`, `IP-ASN` und `GEOIP`, mit `SYSTEM`/`DIRECT`-Ausnahmen und einer Standardaktion.

## Funktionen

| Was eine Website sieht | Wie es vorgetäuscht wird | Reichweite |
|---|---|---|
| `Intl.*` (DateTimeFormat, NumberFormat, Collator, `toLocaleString` …) | `Emulation.setLocaleOverride` | Seite, Frames derselben und fremder Websites, dedizierte Worker |
| `navigator.language`, `navigator.languages` | `Emulation.setUserAgentOverride` **nur** mit `acceptLanguage` (User-Agent und Client Hints bleiben unverändert) | Seite, Frames, dedizierte Worker |
| HTTP `Accept-Language` | Dieselbe Überschreibung, plus `declarativeNetRequest` für die erste Dokumentanfrage | Dokumente, Unterressourcen, `fetch()`, Worker-Anfragen |
| Zeitzone, Standort | **Standardmäßig aus**, pro Regel aktivierbar | Seite und Frames |

- Es werden keine JavaScript-APIs der Seite verändert; nur Chromes eigene Emulation wird genutzt.
- Alles läuft lokal: kein Server, kein Konto, keine Telemetrie.
- Die Oberfläche gibt es in 10 Sprachen (siehe unten).

## Installation

**Aus einem Release (empfohlen)**
1. Laden Sie auf der GitHub-Seite *Releases* die Datei `locale-jacket-<Version>.zip` herunter und entpacken Sie sie.
2. Öffnen Sie `chrome://extensions` (Edge: `edge://extensions`), aktivieren Sie den **Entwicklermodus**, klicken Sie auf **Entpackte Erweiterung laden** und wählen Sie den entpackten Ordner.
3. Pinnen Sie die Erweiterung an: Das Badge (zum Beispiel `EN` oder `JA`) zeigt das Profil des aktuellen Tabs. Für private Fenster aktivieren Sie auf der Detailseite der Erweiterung **Im Inkognitomodus zulassen**.

**Aktualisieren:** Für einen entpackten Ordner der Vorversion gibt es `locale-jacket-<alt>-to-<neu>.diff.zip`. Es enthält nur die hinzugefügten oder geänderten Dateien: über den alten Ordner kopieren, die in `DELETED.txt` aufgeführten Dateien löschen (falls vorhanden) und die Erweiterung neu laden. Erweiterungs-ID und Einstellungen bleiben erhalten.

**`.crx`-Datei:** mit demselben Schlüssel signiert (ID `jenefdmhnbfepiohiplfobageceacokb`). Chrome und Edge installieren `.crx`-Dateien außerhalb ihrer Stores jedoch nur, wenn eine Unternehmensrichtlinie es erlaubt. Für den privaten Gebrauch ist **Entpackte Erweiterung laden** der richtige Weg.

**Aus dem Quellcode:** Node.js 20+ wird benötigt. `npm install` und `npm run build` ausführen und den erzeugten Ordner `dist/` laden. Unterstützt Chrome/Edge ab 125 (entwickelt und getestet mit 155).

**Regeln beim ersten Start:** Bei einer Neuinstallation liest die Erweiterung `presets/default-rules.yaml` aus ihrem Ordner (gleiches Format wie *Import / Export*). Bearbeiten Sie die Datei vor dem Laden, um mit eigenen Regeln zu beginnen. Die `.crx` enthält diese Datei nicht und erzeugt dieselbe Beispielvorgabe selbst.

## Standardregeln

| Regel | Ergebnis |
|---|---|
| `DOMAIN-SUFFIX,google.com` | `en-US` |
| `DOMAIN-SUFFIX,openai.com` | `en-US` |
| `DOMAIN-SUFFIX,apple.com` | `ja-JP` |
| `DOMAIN-SUFFIX,yahoo.co.jp` | `ja-JP` |
| `DOMAIN,accounts.google.com` | `SYSTEM` (echtes Gebietsschema) |
| Standard | `SYSTEM` |

Sie können sie im Popup oder auf der Optionsseite beliebig ändern oder löschen.

## Debugging-Leiste

Solange ein Tab gespooft wird, zeigt Chrome **„Locale Jacket hat mit dem Debugging dieses Browsers begonnen“**. Das ist Chromes Sicherheitshinweis für die `chrome.debugger`-API; die Erweiterung blendet ihn nicht aus. Ein Klick auf **Abbrechen** pausiert Locale Jacket, bis Sie im Popup auf **Fortsetzen** klicken.

Wenn Sie den Sicherheitskompromiss akzeptieren, kann [`tools/chrome-banner-flag.ps1`](../../tools/chrome-banner-flag.ps1) (Windows) Chrome den Startschalter `--silent-debugger-extension-api` hinzufügen. Damit wird der Hinweis für **alle** Erweiterungen mit Debugger-Berechtigung ausgeblendet. Details in der [englischen README](../../README.md#hiding-the-debugging-banner-optional).

## Verwendung

**Popup** (Symbolleiste): globaler Schalter; zutreffende Regel, Profil und Status des aktuellen Tabs; „Prüfen, was die Seite sieht“; Regel für die aktuelle Website anlegen oder ändern; Standard für alle anderen Websites.

**Optionsseite:**
- **Regeln:** aktivieren / deaktivieren, sortieren, bearbeiten, löschen; Duplikate, Konflikte und überflüssige Regeln werden markiert.
- **Testen & prüfen:** Hostname eingeben und sehen, welche Regeln warum greifen, oder prüfen, was ein offener Tab tatsächlich meldet.
- **Import / Export:** JSON oder YAML, ersetzen oder zusammenführen.
- **Datensätze:** GeoSite-/GeoIP-/ASN-Daten herunterladen, importieren und automatisch aktualisieren.
- **Einstellungen:** Anzeigesprache, Frame-Modus und mehr.
- **Sitzungen & Protokoll:** Tabs im Debugging und ein Aktivitätsprotokoll im Arbeitsspeicher.

## Regeln

```yaml
rules:
  - type: DOMAIN-SUFFIX        # google.com und alle Subdomains (an Label-Grenzen)
    domain: google.com
    locale: en-US
  - type: DOMAIN               # nur genau dieser Hostname
    domain: accounts.google.com
    action: SYSTEM             # echtes Browser-Gebietsschema behalten (DIRECT ist ein Alias)
  - type: DOMAIN-KEYWORD       # Hostname enthält den Text
    keyword: microsoft
    locale: en-GB
  - DOMAIN-SUFFIX,yahoo.co.jp,ja-JP   # Kurzform im Clash-Stil geht auch
  - GEOSITE,google,en-US              # benötigt den GeoSite-Datensatz
  - IP-CIDR,17.0.0.0/8,en-US          # Serveradresse im Bereich
  - GEOIP,LAN,SYSTEM                  # private Adressen, keine Daten nötig
default:
  mode: SYSTEM                 # oder: mode: PROFILE + locale/languages/…
```

**Rangfolge** (deterministisch; der erste Unterschied entscheidet):
1. Regeltyp: `DOMAIN` › `DOMAIN-SUFFIX` › `DOMAIN-KEYWORD` › `DOMAIN-REGEX` › `GEOSITE` › `IP-CIDR`/`IP-CIDR6` › `IP-ASN` › `GEOIP`. Hostnamen-Regeln schlagen immer IP-Regeln.
2. Innerhalb eines Typs gewinnt die spezifischste (Suffix mit den meisten Labels, IP-Bereich mit dem längsten Präfix).
3. Höhere `priority` gewinnt.
4. Frühere Position in der Liste gewinnt.
5. Der Standard gilt nur, wenn nichts zutrifft.

Daher überstimmt `DOMAIN,accounts.google.com → SYSTEM` stets `DOMAIN-SUFFIX,google.com → en-US`, unabhängig von der Reihenfolge.

## Regel-Abonnements

*Optionen ▸ Abonnements* lädt Regeln aus JSON- oder YAML-Dateien im Internet (im Format von *Import / Export*) und hält sie aktuell: sofort nach dem Hinzufügen, danach täglich (oder wöchentlich, monatlich, nie), mit bedingten Anfragen. Links auf die Seite einer Datei bei GitHub (`github.com/…/blob/…`) oder auf einen Gist werden in die Rohdatei umgewandelt; eine Adresse, die eine Webseite liefert, wird mit einer Erklärung abgelehnt. Abonnement-Regeln werden getrennt von Ihren eigenen gespeichert und nur angezeigt: Ihre eigenen Regeln haben immer Vorrang, unter Abonnements gewinnt das höher stehende. Aus einer Datei wird nur `rules` gelesen; ungültige Einträge werden übersprungen. Brauchen Abonnement-Regeln GeoSite, GeoIP oder ASN und fehlt der Datensatz, wird er automatisch heruntergeladen – von der Adresse, die die Datei unter `datasets:` nennt, sonst von der Standardadresse.

## Datensätze und automatische Updates

`GEOSITE`-, `GEOIP`-Länder- und `IP-ASN`-Regeln brauchen Datendateien. Es wird nichts heruntergeladen, solange Sie es nicht verlangen: unter *Optionen ▸ Datensätze* von einer editierbaren URL herunterladen oder eine lokale Datei importieren.

**Automatische Updates** (optional, standardmäßig aus): heruntergeladene Datensätze beim Browserstart und/oder täglich, wöchentlich oder monatlich prüfen. Ein **Mindestabstand** (Standard 24 h, 1–720 h) erlaubt pro Datensatz nur einen automatischen Versuch je Zeitraum, fehlgeschlagene eingeschlossen; Browser-Neustarts führen so nie zu wiederholten Downloads. Anfragen sind bedingt, eine unveränderte Datei wird nicht erneut geladen. Importierte Dateien werden nie automatisch aktualisiert.

IP-Regeln verwenden die Adresse, mit der Chrome tatsächlich verbunden war; die Erweiterung macht keine DNS-Abfragen.

## Anzeigesprache

Popup und Optionsseite gibt es auf English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español, Русский und Português (Brasil). Standardmäßig folgen sie der UI-Sprache des Browsers; ändern lässt sie sich unter *Optionen ▸ Einstellungen ▸ Anzeigesprache*. Das ändert nie, was Websites sehen.

## Updates

Die installierte Version steht neben dem Titel im Pop-up und unten in der Seitenleiste der Optionen. *Optionen ▸ Updates* sucht nach einer neueren Version – nur wenn Sie auf **Jetzt prüfen** klicken oder automatische Prüfungen einschalten (standardmäßig aus, höchstens alle 12 Stunden), und nur bei der dort angezeigten Release-Adresse. Wird eine neuere Version gefunden, zeigt das Pop-up einen Hinweis und die Seite die Versionshinweise, Download-Links (Diff-Paket, Zip, Crx) und die Schritte zum Aktualisieren. Chrome aktualisiert einen entpackten Ordner nie selbst: Kopieren Sie die neuen Dateien über den Ordner und klicken Sie auf **Erweiterung neu laden**. Solange das GitHub-Repository privat ist, antwortet GitHub mit 404; die Seite erklärt das.

## Datenschutz und Berechtigungen

Alles läuft lokal. Außer Datensatz-Downloads, die Sie unter *Datensätze* starten, und automatischen Updates, die Sie dort aktivieren (jeweils von der angezeigten URL), Update-Prüfungen, die Sie unter *Updates* starten oder einschalten (nur an die angezeigte Release-Adresse), sowie den Abonnements, die Sie unter *Abonnements* hinzufügen (an deren Adressen, dazu die Datensätze, die ihre Regeln benötigen), stellt die Erweiterung keine Netzwerkanfragen. Regeln liegen in `chrome.storage.local`; das Aktivitätsprotokoll existiert nur im Arbeitsspeicher und enthält nur Hostnamen.

Berechtigungen: `debugger` (die Emulation selbst), `webNavigation` und Hostzugriff, `declarativeNetRequestWithHostAccess` (Accept-Language der ersten Anfrage), `webRequest` (Serveradressen für IP-Regeln und ob ein Seitenaufruf gefahrlos neu gestartet werden kann; nur beobachtend), `alarms` (geplante Prüfung auf Datensatz- und Erweiterungs-Updates, nur wenn aktiviert), `storage`.

## Grenzen

- Die Debugging-Leiste kann die Erweiterung nicht ausblenden (siehe oben).
- `chrome://`- und `edge://`-Seiten, die Neuer-Tab-Seite, Web Stores und per Richtlinie blockierte Websites können nicht debuggt werden.
- Beim direkten Eintippen einer URL in einen neuen Tab sehen die ersten Skripte eventuell das echte Gebietsschema; der HTTP-Header stimmt trotzdem, und die Seite kann einmal automatisch neu geladen werden.
- Pro Renderer-Prozess gibt es nur ein Intl-Gebietsschema; Prozesse mit verschiedenen Profilen werden als „Teilweise“ angezeigt.
- Service Worker und Shared Worker werden nicht überschrieben.

Mehr in [docs/LIMITATIONS.md](../LIMITATIONS.md), Hilfe bei Problemen in [docs/TROUBLESHOOTING.md](../TROUBLESHOOTING.md) (Englisch).

## Lizenz

GPL-3.0, siehe [LICENSE](../../LICENSE).
