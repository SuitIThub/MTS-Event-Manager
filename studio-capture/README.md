# MTS Capture — StudioNeoV2 plugin (Honey Select 2)

MTS Capture files the screenshots you make in StudioNeoV2 as the images of the event that is open in the VS Code
**MTS Event Manager**. It copies them, as PNG, under exactly the name and folder the event's `Pattern` expects.

Full guide: <https://github.com/SuitIThub/MTS-Event-Manager#mts-capture-studioneov2-plugin>

## Install

Requirements: Honey Select 2 with **BepInEx 5** and **KKAPI (HS2API) ≥ 1.46**.

Extract `MTSCapture-<version>.zip` into the game folder (next to `HoneySelect2.exe`). The DLL ends up in
`BepInEx\plugins\MTSCapture\`. In StudioNEOV2 a camera button appears in the left toolbar.

## Use

1. In VS Code, open an event in the event editor. The extension writes its image targets to
   `%LOCALAPPDATA%\MTS-Event-Manager\capture\active-event.json`.
2. In the studio, click the camera button, then take a screenshot (Screencap F11 → `UserData\cap`).
3. The newest capture appears in the window with the next target preselected. Change the target with `<` `>`,
   **Skip** or the list.
4. Click **Assign**. The PNG is written to `game/images/…`, and the extension re-checks the event.

Window options:
- **All images / Only missing**, **$ images** (wildcard files that serve every value of a key), **$-covered =
  missing**.
- **Order:** the key order. Key 1 changes slowest, and the order is saved per event.
- **Size warning** when a capture isn't 1920×1080 (configurable).
- **Replace** needs a second click, and replaced files are backed up.
- By default an older `.webp` of the same image is moved into the backup, so the game shows the new PNG.
- **Undo** reverts this session's assignments.

## Settings (F1 → ConfigurationManager → MTS Capture)

Screenshot folder (empty = Screencap's folder), bridge file (empty = the default above), expected width/height,
what happens to the screenshot after assigning (keep / move to `assigned` / delete into the backup), only new
screenshots, move older `.webp` aside, list mode, `$` options, hotkeys.

Backups: `%LOCALAPPDATA%\MTS-Event-Manager\capture\backup\`.

## Safety

The plugin only writes `.png` files below `game/images` or `game/mods/<mod>/images`. The extension names these
roots, and anything else is refused. Nothing is replaced without a confirmation.

## Build

```bash
dotnet build -c Release                         # references come from NuGet (see nuget.config)
dotnet build -c Release /p:DeployToGame=true /p:GamePath="D:\Honey Select"
cd tests && dotnet run                          # core tests (JSON, ordering, path safety, assign/undo)
```

The plugin's version is the `version` from the repository's `package.json`.

| File | Content |
|---|---|
| `src/Core/*.cs` | Unity-free core: bridge format, ordering/modes, file safety, assign/undo |
| `src/MTSCapturePlugin.cs` | BepInEx plugin: config, toolbar, polling of bridge and screenshot folder |
| `src/CaptureWindow.cs` | IMGUI window |
