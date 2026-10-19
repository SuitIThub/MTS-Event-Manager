using System;
using System.IO;
using KKAPI.Utilities;
using MTSCapture.Core;
using UnityEngine;

namespace MTSCapture
{
    /// <summary>
    /// The capture window (IMGUI, resizable): event header, list options (folded), newest capture,
    /// selected target with its description, actions, and the target list filling the rest.
    /// </summary>
    public partial class MTSCapturePlugin
    {
        private const int WindowId = 0x4D5443; // "MTC"
        private const float MinWidth = 340f, MaxWidth = 900f;
        private const float MinHeight = 420f;
        private const float GripSize = 16f;
        private const float DescriptionMaxHeight = 120f;
        private Rect windowRect = new Rect(80, 80, 420, 680);
        private Vector2 listScroll, descriptionScroll;
        private bool showOptions;
        private bool resizing;
        private Vector2 resizeStart, resizeStartSize;
        private int scrolledTo = -1;
        private GUIStyle warnStyle, okStyle, smallStyle, mutedStyle, headStyle, titleStyle, boxStyle, descStyle, selectedStyle, rowStyle, bigButton;

        private static readonly Color Accent = new Color(1f, 0.78f, 0.3f);
        private static readonly Color MissingColor = new Color(1f, 0.6f, 0.4f);
        private static readonly Color DoneColor = new Color(0.55f, 0.9f, 0.55f);

        private void OnGUI()
        {
            if (!windowVisible) return;
            InitStyles();
            HandleResize();
            windowRect.width = Mathf.Clamp(windowRect.width, MinWidth, MaxWidth);
            windowRect.height = Mathf.Clamp(windowRect.height, MinHeight, Mathf.Max(MinHeight, Screen.height));
            IMGUIUtils.DrawSolidBox(windowRect);
            windowRect = GUILayout.Window(WindowId, windowRect, DrawWindow, PluginName + "  " + Version,
                GUILayout.Width(windowRect.width), GUILayout.Height(windowRect.height));
            IMGUIUtils.EatInputInRect(windowRect);
        }

        /// <summary>Drag of the bottom-right grip (started in <see cref="DrawGrip"/>), in screen coordinates.</summary>
        private void HandleResize()
        {
            if (!resizing) return;
            if (!Input.GetMouseButton(0)) { resizing = false; return; }
            var mouse = new Vector2(Input.mousePosition.x, Screen.height - Input.mousePosition.y);
            windowRect.width = resizeStartSize.x + mouse.x - resizeStart.x;
            windowRect.height = resizeStartSize.y + mouse.y - resizeStart.y;
        }

        private void InitStyles()
        {
            if (warnStyle != null) return;
            warnStyle = new GUIStyle(GUI.skin.label) { wordWrap = true, fontStyle = FontStyle.Bold };
            warnStyle.normal.textColor = MissingColor;
            okStyle = new GUIStyle(GUI.skin.label) { wordWrap = true };
            okStyle.normal.textColor = DoneColor;
            smallStyle = new GUIStyle(GUI.skin.label) { fontSize = 11, wordWrap = true, richText = true };
            mutedStyle = new GUIStyle(smallStyle);
            mutedStyle.normal.textColor = new Color(0.62f, 0.62f, 0.62f);
            headStyle = new GUIStyle(GUI.skin.label) { fontSize = 10, fontStyle = FontStyle.Bold };
            headStyle.normal.textColor = new Color(0.65f, 0.7f, 0.8f);
            titleStyle = new GUIStyle(GUI.skin.label) { fontSize = 14, fontStyle = FontStyle.Bold, wordWrap = true, richText = true };
            boxStyle = new GUIStyle(GUI.skin.box) { padding = new RectOffset(8, 8, 6, 6), margin = new RectOffset(0, 0, 3, 3) };
            descStyle = new GUIStyle(GUI.skin.label) { fontSize = 12, wordWrap = true, richText = false, padding = new RectOffset(8, 4, 2, 2) };
            descStyle.normal.textColor = new Color(0.95f, 0.92f, 0.82f);
            rowStyle = new GUIStyle(GUI.skin.button) { alignment = TextAnchor.MiddleLeft, fontSize = 11, wordWrap = false, richText = true, clipping = TextClipping.Clip };
            selectedStyle = new GUIStyle(rowStyle) { fontStyle = FontStyle.Bold };
            selectedStyle.normal.textColor = Accent;
            selectedStyle.normal.background = selectedStyle.active.background;
            bigButton = new GUIStyle(GUI.skin.button) { fontSize = 13, fontStyle = FontStyle.Bold };
        }

        private float Inner => windowRect.width - 16;

        private void DrawWindow(int id)
        {
            if (GUI.Button(new Rect(windowRect.width - 24, 2, 20, 16), "x")) SetWindowVisible(false);

            if (UpdateAvailable != null)
            {
                GUILayout.BeginHorizontal(boxStyle);
                GUILayout.Label("Update available: <b>" + UpdateAvailable.Version + "</b> (installed " + Version + ")", smallStyle);
                if (GUILayout.Button("Open release", GUILayout.Width(100))) OpenUpdate();
                GUILayout.EndHorizontal();
            }
            DrawEventHeader();
            if (Bridge != null && Bridge.Event != null)
            {
                DrawModeAndOptions();
                DrawCapture();
                DrawTarget();
                DrawActions();
                DrawList();
            }
            else GUILayout.FlexibleSpace();
            GUILayout.BeginHorizontal();
            GUILayout.Label(Status ?? "", StatusIsError ? warnStyle : mutedStyle, GUILayout.MinHeight(18));
            GUILayout.Space(GripSize);
            GUILayout.EndHorizontal();
            DrawGrip();
            GUI.DragWindow(new Rect(0, 0, windowRect.width - 26, 20));
        }

        private void DrawGrip()
        {
            var grip = new Rect(windowRect.width - GripSize - 2, windowRect.height - GripSize - 2, GripSize, GripSize);
            if (Event.current.type == EventType.Repaint)
            {
                var c = GUI.color;
                GUI.color = new Color(1f, 1f, 1f, 0.45f);
                for (int i = 1; i <= 3; i++)
                    for (int j = 0; j < i; j++)
                        GUI.DrawTexture(new Rect(grip.xMax - 4 * (j + 1), grip.yMin + 4 * (4 - i) - 2, 2, 2), Texture2D.whiteTexture);
                GUI.color = c;
            }
            if (Event.current.type == EventType.MouseDown && Event.current.button == 0 && grip.Contains(Event.current.mousePosition))
            {
                resizing = true;
                resizeStart = new Vector2(Input.mousePosition.x, Screen.height - Input.mousePosition.y);
                resizeStartSize = new Vector2(windowRect.width, windowRect.height);
                Event.current.Use();
            }
        }

        private void DrawEventHeader()
        {
            if (BridgeError != null)
            {
                GUILayout.BeginVertical(boxStyle);
                GUILayout.Label(BridgeError, warnStyle);
                GUILayout.Label("Bridge file: " + BridgePath, mutedStyle);
                GUILayout.EndVertical();
                return;
            }
            if (Bridge == null) return;
            GUILayout.BeginVertical(boxStyle);
            if (Bridge.Event == null)
            {
                GUILayout.Label("No event open in the VS Code event editor.", smallStyle);
                GUILayout.EndVertical();
                return;
            }
            GUILayout.Label(Bridge.Event, titleStyle);
            GUILayout.Label(Bridge.File ?? "", mutedStyle);
            int missing = 0, total = 0;
            foreach (var t in Bridge.Targets)
            {
                if (t.IsWildcard) continue;
                total++;
                if (t.Status == TargetStatus.Missing && !IsDone(t)) missing++;
            }
            // Progress: share of images that exist (or were assigned here).
            var bar = GUILayoutUtility.GetRect(Inner - 16, 6);
            if (Event.current.type == EventType.Repaint)
            {
                var c = GUI.color;
                GUI.color = new Color(1f, 1f, 1f, 0.12f);
                GUI.DrawTexture(bar, Texture2D.whiteTexture);
                GUI.color = missing == 0 ? DoneColor : Accent;
                GUI.DrawTexture(new Rect(bar.x, bar.y, total == 0 ? 0 : bar.width * (total - missing) / total, bar.height), Texture2D.whiteTexture);
                GUI.color = c;
            }
            var age = Bridge.Written == default(DateTime) ? "" : "  ·  updated " + Bridge.Written.ToLocalTime().ToString("HH:mm:ss");
            GUILayout.Label((missing == 0 ? "All " + total + " images exist" : "<b>" + missing + "</b> of " + total + " images missing") + age +
                (Bridge.Truncated ? "  ·  list truncated" : ""), smallStyle);
            GUILayout.EndVertical();
        }

        private void DrawModeAndOptions()
        {
            GUILayout.BeginHorizontal();
            int mode = GUILayout.Toolbar(Mode.Value == CaptureMode.All ? 0 : 1, new[] { "All images", "Only missing" }, GUILayout.Height(22));
            var wanted = mode == 0 ? CaptureMode.All : CaptureMode.Missing;
            if (wanted != Mode.Value) Mode.Value = wanted;
            if (GUILayout.Button(showOptions ? "Options ▲" : "Options ▼", GUILayout.Width(84), GUILayout.Height(22))) showOptions = !showOptions;
            GUILayout.EndHorizontal();
            if (!showOptions) return;

            GUILayout.BeginVertical(boxStyle);
            GUILayout.BeginHorizontal();
            bool wild = GUILayout.Toggle(IncludeWildcards.Value, " Offer $ images");
            if (wild != IncludeWildcards.Value) IncludeWildcards.Value = wild;
            if (Mode.Value == CaptureMode.Missing)
            {
                bool cov = GUILayout.Toggle(WildcardCoveredIsMissing.Value, " $-covered = missing");
                if (cov != WildcardCoveredIsMissing.Value) WildcardCoveredIsMissing.Value = cov;
            }
            GUILayout.EndHorizontal();

            GUILayout.Label("ORDER  (1 = changes slowest)", headStyle);
            for (int i = 0; i < KeyOrder.Count; i++)
            {
                GUILayout.BeginHorizontal();
                GUILayout.Label((i + 1) + ".  " + KeyOrder[i], smallStyle, GUILayout.ExpandWidth(true));
                GUI.enabled = i > 0;
                if (GUILayout.Button("▲", GUILayout.Width(26))) MoveKey(i, -1);
                GUI.enabled = i < KeyOrder.Count - 1;
                if (GUILayout.Button("▼", GUILayout.Width(26))) MoveKey(i, +1);
                GUI.enabled = true;
                GUILayout.EndHorizontal();
            }
            GUILayout.Label("Screenshots from: " + CaptureFolder, mutedStyle);
            GUILayout.EndVertical();
        }

        private void DrawCapture()
        {
            GUILayout.BeginVertical(boxStyle);
            GUILayout.Label("CAPTURE", headStyle);
            if (CaptureTexture == null)
            {
                GUILayout.Label("Waiting for a new screenshot …", mutedStyle);
                GUILayout.EndVertical();
                return;
            }
            float w = Inner - 16;
            float h = Mathf.Min(w * CaptureHeight / Math.Max(1, CaptureWidth), Mathf.Max(110f, windowRect.height * 0.26f));
            var r = GUILayoutUtility.GetRect(w, h);
            GUI.DrawTexture(r, CaptureTexture, ScaleMode.ScaleToFit);
            var size = CaptureWidth + "×" + CaptureHeight;
            GUILayout.Label(Path.GetFileName(CapturePath) + "  ·  " + (SizeMismatch ? "<color=#ff9966><b>" + size + "</b> (expected " + TargetWidth.Value + "×" + TargetHeight.Value + ")</color>" : size), mutedStyle);
            GUILayout.EndVertical();
        }

        private void DrawTarget()
        {
            GUILayout.BeginVertical(boxStyle);
            if (Listed.Count == 0)
            {
                GUILayout.Label(Mode.Value == CaptureMode.Missing ? "Nothing missing for this event." : "No images listed.", okStyle);
                GUILayout.EndVertical();
                return;
            }
            var t = SelectedTarget;
            GUILayout.BeginHorizontal();
            GUILayout.Label("TARGET  " + (Selected + 1) + " / " + Listed.Count, headStyle, GUILayout.ExpandWidth(true));
            if (GUILayout.Button("◄", GUILayout.Width(30))) Select((Selected - 1 + Listed.Count) % Listed.Count);
            if (GUILayout.Button("►", GUILayout.Width(30))) Select((Selected + 1) % Listed.Count);
            GUILayout.EndHorizontal();
            if (t != null)
            {
                GUILayout.Label("<b>" + t.Describe(KeyOrder) + "</b>", titleStyle);
                var line = t.Lines.Count > 0 ? "  ·  line " + (t.Lines[0] + 1) : "";
                GUILayout.Label(Path.GetFileName(t.Path) + line, mutedStyle);
                GUILayout.Label(StateText(t), IsDone(t) ? okStyle : t.Status == TargetStatus.Missing ? smallStyle : mutedStyle);
                DrawDescription(t);
            }
            GUILayout.EndVertical();
        }

        /// <summary>The comment above the show call: what the picture should show.</summary>
        private void DrawDescription(CaptureTarget t)
        {
            GUILayout.Space(2);
            if (string.IsNullOrEmpty(t.Description))
            {
                GUILayout.Label("No description — a # comment above the show call in the script appears here.", mutedStyle);
                return;
            }
            float w = Inner - 40;
            float h = descStyle.CalcHeight(new GUIContent(t.Description), w);
            if (h > DescriptionMaxHeight)
            {
                descriptionScroll = GUILayout.BeginScrollView(descriptionScroll, GUILayout.Height(DescriptionMaxHeight));
                GUILayout.Label(t.Description, descStyle, GUILayout.Width(w));
                GUILayout.EndScrollView();
            }
            else GUILayout.Label(t.Description, descStyle);
            var area = GUILayoutUtility.GetLastRect();
            if (Event.current.type == EventType.Repaint)
            {
                var c = GUI.color;
                GUI.color = Accent;
                GUI.DrawTexture(new Rect(area.x, area.y + 1, 3, area.height - 2), Texture2D.whiteTexture);
                GUI.color = c;
            }
        }

        private string StateText(CaptureTarget t)
        {
            if (IsDone(t)) return "Assigned.";
            if (File.Exists(t.Path)) return "Exists — will be replaced.";
            var others = Assigner.SiblingFormats(t.Path);
            if (others.Count > 0)
                return MoveOtherFormats.Value
                    ? "Exists as " + Path.GetExtension(others[0]) + " — it is moved to the backup, the game then shows the PNG."
                    : "Exists as " + Path.GetExtension(others[0]) + " — the PNG is added next to it; the game keeps showing the " + Path.GetExtension(others[0]) + " until converted.";
            if (t.Status == TargetStatus.Wildcard) return "Missing — only a $ file serves it.";
            return t.IsWildcard ? "$ image, missing." : "Missing.";
        }

        private void DrawActions()
        {
            var t = SelectedTarget;
            bool confirm = t != null && PendingOverwriteId == t.Id;
            if (confirm) GUILayout.Label("(!) Click again to replace the existing file.", warnStyle);
            GUILayout.BeginHorizontal();
            GUI.enabled = t != null && CaptureTexture != null;
            if (GUILayout.Button(confirm ? "Replace" : "Assign capture", bigButton, GUILayout.Height(32))) AssignSelected();
            GUI.enabled = Listed.Count > 0;
            if (GUILayout.Button("Skip", GUILayout.Height(32), GUILayout.Width(56))) Select((Selected + 1) % Listed.Count);
            GUI.enabled = CanUndo;
            if (GUILayout.Button("Undo", GUILayout.Height(32), GUILayout.Width(56))) UndoLast();
            GUI.enabled = true;
            GUILayout.EndHorizontal();
        }

        private void DrawList()
        {
            if (Listed.Count == 0) { GUILayout.FlexibleSpace(); return; }
            GUILayout.Label("ALL TARGETS", headStyle);
            listScroll = GUILayout.BeginScrollView(listScroll, GUILayout.MinHeight(70), GUILayout.ExpandHeight(true));
            const float rowHeight = 22f;
            int hintChars = Mathf.Max(0, (int)((Inner - 200) / 6.5f));
            for (int i = 0; i < Listed.Count; i++)
            {
                var row = Listed[i];
                string tag = IsDone(row) ? "<color=#8ce68c>ok</color>"
                    : row.Status == TargetStatus.Missing ? "<color=#ff9966>●</color>"
                    : row.Status == TargetStatus.Wildcard ? "<color=#ffc84d>$</color>"
                    : "<color=#9a9a9a>=</color>";
                var hint = hintChars > 8 ? row.DescriptionHint(hintChars) : null;
                var label = tag + "  " + row.Describe(KeyOrder) + (hint == null ? "" : "   <color=#8c8c8c>" + hint.Replace("<", "‹") + "</color>");
                if (GUILayout.Button(label, i == Selected ? selectedStyle : rowStyle, GUILayout.Height(rowHeight))) Select(i);
            }
            GUILayout.EndScrollView();
            // Keep the selected row visible when it changes from elsewhere (◄ ►, skip, assign).
            if (scrolledTo != Selected && Event.current.type == EventType.Repaint)
            {
                var view = GUILayoutUtility.GetLastRect();
                float top = Selected * (rowHeight + Mathf.Max(rowStyle.margin.top, rowStyle.margin.bottom));
                if (top < listScroll.y) listScroll.y = top;
                else if (top + rowHeight > listScroll.y + view.height) listScroll.y = top + rowHeight - view.height + 4;
                scrolledTo = Selected;
            }
        }

        private void Select(int index)
        {
            if (index != Selected) descriptionScroll = Vector2.zero;
            Selected = index;
            PendingOverwriteId = null;
        }
    }
}
