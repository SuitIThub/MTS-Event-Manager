# Changelog

All notable changes to the **MTS Event Manager** extension and the **MTS Capture** StudioNeoV2 plugin.
Both share one version number and are released together.

Format: one `## [x.y.z] - YYYY-MM-DD` section per version, newest first. The release workflow
publishes the sections of the whole minor line as the release notes (0.6.1 shows 0.6.1 and 0.6.0),
so **every version bump needs a section here** (the build fails without one).

## [0.6.1] - 2026-09-26

### Added
- **Update check** in the extension and in MTS Capture: once a day (extension) / on studio start
  (plugin) GitHub is asked for a newer release; you get a note with a link to the release post.
  Extension: *Open release* / *Skip this version*, command **MTS: Check for Updates**, setting
  `mtsEventManager.checkForUpdates`. Plugin: a line in the window, setting *Check for updates*.

### Changed
- Moving statements in large files is much faster (the scene fuzzer went from 151 s to 39 s).

### Fixed
- The plugin build restores HarmonyX / MonoMod / Mono.Cecil (dependencies of BepInEx.Core) on a
  clean machine.

## [0.6.0] - 2026-09-26

### Added
- **Event editor (timeline)** — `MTS: Preview Event Timeline` / *Show in Event Timeline*:
  - Step through an event like the game plays it: dialogue with portraits, CGs, backgrounds,
    paperdolls (with an animation player for moves, flips and pauses) and videos.
  - Pick branches (`call_custom_menu`, `if`/`elif`) and selector values; the timeline follows.
  - Edit in place: dialogue text, speaker and type, `random_say` alternatives, stats and
    `end_event` types, menu choices. Insert dialogue, images, videos, paperdolls and menus
    with **＋**, move statements up/down, delete lines — every edit is verified and undoable.
  - Modules: image (steps, pause, video + `Movie` declarations), background (`set_background`,
    blur, split, b/w), paperdoll editor and the `Event(...)` definition editor.
  - **Check**: every path of the event against images per value (incl. `$` wildcard files),
    `Movie` declarations, menu targets, endings and speakers — plus a shot list of missing images.
  - **Simulator**: when does the event fire? Time, levels and stats against its conditions and
    its pool (incl. competing events).
  - **Event overview** of all events with thumbnails, pools and batch checks.
  - Restores itself after a window reload and reopens in the editor group it was in.
- Ren'Py **monologue mode**: a `"""…"""` say statement is split at blank lines into several
  dialogue stops (`rpy monologue single`/`none` respected); each part is edited on its own.
- **Composite events**: fragments inherit the patterns and selector values of their
  `EventComposite` (the engine's `frag_image_patterns` → `image_patterns` fallback).
- Pattern paths built from variables (`base_path + "x <step>.webp"`) are resolved.
- `convert_pattern(key, {"k": "v"})` / `**with_values(kwargs, k = "v")` fixed values are respected
  by previews and checks.
- Mod support: `overwrite_event_image(...)` replacement patterns; `register_preset(...)` paperdoll
  presets are read from the workspace (mods included).
- **PNG / WEBP switch**: when an image exists in both formats, the timeline and the image module
  show which one the game loads and let you switch.
- **MTS Capture** — a new BepInEx plugin for Honey Select 2 StudioNeoV2: assign screenshots to
  the event's missing images (sorted by your key order), copied and renamed into the game's
  image folder. The extension exports the open event for it (`mtsEventManager.capture.*`).

### Changed
- Every write goes through a verified edit: planned, simulated, re-parsed, structure-checked
  (strings, brackets, empty blocks) and rolled back if the result differs.
- Faster indexing: per-file cache, no full reindex on every keystroke.
- Webview scripts moved out of TypeScript template strings into `webview/*.js`; pages load them
  with a nonce — no inline scripts are allowed any more (stricter CSP).
- Image previews reload when files change on disk (versioned URLs + file watcher).
- The image and paperdoll CodeLens buttons were removed — both live in the event editor now.

### Fixed
- Triple-quoted dialogue no longer produces bogus speakers or stops.
- **＋** inserts after the end of a multi-line statement instead of after its first line.
- Deleting the only statement of a block leaves `pass` instead of an empty block.

## [0.5.7] - 2026-09-23

### Added
- Paperdoll editor: body + head compositing from `game/images/paperdoll`, framing presets,
  align / zoom / flip over the scene background; update or insert `display` / `register_paperdoll`.
- Image verification scripts.

## [0.4.0]

### Added
- Image preview: CodeLens carousel and hover previews for pattern `show` calls.
- Custom portraits for dialogue speakers.

## [0.1.0]

### Added
- Label ↔ event navigation (CodeLens, peek), insert helpers for conditions, selectors, patterns
  and options (classes discovered from the workspace), structural diagnostics for `Event(...)`.
