# MTS Event Manager

VS Code extension for *Mind the School* Ren'Py event authoring.

## Features

- **Label → Event**: CodeLens above labels peeks all `Event` / `EventFragment` / `EventComposite` / `EventSelect` definitions that call that label (editable peek).
- **Event → Label**: CodeLens on event definitions jumps to the scene label (including sublabels like `parent.sub`).
- **+ Condition / + Selector / + Pattern**: insert snippets with tabstops. Class list is discovered dynamically from inheritance (`Condition` / `Selector` / …) across **all** `.rpy` files.
- **Image preview**: CodeLens `🖼` opens a side panel carousel on click. Hovering the call line (or the line of the CodeLens) shows a large auto-rotating preview without opening a tab.
- **Paperdolls**: CodeLens `🎭 Paperdoll` on `register_paperdoll` / `.display(...)` opens an editor. It composites body + head from `game/images/paperdoll`, previews framing (presets, align, zoom, flip) over the scene background, and can update the call or insert a new `display` / `register_paperdoll` line. Hover the call for a still of the resolved sprite.
- **Diagnostics**: structural validation of event arguments against discovered `__init__` schemas.

## Usage

1. Open a workspace that contains MTS (or mod) `.rpy` files with Event syntax.
2. Press **F5** from this extension folder (Extension Development Host), with the game project folder opened — or install the `.vsix`.
3. Open any `.rpy` with events/labels. CodeLens appears when Event syntax is detected.

Commands: `MTS: Reindex Workspace`, insert helpers via CodeLens.

## Develop

```bash
npm install
npm run compile
```

Then **Run Extension** from the debug panel.
