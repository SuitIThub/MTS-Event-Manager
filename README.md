# MTS Event Manager

[![Build & Release](https://github.com/SuitIThub/MTS-Event-Manager/actions/workflows/release.yml/badge.svg)](https://github.com/SuitIThub/MTS-Event-Manager/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/SuitIThub/MTS-Event-Manager)](https://github.com/SuitIThub/MTS-Event-Manager/releases/latest)

Tooling for writing events for **[Mind the School](https://github.com/SuIT-pub/Mind-the-School)** — for the base
game and for mods. It has two parts, released together:

- **MTS Event Manager**, a VS Code extension. It gives you a visual event editor: a timeline of the event as the
  game plays it, with in-place editing, image/paperdoll/background modules, an event check, a trigger simulator,
  an overview of all events, and a set of authoring helpers for the Ren'Py code.
- **MTS Capture**, a BepInEx plugin for Honey Select 2 **StudioNeoV2**. It takes the screenshots you make in
  the studio and files them as the missing images of the event you have open in VS Code — named and placed
  exactly as the event's `Pattern` expects.

Everything the tools write goes through verified, undoable edits. The code keeps its meaning or the edit is
refused.

---

## Contents

- [Download & installation](#download--installation)
- [Feature overview](#feature-overview)
- [Quick start](#quick-start)
- [The event editor](#the-event-editor)
- [Authoring helpers in the code editor](#authoring-helpers-in-the-code-editor)
- [MTS Capture (StudioNeoV2 plugin)](#mts-capture-studioneov2-plugin)
- [What the tools understand about the game](#what-the-tools-understand-about-the-game)
- [Settings](#settings)
- [Troubleshooting](#troubleshooting)
- [For maintainers](#for-maintainers)

---

## Download & installation

Grab both files from the **[latest release](https://github.com/SuitIThub/MTS-Event-Manager/releases/latest)**.
The release notes list what changed.

### Extension (`mts-event-manager-<version>.vsix`)

1. **Requirements:** VS Code 1.85 or newer, on Windows x64. The package bundles native image libraries for
   Windows; on other platforms, [build it from source](#building-from-source).
2. In VS Code open **Extensions**, then the **…** menu, then **Install from VSIX…**, and choose the file.
3. Open the folder that contains the game's `game/` directory (your Mind the School checkout), or your mod
   folder. A mod folder should sit inside a game checkout if you want the base game's classes and characters to
   be known.
4. Recommended: a Ren'Py syntax extension (language id `renpy`) for highlighting.

To update, install the newer VSIX over the old one. The extension tells you when a new release is out
(once a day, or on demand with **MTS: Check for Updates**).

### Plugin (`MTSCapture-<version>.zip`)

1. **Requirements:** Honey Select 2 with **BepInEx 5** and **KKAPI (HS2API) 1.46 or newer**. Any
   BetterRepack-style install has both.
2. Extract the zip into the game folder, the one with `HoneySelect2.exe`. The DLL ends up in
   `BepInEx\plugins\MTSCapture\`.
3. Start **StudioNEOV2**. A camera button appears in the left toolbar.

---

## Feature overview

### VS Code extension

| Area | What you get |
|---|---|
| **Event editor (timeline)** | Plays an event stop by stop: dialogue with portraits, CGs, backgrounds, paperdolls (animated), videos. Pick branches and selector values; the timeline follows. |
| **In-place editing** | Dialogue text, speaker and type, `random_say` alternatives, monologue parts, stat changes, `end_event` type, menu choices. Insert dialogue/image/video/paperdoll/menu with **＋**, move statements, delete lines, *Optimize* image calls. |
| **Modules** | Image (steps, pause, video with `Movie` declarations, PNG/WEBP switch), background (`set_background`: blur, split, b/w), paperdoll editor, `Event(...)` definition editor, new event wizard. |
| **Check** | Walks every path of the event and reports missing images per value combination, missing `Movie` declarations, broken menu targets, endings and unknown speakers — plus a **shot list** of images to make. |
| **Simulator** | Answers *when does this event fire?* Set weekday, daytime, levels and stats, and see each condition's verdict and the competition in the event's pool. |
| **Event overview** | All events with thumbnail, pool, priority and conditions; check many events at once. |
| **Code helpers** | CodeLens label ↔ event definition, insert helpers for conditions/selectors/patterns/options, diagnostics for `Event(...)` arguments, image and paperdoll hover previews, inline speaker portraits, custom portraits. |
| **Capture bridge** | Exports the event open in the editor for the MTS Capture plugin. |
| **Update check** | Once a day it looks for a newer release and links to the release post (**MTS: Check for Updates** checks right away). |

### MTS Capture plugin

| Area | What you get |
|---|---|
| **Studio window** | Toolbar button in StudioNeoV2. The window shows the event from VS Code, your newest screenshot and the target it will become. |
| **Target list** | *All images* or *Only missing*, optional `$` wildcard images, and your own nesting order of the keys (e.g. level, then uniform, then step). |
| **Assign** | Copies the screenshot as `.png` to the exact path the pattern expects. It warns on a wrong size (default 1920×1080), asks before replacing, can move an older `.webp` aside, and offers **Undo**. |
| **Safety** | Writes only below `game/images` and `game/mods/<mod>/images`. Replaced files are backed up. |
| **Update check** | On studio start it looks for a newer release; the window then shows *Update available* with a link to the release post. |

---

## Quick start

1. Open your Mind the School folder in VS Code and open any event file, e.g.
   `game/scripts/buildings/school_dormitory.rpy`.
2. Right-click inside an event's label and choose **Show in Event Timeline**. Alternatively click
   **👁 Preview** above the label, or run **MTS: Preview Event Timeline**.
3. Step through with ◀ ▶. Double-click a dialogue text to edit it and press Enter to save. Use **↩ Undo** to
   revert.
4. Click **Check** in the header to see which images are missing on which path.
5. Optional, with the plugin: open StudioNeoV2, click the camera button, take a screenshot (F11). The window
   offers the first missing image; click **Assign**.

---

## The event editor

Open it with **MTS: Preview Event Timeline**, the **👁 Preview** CodeLens on a scene label, or **Show in Event
Timeline** from the editor context menu. The last one jumps straight to the stop of the line you clicked,
switching to a branch that reaches it if needed. The panel remembers its editor group and restores itself
after a window reload.

### Layout

- **Header:**
  - ⏮ ◀ ▶ ⏭ navigate the stops.
  - **↪ Code** reveals the current line in the code editor.
  - **Definition** opens the `Event(...)` editor; **New event** creates a new event.
  - **✨ Optimize**, **Check**, **Simulate** and **Overview** are described below.
  - **↩ Undo** reverts the last timeline change.
- **Values bar:** the event's selector keys (e.g. `school_level`, `topic`, `girl_name`). Choose a value to see
  the images and text for it; `[topic]`-style interpolations follow.
- **Branch bar:** every `call_custom_menu(...)` choice and `if`/`elif` on the current path. Pick one and the
  timeline continues down that branch.
- **Stage:** the frame as the game would show it: background, CG or video, paperdolls with their position,
  zoom, flip, blur and black-and-white.
- **Caption:** speaker (with portrait), dialogue type and text, with edit and delete buttons.
- **Timeline strip:** all stops plus markers for images, paperdolls, backgrounds, menus, stat changes and the
  event's end. **＋** between stops inserts new content there.

### Editing

| Action | How |
|---|---|
| Dialogue text | Double-click the text, or ✏. **Enter** saves, **Esc** cancels. Quotes and backslashes are escaped for you, and the quote style (`"`, `'`, `"""`) is kept. |
| Speaker / dialogue type | Double-click the speaker name to pick a character. The type dropdown offers say, think, shout and whisper. |
| `random_say(...)` | ◀ ▶ switch between the alternatives. Each one is edited on its own. |
| Monologue (`"""…"""`) | Ren'Py splits a triple-quoted say at blank lines. Each part is its own stop, marked **2/3**, and is edited or deleted separately. |
| Delete | 🗑 on dialogue and pause lines, *Remove* in the image module. Deleting the only statement of a block leaves `pass`, so the script stays valid. |
| Insert | **＋** offers dialogue, paperdoll, image, video and menu. New content goes after the end of the statement, even if it spans several lines. |
| Move | ▲▼ on a stop moves the statement (with its block) up or down. |
| Menus | Add, rename and remove `call_custom_menu` choices. New choices get their sub-label. |
| Stats / end | Stat markers edit `change_stats_with_modifier(...)`; the end marker switches the `end_event(...)` type. |
| ✨ Optimize | Rewrites paperdoll `display` calls into their shortest form and merges consecutive `image.show(n)` into one `call Image_Series.show_image(image, …)`. |

Every edit follows the same pipeline:
1. It is planned against the current text and simulated.
2. The result is re-parsed and compared with what was intended.
3. A structure check runs: no string or bracket may be opened or closed by accident, and no empty blocks may
   appear.
4. Only then is the edit applied, as a single undoable step.

If anything differs, nothing is written and a message explains why. If you changed the file in the code editor
meanwhile, the line is re-located first.

### Modules

- **Image:** pattern key, steps, pause and video.
  - Shows the resolved image for the current values.
  - For videos it adds or updates the `Movie` declaration (`anim_…`, loop or not).
  - Can remove a single step of a `show_image` series.
  - If an image exists as both **PNG and WEBP** (e.g. a fresh capture next to the converted file), a switch
    shows both and marks which one the game loads. That is the pattern's extension, usually `.webp`.
- **Background:** `set_background` / `set_background_split` with image step or path, blur (on/amount,
  duration), black-and-white per side and the separator width.
- **Paperdoll:** framing, presets (including `register_preset` ones from the game or mods), images per field.
  It updates the call or inserts a new `display`.
- **Definition:** a form over the `Event(...)` call for conditions, selectors, patterns and options. Values are
  offered from what the game uses.
- **New event:** writes the `Event(...)` definition (priority, pool, pattern, conditions) and the scene label.

### Check

**Check** walks every path through the event: all menu choices, all branches and all selector values. It
reports:
- Images per pattern, step and value combination: found, only served by a `$` wildcard file, or **missing**.
  Level limits from `LevelCondition` are respected, including the starting level of a character (e.g. the
  secretary starts at 5).
- Videos without a `Movie` declaration or without a `.webm`.
- Menu choices pointing to missing labels, paths without an ending, speakers that are never defined.
- A **shot list** (CSV) of all missing images, to plan a render session.

Click an issue to jump to the code or to the path that shows it.

### Simulator

Set weekday, daytime, character levels, money and stats. The simulator evaluates the event's conditions like
the engine and shows why the event would or would not fire. It also lists the pool the event is in and the
other events it competes with, including priorities.

### Event overview

**MTS: Event Overview** lists every event of the workspace, grouped by pool, with thumbnail, priority,
condition summary and selector keys. It can run the check for many events at once.

---

## Authoring helpers in the code editor

- **CodeLens on scene labels:** ▶ *Event definition(s)* (peek), **👁 Preview**, **✏ Edit definition**.
- **CodeLens on `Event(...)`:** → the scene label, **+ Condition / + Selector / + Pattern**. The class list is
  discovered from the workspace, mods included, so new condition classes show up automatically.
- **Diagnostics:** `Event(...)` arguments are validated against the discovered classes.
- **Hover previews:** hover an image call (`image.show`, `show_image`, `show_pattern`, `show_video`,
  `set_background`) for an auto-rotating preview, or a paperdoll call for the resolved sprite.
- **Portraits:** speakers get their portrait inline before the dialogue line. **MTS: Custom Portraits** assigns
  your own images to characters (per workspace or per user).
- **MTS: Go to Event Label**, **MTS: Peek Event Definitions**, **MTS: Reindex Workspace**.

---

## MTS Capture (StudioNeoV2 plugin)

### How it works

```
VS Code event editor ──► active-event.json ──► MTS Capture window ──► game/images/…/<name>.png
        ▲                                                                      │
        └──────────── the extension notices the new file and re-checks ◄───────┘
```

1. Open an event in the VS Code event editor. The extension writes the event's image targets to
   `%LOCALAPPDATA%\MTS-Event-Manager\capture\active-event.json`: every image of every path, with its values,
   whether it exists, and its exact target path.
2. In StudioNeoV2 click the **camera** button in the left toolbar.
3. Take a screenshot. The Screencap plugin's F11 saves into `UserData\cap` by default. The newest capture
   appears in the window automatically.
4. The target is preselected: the next image in your order. Change it with `<` `>`, **Skip** or the list.
5. Click **Assign**. The capture is copied as PNG to the target path. The extension sees the new file, checks
   again, and the image drops out of *Only missing*.

### The window

- **All images / Only missing:** list every image, including existing ones (these can be re-shot and are
  replaced after a confirmation), or only images without a file.
- **$ images:** also offer `$` wildcard images. One file like `x $ 0.png` serves every value of that key.
  They come first per key and can simply be skipped.
- **$-covered = missing:** in *Only missing*, an image that only a `$` file serves still counts as missing.
- **Order:** ▲▼ sort the keys. Key 1 changes slowest. With `school_level, uniform, step` you get all uniforms
  and steps of level 1, then level 2, and so on. `pattern` (main, card, …) is a key too. The order is saved per
  event.
- **Size warning:** if the capture isn't the expected size (default 1920×1080), a warning appears above
  **Assign**.
- **Replace:** an existing target needs a second click. The old file is backed up first.
- **Older .webp:** if the same image exists as `.webp`, the game would keep loading it until the PNG is
  converted. By default the plugin moves the `.webp` into the backup, so the game shows the new PNG right away.
- **Undo:** reverts the assignments of this session one by one, restoring replaced and moved files.

### Plugin settings (F1 → ConfigurationManager → MTS Capture)

| Setting | Default | Meaning |
|---|---|---|
| Screenshot folder | *(empty)* | Folder watched for captures. Empty means the Screencap plugin's *Screenshot save folder* (`UserData\cap`). |
| Bridge file | *(empty)* | Empty means `%LOCALAPPDATA%\MTS-Event-Manager\capture\active-event.json`. Must match the extension's `mtsEventManager.capture.bridgeFile`. |
| Expected width / height | 1920 / 1080 | Captures of another size get a warning. |
| Screenshot after assigning | MoveToAssigned | Keep it, move it into an `assigned` subfolder, or delete it (kept in the backup, so undo still works). |
| Only new screenshots | on | Offer only captures taken after the studio started. |
| Move older .webp aside | on | See *Older .webp* above. |
| Mode, Offer $ images, $-covered counts as missing | Missing, off, on | Same as the window toggles. |
| Check for updates | on | On studio start, look for a newer release and show a link in the window. |
| Toggle window / Assign capture | — | Optional hotkeys. |

Backups go to `%LOCALAPPDATA%\MTS-Event-Manager\capture\backup\`.

### Safety

- The plugin only ever writes `.png` files below `game/images` or `game/mods/<mod>/images`. The extension
  names these roots; anything else, including paths with `..`, is refused.
- Nothing is replaced without a confirmation, and every replaced or moved file is backed up.
- The plugin reads the event only from the bridge file. Patterns, selectors, conditions and `$` rules are
  worked out by the extension alone.

---

## What the tools understand about the game

The extension reads the game's own conventions. As a mod author, these are the things you can rely on:

- **Events:** `Event`, `EventFragment`, `EventComposite` and `EventSelect` with their conditions, selectors,
  options and `Pattern(key, path, *alt_keys)`, plus pools (`pool.add_event(...)`) and fragment storages.
- **Composite events:** a fragment uses its own patterns first, then those of its `EventComposite`, like the
  engine's `frag_image_patterns` → `image_patterns`. The composite's selector values and level limits apply
  too.
- **Image paths:**
  - `<placeholders>` filled from selector values.
  - `<step>` from `image.show(n)` / `show_image` / `show_video`.
  - `$` wildcard files as the engine's fallback.
  - PNG and WEBP interchangeable.
  - Paths built from variables (`base_path + "x <step>.webp"`) are resolved when the variable is a string
    assigned earlier in the same file.
- **Fixed values:** `convert_pattern("card", {"girls": "ikushi_ito"}, **kwargs)`, `data = {…}` and
  `**with_values(kwargs, girls = "…")`.
- **Mods:**
  - Each `game/mods/<Mod>/` folder is its own image root.
  - `set_current_mod(...)` is respected.
  - `overwrite_event_image(event, key, Pattern(...))` replacements count as images of that event.
  - `register_preset(...)` paperdoll presets are read from the workspace.
- **Dialogue:** `speaker "text"`, `speaker.say/think/shout/whisper`, narration, `random_say(...)`, and Ren'Py
  monologue mode for `"""…"""` (`rpy monologue double|single|none`).
- **Paperdolls:** `register_paperdoll`, `.display(...)` with `PDA*` actions, `PDAPause` blocks, presets,
  `set_background(_split)`.
- **Videos:** `image.show_video(step, pause)` with `Movie` declarations named `anim_` plus the image's base
  name.

**Not simulated:**
- Dynamic Python: computed paths, f-strings, runtime-only values. These are reported as unknown rather than
  guessed.
- Ren'Py's native `menu:` statement. The timeline follows `call_custom_menu(...)`.

---

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `mtsEventManager.enableCodeLens` | `true` | CodeLens on labels and `Event(...)` definitions. |
| `mtsEventManager.enableDiagnostics` | `true` | Validate `Event(...)` arguments. |
| `mtsEventManager.enableImagePreview` | `true` | Image hover previews. |
| `mtsEventManager.enablePaperdoll` | `true` | Paperdoll hover previews. |
| `mtsEventManager.enablePortraits` | `true` | Inline speaker portraits. |
| `mtsEventManager.imageHoverSecondsPerFrame` | `2` | Seconds per image in the hover carousel. |
| `mtsEventManager.imageRoots` | `[]` | Extra folders to resolve `Pattern` paths. `**/game` and `game/mods/*` are always included. |
| `mtsEventManager.capture.enabled` | `true` | Export the open event for MTS Capture. |
| `mtsEventManager.capture.bridgeFile` | `""` | Bridge file path. Empty uses the default under `%LOCALAPPDATA%`. |
| `mtsEventManager.checkForUpdates` | `true` | Once a day, check GitHub for a newer release and offer a link to it. |

---

## Troubleshooting

- **No CodeLens / "not inside an event label":** the file must contain event syntax, and the label must be the
  scene label of an `Event(...)`. Run **MTS: Reindex Workspace** after large changes outside VS Code.
- **An image shows as missing although it exists:** check the placeholder values in the values bar and the
  pattern's path. The check's shot list shows the exact file name it expects.
- **An edit was refused:** the message says why, e.g. the line changed, the result would change other code,
  or a string or block would break. Reopen the stop or edit that spot in the code.
- **The plugin window says "No bridge file yet":** open an event in the VS Code event editor and check that
  `mtsEventManager.capture.enabled` is on and both sides use the same bridge path.
- **The game still shows the old image after assigning:** the pattern loads `.webp` first. Keep *Move older
  .webp aside* on, or convert the PNG.

---

## For maintainers

### Building from source

```bash
npm ci
npm run compile          # webview bundles (webview/*.js → out/webview) + extension (esbuild)
npm run package          # dist/mts-event-manager-<version>.vsix
```

Press **F5** in VS Code to run the extension in a development host.

The plugin needs no game install: its references come as NuGet packages from the BepInEx and IllusionMods
feeds (`studio-capture/nuget.config`).

```bash
dotnet build studio-capture/MTSCapture.csproj -c Release
dotnet build studio-capture/MTSCapture.csproj -c Release /p:DeployToGame=true /p:GamePath="D:\Honey Select"
```

### Tests

```bash
npm run typecheck
npm run verify                                        # all checks
dotnet run --project studio-capture/tests             # plugin core
```

`npm run verify` looks for the game at `MTS_WS_ROOT`, the folder that contains `game/`:
- The **unit** and **webview** checks always run.
- The **fuzzers** run over whatever game scripts are there. They apply thousands of edits and verify each
  round trip.
- The **fixture checks** assert concrete events and files. They need the full game with images and skip
  themselves otherwise (also with `MTS_SKIP_FIXTURES=1`).

### Repository layout

| Path | Content |
|---|---|
| `src/` | Extension (TypeScript). `previewPanel.ts` hosts the event editor; `eventTimeline.ts` walks events; `eventCheck.ts`, `eventSimulator.ts`; `safeEdit.ts` + `codeStructure.ts` hold the verified-edit pipeline; `captureBridge.ts` is the plugin bridge. |
| `webview/` | Webview scripts (plain JS). `bundles.json` lists which files form each page's script. |
| `scripts/` | Tests, fuzzers, the webview bundler and the release-notes generator. |
| `studio-capture/` | MTS Capture plugin (C#, BepInEx 5) with its tests. |
| `.github/workflows/release.yml` | Build, test and release. |

### Releasing

1. Bump `"version"` in `package.json`. The plugin takes its version from there too.
2. Add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md`.
3. Push to `main`.

The **Build & Release** workflow then:
- type-checks, builds and tests the extension, including the fuzzers against the public Mind the School
  scripts;
- builds and tests the plugin;
- if `v<version>` has no GitHub release yet, packages `mts-event-manager-<version>.vsix` and
  `MTSCapture-<version>.zip` and publishes the release.

The release notes are the changelog sections of the whole minor line: a release of 0.6.1 shows 0.6.1 and 0.6.0.
Versions of an older line that were never released are added too. Pull requests get the checks without a release. The workflow can
also be started by hand under **Actions → Build & Release → Run workflow**.
