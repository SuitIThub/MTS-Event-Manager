# MTS Capture – StudioNeoV2-Plugin (Plan, umgesetzt — siehe README.md)

Ziel: Screenshots aus StudioNeoV2 ohne Umwege den **fehlenden Bildern** des Events zuordnen, das gerade im
VS-Code-Event-Editor offen ist. Das Plugin kopiert das Bild in den Zielordner des Events und benennt es
richtig um.

---

## 1. Architektur

```
VS Code (MTS Event Manager)                      StudioNeoV2 (BepInEx-Plugin „MTS Capture“)
──────────────────────────                       ─────────────────────────────────────────
Event-Editor: aktives Event                      Toolbar-Button → kleines Fenster (IMGUI)
   │  Event-Check (Coverage)                        │
   ▼                                                │ liest / beobachtet
capture/active-event.json  ◄──── Brücke (Datei) ────┘
   ▲                                                │ beobachtet (FileSystemWatcher)
   │ Bilder-Ordner ändert sich                      ▼
   └─ Extension prüft neu, schreibt JSON neu     Screenshot-Ordner (F1-Einstellung)
                                                    │ „Zuweisen“
                                                    ▼
                                                 game/images/events/<event>/<name>.png
```

- **Keine Netzwerk-Verbindung**, nur eine JSON-Datei. Beide Seiten nutzen standardmäßig denselben Pfad:
  `%LOCALAPPDATA%\MTS-Event-Manager\capture\active-event.json`. Der Pfad ist auf beiden Seiten
  einstellbar.
- Die **Extension** bleibt die einzige Stelle, die das Spiel versteht: Muster, Selektoren, Bedingungen,
  Level-Grenzen, `$`-Wildcards und `data`-Werte. Das Plugin rechnet nichts davon nach. Es bekommt eine
  fertige Liste von Zielen mit **absolutem Zielpfad**.
- Das **Plugin** ist bewusst „dumm“: anzeigen, sortieren, kopieren.

## 2. Teil A – Extension (TypeScript, dieses Repo)

1. Wenn im Event-Editor ein Event aktiv ist, schreibt die Extension nach einer Änderung
   `active-event.json`. Auslöser sind: Event gewechselt, Datei gespeichert, Bildordner geändert oder ein
   Befehl. Die Grundlage ist die vorhandene Event-Check-Coverage.
2. Neue Einstellung `mtsEventManager.capture.bridgeFile` (leer = Standardpfad) und
   `mtsEventManager.capture.enabled`.
3. Die Extension beobachtet die Bildordner des Events. Legt das Plugin ein Bild ab, prüft die Extension
   neu, und das Ziel verschwindet aus der Liste.
4. Format (Entwurf):

```json
{
  "version": 1,
  "written": "2026-09-26T12:00:00Z",
  "event": "truth_or_dare_2",
  "file": "game/scripts/events/truth_or_dare.rpy",
  "keys": ["school_level", "step"],
  "keyValues": { "school_level": ["1","2","…","10"], "step": ["0","…","8"] },
  "targets": [
    {
      "id": "main|0|school_level=8",
      "pattern": "main",
      "step": 0,
      "values": { "school_level": "8", "step": "0" },
      "status": "missing",
      "path": "M:/…/game/images/events/truth_or_dare/truth_or_dare_2/truth_or_dare_2 8 0.png",
      "lines": [131],
      "hint": "Step 0 · show_image"
    }
  ]
}
```

- `status`: `missing`. Optional kommt `wildcard` dazu: vorhanden nur über eine `$`-Datei, könnte also
  spezifischer werden. Die Wildcard-Ziele sind per Plugin-Filter zuschaltbar.
- Videos (`show_video`) werden **nicht** gelistet, weil Screenshots nur Standbilder sind.
- Der `path` endet auf **`.png`**. Das passt zur bestehenden Pipeline (Image Converter/NConvert: PNG in
  `game/images` → WEBP), und die Engine lädt PNG auch direkt.

## 3. Teil B – Plugin (C#, neuer Ordner `studio-capture/`)

- **Technik:** BepInEx 5-Plugin, `net46`, gebaut mit dem SDK-Stil-csproj.
  - Die Referenzen (UnityEngine, Assembly-CSharp, BepInEx, KKAPI) kommen über die Property `GamePath`
    aus der eigenen Installation und werden nicht ins Repo eingecheckt.
  - Es baut mit dem installierten .NET 9 SDK.
- **Toolbar-Button** in StudioNeoV2 über KKAPI (`CustomToolbarButtons`). Er öffnet und schließt das
  Fenster.
- **F1 / ConfigurationManager:**
  - Screenshot-Ordner (Standard: `UserData/cap`)
  - Pfad der Brücken-Datei
  - nur neue Dateien seit Fensteröffnung
  - Wildcard-Ziele zeigen (an/aus)
  - Original nach Zuweisung: behalten / löschen / in `assigned/` verschieben
  - Hotkey zum Bestätigen
- **Fenster** (klein, verschiebbar, Größe begrenzt):
  1. Kopf: Event-Name, „x von y fehlend“, Zeitstempel der Brücke. Ist die Brücke älter als die letzte
     Änderung, erscheint ein Hinweis.
  2. **Reihenfolge der Parameter:** kleine Liste der Keys (z. B. `school_level`, `uniform`, `step`) mit ▲▼.
     - Prio 1 ist die äußerste Schleife. Beispiel „Level vor Uniform“: alle Uniformen für Level 1, dann
       alle für Level 2, …
     - `step` ist ein normaler Key und frei einsortierbar.
     - Die Reihenfolge wird pro Event gespeichert.
  3. **Neuester Screenshot:** Vorschau-Thumbnail. Kommt ein neues Bild, wird es automatisch das aktuelle.
  4. **Ziel:** Standardmäßig das nächste fehlende Ziel in der gewählten Reihenfolge. Mit ◀ ▶ blättert man,
     über eine kompakte scrollbare Liste wählt man direkt, und ein Filter pro Key ist möglich (z. B. nur
     Level 3).
  5. **„Zuweisen“:** Das Bild wird in den Zielpfad kopiert, fehlende Ordner werden angelegt. Das Ziel
     wird lokal als erledigt markiert und das nächste Ziel gewählt.
  6. **„Rückgängig“:** macht die letzte Zuweisung dieser Sitzung rückgängig, indem die kopierte Datei
     entfernt wird.
- **Sicherheit:**
  - Geschrieben wird nur, wenn der Zielpfad unter `…/game/images/` oder `…/game/mods/<Mod>/images/`
    liegt.
  - Eine bestehende Datei wird **nie** still überschrieben: Es gibt eine Rückfrage, und Standard ist
    „nein“.
  - Pfade aus der JSON werden normalisiert. `..` wird abgelehnt.
- **Log** in der BepInEx-Konsole plus eine kleine Zeile „Zuletzt: … → …“ im Fenster.

## 4. Entscheidungen (2026-09-26)

1. Spiel: **Honey Select 2** (StudioNEOV2), KKAPI/HS2API installiert, Installation unter `D:\Honey Select`.
2. Format: **PNG behalten**, keine Konvertierung durch das Plugin.
3. Screenshots entstehen bereits in Zielgröße. Weicht ein Bild von **1920×1080** ab (einstellbar), zeigt
   das Fenster eine **Warnung** am Zuweisen-Button.
4. Modi: **Alle Bilder** und **Nur fehlende**. **$-Bilder** sind eine zusätzliche, abschaltbare Option;
   $-Ziele stehen vorn und lassen sich überspringen.
5. Screenshot-Ordner: Standard ist der Ordner des Screencap-Plugins. Er ist im ConfigurationManager
   überschreibbar.

## 5. Umsetzungsschritte (nach Freigabe)

1. Extension: Brücken-Export plus Einstellungen plus Tests (Format, Sortier-Grundlage, Pfad-Schutz).
2. Plugin-Gerüst: csproj, Plugin-Klasse, Config, Toolbar-Button, leeres Fenster.
3. Brücke lesen und beobachten, Zielliste mit Sortierung und Filter.
4. Screenshot-Ordner beobachten, Vorschau, Zuweisen, Rückgängig, Sicherheitsprüfungen.
5. README für Bau und Installation (DLL nach `BepInEx/plugins/`), Testlauf mit einem echten Event.
