using System;
using System.IO;
using KKAPI.Utilities;
using MTSCapture.Core;
using UnityEngine;

namespace MTSCapture
{
    /// <summary>The compact capture window (IMGUI): event, key order, newest capture, target, actions.</summary>
    public partial class MTSCapturePlugin
    {
        private const int WindowId = 0x4D5443; // "MTC"
        private const float Width = 380f;
        private const float MaxHeight = 700f;
        private Rect windowRect = new Rect(80, 80, Width, 200);
        private Vector2 listScroll;
        private GUIStyle warnStyle, okStyle, smallStyle, selectedStyle, rowStyle;

        private void OnGUI()
        {
            if (!windowVisible) return;
            InitStyles();
            windowRect.width = Width;
            windowRect.height = Mathf.Min(windowRect.height, MaxHeight);
            IMGUIUtils.DrawSolidBox(windowRect);
            windowRect = GUILayout.Window(WindowId, windowRect, DrawWindow, PluginName, GUILayout.Width(Width), GUILayout.MaxHeight(MaxHeight));
            IMGUIUtils.EatInputInRect(windowRect);
        }

        private void InitStyles()
        {
            if (warnStyle != null) return;
            warnStyle = new GUIStyle(GUI.skin.label) { wordWrap = true, fontStyle = FontStyle.Bold };
            warnStyle.normal.textColor = new Color(1f, 0.55f, 0.35f);
            okStyle = new GUIStyle(GUI.skin.label) { wordWrap = true };
            okStyle.normal.textColor = new Color(0.55f, 0.9f, 0.55f);
            smallStyle = new GUIStyle(GUI.skin.label) { fontSize = 11, wordWrap = true };
            rowStyle = new GUIStyle(GUI.skin.button) { alignment = TextAnchor.MiddleLeft, fontSize = 11, wordWrap = false };
            selectedStyle = new GUIStyle(rowStyle) { fontStyle = FontStyle.Bold };
            selectedStyle.normal.textColor = new Color(1f, 0.85f, 0.3f);
        }

        private void DrawWindow(int id)
        {
            GUILayout.BeginHorizontal();
            GUILayout.FlexibleSpace();
            if (GUILayout.Button("X", GUILayout.Width(24))) SetWindowVisible(false);
            GUILayout.EndHorizontal();

            if (UpdateAvailable != null)
            {
                GUILayout.BeginHorizontal();
                GUILayout.Label("Update available: " + UpdateAvailable.Version + " (installed " + Version + ")", okStyle);
                if (GUILayout.Button("Open release", GUILayout.Width(100))) OpenUpdate();
                GUILayout.EndHorizontal();
            }
            DrawEventHeader();
            if (Bridge != null && Bridge.Event != null)
            {
                DrawModeAndOrder();
                DrawCapture();
                DrawTarget();
                DrawActions();
            }
            if (!string.IsNullOrEmpty(Status)) GUILayout.Label(Status, StatusIsError ? warnStyle : smallStyle);
            GUI.DragWindow();
        }

        private void DrawEventHeader()
        {
            if (BridgeError != null)
            {
                GUILayout.Label(BridgeError, warnStyle);
                return;
            }
            if (Bridge == null) return;
            if (Bridge.Event == null)
            {
                GUILayout.Label("No event open in the VS Code event editor.", smallStyle);
                return;
            }
            GUILayout.Label("<b>" + Bridge.Event + "</b>  <size=10>" + (Bridge.File ?? "") + "</size>", new GUIStyle(GUI.skin.label) { richText = true, wordWrap = true });
            int missing = 0, total = 0;
            foreach (var t in Bridge.Targets)
            {
                if (t.IsWildcard) continue;
                total++;
                if (t.Status == TargetStatus.Missing && !IsDone(t)) missing++;
            }
            var age = Bridge.Written == default(DateTime) ? "" : "  · updated " + Bridge.Written.ToLocalTime().ToString("HH:mm:ss");
            GUILayout.Label(missing + " of " + total + " images missing" + age + (Bridge.Truncated ? "  · list truncated" : ""), smallStyle);
            GUILayout.Label("Save location: " + CaptureFolder, smallStyle);
        }

        private void DrawModeAndOrder()
        {
            GUILayout.Space(4);
            GUILayout.BeginHorizontal();
            int mode = GUILayout.Toolbar(Mode.Value == CaptureMode.All ? 0 : 1, new[] { "All images", "Only missing" });
            var wanted = mode == 0 ? CaptureMode.All : CaptureMode.Missing;
            if (wanted != Mode.Value) Mode.Value = wanted;
            GUILayout.EndHorizontal();
            GUILayout.BeginHorizontal();
            bool wild = GUILayout.Toggle(IncludeWildcards.Value, " $ images");
            if (wild != IncludeWildcards.Value) IncludeWildcards.Value = wild;
            if (Mode.Value == CaptureMode.Missing)
            {
                bool cov = GUILayout.Toggle(WildcardCoveredIsMissing.Value, " $-covered = missing");
                if (cov != WildcardCoveredIsMissing.Value) WildcardCoveredIsMissing.Value = cov;
            }
            GUILayout.EndHorizontal();

            GUILayout.Label("Order (1 = changes slowest):", smallStyle);
            for (int i = 0; i < KeyOrder.Count; i++)
            {
                GUILayout.BeginHorizontal();
                GUILayout.Label((i + 1) + ". " + KeyOrder[i], GUILayout.Width(220));
                GUI.enabled = i > 0;
                if (GUILayout.Button("▲", GUILayout.Width(28))) MoveKey(i, -1);
                GUI.enabled = i < KeyOrder.Count - 1;
                if (GUILayout.Button("▼", GUILayout.Width(28))) MoveKey(i, +1);
                GUI.enabled = true;
                GUILayout.EndHorizontal();
            }
        }

        private void DrawCapture()
        {
            GUILayout.Space(6);
            if (CaptureTexture == null)
            {
                GUILayout.Label("Waiting for a new screenshot …", smallStyle);
                return;
            }
            float w = Width - 24;
            float h = w * CaptureHeight / Math.Max(1, CaptureWidth);
            var r = GUILayoutUtility.GetRect(w, Mathf.Min(h, 240));
            GUI.DrawTexture(r, CaptureTexture, ScaleMode.ScaleToFit);
            GUILayout.Label(Path.GetFileName(CapturePath) + "  ·  " + CaptureWidth + "×" + CaptureHeight, smallStyle);
        }

        private void DrawTarget()
        {
            GUILayout.Space(6);
            if (Listed.Count == 0)
            {
                GUILayout.Label(Mode.Value == CaptureMode.Missing ? "Nothing missing for this event." : "No images listed.", okStyle);
                return;
            }
            var t = SelectedTarget;
            GUILayout.BeginHorizontal();
            if (GUILayout.Button("<", GUILayout.Width(28))) Selected = (Selected - 1 + Listed.Count) % Listed.Count;
            GUILayout.Label("Target " + (Selected + 1) + " / " + Listed.Count, GUILayout.ExpandWidth(true));
            if (GUILayout.Button(">", GUILayout.Width(28))) Selected = (Selected + 1) % Listed.Count;
            GUILayout.EndHorizontal();
            if (t != null)
            {
                GUILayout.Label("<b>" + t.Describe(KeyOrder) + "</b>", new GUIStyle(GUI.skin.label) { richText = true, wordWrap = true });
                GUILayout.Label(Path.GetFileName(t.Path) + "   " + StateText(t), smallStyle);
            }

            listScroll = GUILayout.BeginScrollView(listScroll, GUILayout.Height(130));
            for (int i = 0; i < Listed.Count; i++)
            {
                var row = Listed[i];
                var label = (IsDone(row) ? "[ok] " : row.Status == TargetStatus.Missing ? "[  ] " : row.Status == TargetStatus.Wildcard ? "[$] " : "[==] ") + row.Describe(KeyOrder);
                if (GUILayout.Button(label, i == Selected ? selectedStyle : rowStyle)) { Selected = i; PendingOverwriteId = null; }
            }
            GUILayout.EndScrollView();
        }

        private string StateText(CaptureTarget t)
        {
            if (IsDone(t)) return "(assigned)";
            if (File.Exists(t.Path)) return "(exists — will be replaced)";
            var others = Assigner.SiblingFormats(t.Path);
            if (others.Count > 0)
                return MoveOtherFormats.Value
                    ? "(exists as " + Path.GetExtension(others[0]) + " — it is moved to the backup, the game then shows the PNG)"
                    : "(exists as " + Path.GetExtension(others[0]) + " — PNG is added next to it; the game keeps showing the " + Path.GetExtension(others[0]) + " until converted)";
            if (t.Status == TargetStatus.Wildcard) return "(only a $ file serves it)";
            return t.IsWildcard ? "($ image, missing)" : "(missing)";
        }

        private void DrawActions()
        {
            GUILayout.Space(6);
            var t = SelectedTarget;
            if (SizeMismatch)
                GUILayout.Label("(!) The capture is " + CaptureWidth + "×" + CaptureHeight + ", expected " + TargetWidth.Value + "×" + TargetHeight.Value + ".", warnStyle);
            if (t != null && PendingOverwriteId == t.Id)
                GUILayout.Label("(!) Click again to replace the existing file.", warnStyle);
            GUILayout.BeginHorizontal();
            GUI.enabled = t != null && CaptureTexture != null;
            if (GUILayout.Button(PendingOverwriteId != null && t != null && PendingOverwriteId == t.Id ? "Replace" : "Assign", GUILayout.Height(28))) AssignSelected();
            GUI.enabled = Listed.Count > 0;
            if (GUILayout.Button("Skip", GUILayout.Height(28), GUILayout.Width(60))) { Selected = (Selected + 1) % Listed.Count; PendingOverwriteId = null; }
            GUI.enabled = CanUndo;
            if (GUILayout.Button("Undo", GUILayout.Height(28), GUILayout.Width(60))) UndoLast();
            GUI.enabled = true;
            GUILayout.EndHorizontal();
        }
    }
}
