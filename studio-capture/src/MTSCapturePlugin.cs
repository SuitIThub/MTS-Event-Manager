using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using BepInEx;
using BepInEx.Bootstrap;
using BepInEx.Configuration;
using KKAPI;
using KKAPI.Studio;
using KKAPI.Studio.UI.Toolbars;
using MTSCapture.Core;
using UnityEngine;

namespace MTSCapture
{
    /// <summary>
    /// MTS Capture: assigns StudioNeoV2 screenshots to the images of the event open in the
    /// VS Code MTS Event Manager. The extension writes the event's image targets into a JSON
    /// bridge file; this plugin watches that file and the screenshot folder, shows the newest
    /// capture and copies it — renamed — to the chosen target.
    /// </summary>
    [BepInPlugin(GUID, PluginName, Version)]
    [BepInDependency(KoikatuAPI.GUID, KoikatuAPI.VersionConst)]
    [BepInProcess("StudioNEOV2")]
    public partial class MTSCapturePlugin : BaseUnityPlugin
    {
        // Generated from the project (BepInEx.PluginInfoProps); the version is the repo's package.json version.
        public const string GUID = PluginInfo.PLUGIN_GUID;
        public const string PluginName = PluginInfo.PLUGIN_NAME;
        public const string Version = PluginInfo.PLUGIN_VERSION;

        private const string ScreencapGuid = "com.bepis.bepinex.screenshotmanager";

        internal ConfigEntry<string> CaptureFolderSetting;
        internal ConfigEntry<string> BridgeFileSetting;
        internal ConfigEntry<int> TargetWidth;
        internal ConfigEntry<int> TargetHeight;
        internal ConfigEntry<OriginalHandling> Original;
        internal ConfigEntry<bool> OnlyNewCaptures;
        internal ConfigEntry<bool> MoveOtherFormats;
        internal ConfigEntry<CaptureMode> Mode;
        internal ConfigEntry<bool> IncludeWildcards;
        internal ConfigEntry<bool> WildcardCoveredIsMissing;
        internal ConfigEntry<KeyboardShortcut> ToggleKey;
        internal ConfigEntry<KeyboardShortcut> ConfirmKey;

        private SimpleToolbarToggle toolbarToggle;
        private bool windowVisible;

        // ── Bridge state ──
        internal BridgeData Bridge;
        internal string BridgeError;
        private DateTime bridgeMtime;
        private readonly HashSet<string> done = new HashSet<string>();
        private readonly Stack<Assignment> history = new Stack<Assignment>();
        private Dictionary<string, List<string>> savedOrders = new Dictionary<string, List<string>>();
        internal List<string> KeyOrder = new List<string>();
        internal List<CaptureTarget> Listed = new List<CaptureTarget>();
        internal int Selected;

        // ── Capture state ──
        internal string CapturePath;
        internal Texture2D CaptureTexture;
        internal int CaptureWidth, CaptureHeight;
        private readonly DateTime sessionStart = DateTime.Now;
        private DateTime captureDirMtime;
        private DateTime lastCaptureWrite;
        private readonly Dictionary<string, long> pendingSizes = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        private float nextPoll;
        private float nextFullScan;

        internal string Status = "";
        internal bool StatusIsError;
        internal string PendingOverwriteId;

        private void Awake()
        {
            const string general = "1. General";
            const string list = "2. Target list";
            const string keys = "3. Hotkeys";
            CaptureFolderSetting = Config.Bind(general, "Screenshot folder", "",
                new ConfigDescription("Folder watched for new screenshots. Empty: the screenshot folder of the game's Screencap plugin (default UserData\\cap)."));
            BridgeFileSetting = Config.Bind(general, "Bridge file", "",
                new ConfigDescription("JSON file written by the VS Code MTS Event Manager. Empty: %LOCALAPPDATA%\\MTS-Event-Manager\\capture\\active-event.json."));
            TargetWidth = Config.Bind(general, "Expected width", 1920, new ConfigDescription("Captures of another size show a warning.", new AcceptableValueRange<int>(1, 16384)));
            TargetHeight = Config.Bind(general, "Expected height", 1080, new ConfigDescription("Captures of another size show a warning.", new AcceptableValueRange<int>(1, 16384)));
            Original = Config.Bind(general, "Screenshot after assigning", OriginalHandling.MoveToAssigned,
                "Keep it, move it into an \"assigned\" subfolder, or delete it (kept in the backup folder so undo works).");
            OnlyNewCaptures = Config.Bind(general, "Only new screenshots", true, "Only screenshots taken after the studio started are offered.");
            MoveOtherFormats = Config.Bind(general, "Move older .webp aside", true,
                "The game loads the pattern's extension first (usually .webp), so an existing .webp of the same image would hide the new PNG until it is converted. " +
                "On: that file is moved into the backup folder when a capture is assigned (undo restores it). Off: it stays, the game keeps showing it.");
            Mode = Config.Bind(list, "Mode", CaptureMode.Missing, "All: every image of the event (existing ones are replaced after a confirm). Missing: only images without a file.");
            IncludeWildcards = Config.Bind(list, "Offer $ images", false, "Also list \"$\" images — one file that serves every value of a key (e.g. every level).");
            WildcardCoveredIsMissing = Config.Bind(list, "$-covered counts as missing", true, "Missing mode: an image that only a \"$\" file serves is still listed.");
            ToggleKey = Config.Bind(keys, "Toggle window", KeyboardShortcut.Empty, "Opens / closes the MTS Capture window.");
            ConfirmKey = Config.Bind(keys, "Assign capture", KeyboardShortcut.Empty, "Assigns the shown capture to the selected target (same as the button).");

            Mode.SettingChanged += (s, e) => RebuildList(keepSelection: true);
            IncludeWildcards.SettingChanged += (s, e) => RebuildList(keepSelection: true);
            WildcardCoveredIsMissing.SettingChanged += (s, e) => RebuildList(keepSelection: true);

            savedOrders = TargetOrdering.ParseSaved(ReadText(OrdersFile));
        }

        private void Start()
        {
            if (!StudioAPI.InsideStudio) return;
            toolbarToggle = new SimpleToolbarToggle(GUID + ".window", "MTS Capture — assign screenshots to event images",
                MakeIcon, false, this, on => windowVisible = on);
            ToolbarManager.AddLeftToolbarControl(toolbarToggle);
        }

        internal void SetWindowVisible(bool visible)
        {
            windowVisible = visible;
            if (toolbarToggle != null && toolbarToggle.Toggled.Value != visible) toolbarToggle.Toggled.OnNext(visible);
        }

        // ── Paths ──

        internal string BridgePath
        {
            get
            {
                var configured = (BridgeFileSetting.Value ?? "").Trim();
                if (configured.Length > 0) return configured;
                var local = Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AppData\\Local");
                return Path.Combine(Path.Combine(Path.Combine(local, "MTS-Event-Manager"), "capture"), "active-event.json");
            }
        }

        internal string BackupDir => Path.Combine(Path.GetDirectoryName(BridgePath) ?? Paths.ConfigPath, "backup");

        private string OrdersFile => Path.Combine(Paths.ConfigPath, GUID + ".orders.txt");

        /// <summary>The configured folder, else the Screencap plugin's save folder, else UserData\cap.</summary>
        internal string CaptureFolder
        {
            get
            {
                var configured = (CaptureFolderSetting.Value ?? "").Trim();
                if (configured.Length > 0) return Path.IsPathRooted(configured) ? configured : Path.Combine(Paths.GameRootPath, configured);
                if (Chainloader.PluginInfos.TryGetValue(ScreencapGuid, out var info) && info.Instance != null &&
                    info.Instance.Config.TryGetEntry<string>("General", "Screenshot save folder (relative to game)", out var entry) &&
                    !string.IsNullOrEmpty(entry.Value))
                    return Path.IsPathRooted(entry.Value) ? entry.Value : Path.Combine(Paths.GameRootPath, entry.Value);
                return Path.Combine(Path.Combine(Paths.GameRootPath, "UserData"), "cap");
            }
        }

        // ── Polling (main thread, once per second) ──

        private void Update()
        {
            if (ToggleKey.Value.IsDown()) SetWindowVisible(!windowVisible);
            if (windowVisible && ConfirmKey.Value.IsDown()) AssignSelected();
            if (!windowVisible || Time.unscaledTime < nextPoll) return;
            nextPoll = Time.unscaledTime + 1f;
            PollBridge();
            PollCaptures();
        }

        private void PollBridge()
        {
            var file = BridgePath;
            try
            {
                if (!File.Exists(file))
                {
                    if (Bridge != null || BridgeError == null) { Bridge = null; BridgeError = "No bridge file yet — open an event in the VS Code event editor."; Listed.Clear(); }
                    return;
                }
                var mtime = File.GetLastWriteTimeUtc(file);
                if (mtime == bridgeMtime) return;
                var data = BridgeData.FromJson(ReadText(file));
                bridgeMtime = mtime;
                bool sameEvent = Bridge != null && Bridge.Event == data.Event;
                Bridge = data;
                BridgeError = null;
                if (!sameEvent)
                {
                    done.Clear();
                    PendingOverwriteId = null;
                    KeyOrder = TargetOrdering.Normalize(data.Event != null && savedOrders.TryGetValue(data.Event, out var saved) ? saved : null, data);
                }
                else
                {
                    KeyOrder = TargetOrdering.Normalize(KeyOrder, data);
                }
                // Targets the extension now reports as existing are no longer "done locally".
                done.RemoveWhere(id => data.Targets.All(t => t.Id != id));
                RebuildList(keepSelection: sameEvent);
            }
            catch (IOException)
            {
                // Being written right now — next poll.
            }
            catch (Exception e)
            {
                BridgeError = "Bridge file unreadable: " + e.Message;
                bridgeMtime = default(DateTime);
            }
        }

        private void PollCaptures()
        {
            var dir = CaptureFolder;
            if (!Directory.Exists(dir)) return;
            var mtime = Directory.GetLastWriteTimeUtc(dir);
            // A new file changes the folder's time; rescan anyway every few seconds (network drives…).
            if (mtime == captureDirMtime && pendingSizes.Count == 0 && Time.unscaledTime < nextFullScan) return;
            captureDirMtime = mtime;
            nextFullScan = Time.unscaledTime + 5f;
            FileInfo newest = null;
            foreach (var f in new DirectoryInfo(dir).GetFiles())
            {
                var ext = f.Extension.ToLowerInvariant();
                if (ext != ".png" && ext != ".jpg" && ext != ".jpeg") continue;
                if (OnlyNewCaptures.Value && f.LastWriteTime < sessionStart) continue;
                if (f.LastWriteTime <= lastCaptureWrite) continue;
                if (newest == null || f.LastWriteTime > newest.LastWriteTime) newest = f;
            }
            if (newest == null) return;
            // Wait until the file is complete: same size on two polls and readable.
            if (!pendingSizes.TryGetValue(newest.FullName, out var size) || size != newest.Length)
            {
                pendingSizes[newest.FullName] = newest.Length;
                return;
            }
            pendingSizes.Clear();
            if (LoadCapture(newest.FullName)) lastCaptureWrite = newest.LastWriteTime;
        }

        internal bool LoadCapture(string path)
        {
            byte[] bytes;
            try { bytes = File.ReadAllBytes(path); }
            catch (IOException) { return false; }
            var tex = new Texture2D(2, 2, TextureFormat.RGB24, false);
            if (!tex.LoadImage(bytes))
            {
                Destroy(tex);
                SetStatus("Could not read " + Path.GetFileName(path), true);
                return true;
            }
            if (CaptureTexture != null) Destroy(CaptureTexture);
            CaptureTexture = tex;
            CapturePath = path;
            CaptureWidth = tex.width;
            CaptureHeight = tex.height;
            PendingOverwriteId = null;
            SetStatus("New capture: " + Path.GetFileName(path), false);
            return true;
        }

        // ── List ──

        internal ListOptions Options => new ListOptions
        {
            Mode = Mode.Value,
            IncludeWildcardTargets = IncludeWildcards.Value,
            WildcardCoveredIsMissing = WildcardCoveredIsMissing.Value,
        };

        internal void RebuildList(bool keepSelection)
        {
            var current = keepSelection && Selected >= 0 && Selected < Listed.Count ? Listed[Selected].Id : null;
            Listed = Bridge == null ? new List<CaptureTarget>() : TargetOrdering.Build(Bridge, KeyOrder, Options, done);
            int idx = current == null ? -1 : Listed.FindIndex(t => t.Id == current);
            Selected = idx >= 0 ? idx : Math.Min(Math.Max(0, Selected), Math.Max(0, Listed.Count - 1));
            if (!keepSelection) Selected = 0;
            PendingOverwriteId = null;
        }

        internal void MoveKey(int index, int delta)
        {
            int to = index + delta;
            if (index < 0 || to < 0 || to >= KeyOrder.Count) return;
            var k = KeyOrder[index];
            KeyOrder.RemoveAt(index);
            KeyOrder.Insert(to, k);
            if (Bridge?.Event != null)
            {
                savedOrders[Bridge.Event] = new List<string>(KeyOrder);
                try { File.WriteAllText(OrdersFile, TargetOrdering.SerializeSaved(savedOrders)); }
                catch (Exception e) { Logger.LogWarning("Could not save the key order: " + e.Message); }
            }
            Selected = 0;
            RebuildList(keepSelection: false);
        }

        internal CaptureTarget SelectedTarget => Selected >= 0 && Selected < Listed.Count ? Listed[Selected] : null;

        internal bool IsDone(CaptureTarget t) => done.Contains(t.Id);

        internal bool SizeMismatch => CaptureTexture != null && (CaptureWidth != TargetWidth.Value || CaptureHeight != TargetHeight.Value);

        // ── Assign / undo ──

        internal void AssignSelected()
        {
            var target = SelectedTarget;
            if (target == null || CapturePath == null || Bridge == null) return;
            bool exists = File.Exists(target.Path);
            if (exists && PendingOverwriteId != target.Id)
            {
                PendingOverwriteId = target.Id;
                SetStatus("The target exists — click again to replace it (the old file is backed up).", true);
                return;
            }
            try
            {
                byte[] bytes = File.ReadAllBytes(CapturePath);
                // JPG captures are re-encoded; PNG files are copied byte for byte.
                byte[] png = FileSafety.IsPng(bytes) ? bytes : CaptureTexture.EncodeToPNG();
                var a = Assigner.Assign(target, CapturePath, png, Bridge.AllowedRoots, BackupDir, Original.Value, exists, MoveOtherFormats.Value);
                history.Push(a);
                done.Add(target.Id);
                Logger.LogInfo("Assigned " + a.Source + " → " + a.Target);
                var moved = a.SiblingBackups.Count > 0 ? " · old " + string.Join(", ", a.SiblingBackups.Select(s => Path.GetExtension(s.Key)).ToArray()) + " moved to backup" : "";
                SetStatus("Saved " + Path.GetFileName(a.Target) + moved + (SizeMismatch ? " (size differs!)" : ""), false);
                foreach (var s in a.SiblingBackups) Logger.LogInfo("Moved aside " + s.Key + " → " + s.Value);
                PendingOverwriteId = null;
                ClearCapture();
                int keep = Selected;
                RebuildList(keepSelection: false);
                Selected = Mode.Value == CaptureMode.All ? Math.Min(keep + 1, Math.Max(0, Listed.Count - 1)) : Math.Min(keep, Math.Max(0, Listed.Count - 1));
            }
            catch (Exception e)
            {
                SetStatus(e.Message, true);
                Logger.LogWarning("Assign failed: " + e);
            }
        }

        internal bool CanUndo => history.Count > 0;

        internal void UndoLast()
        {
            if (history.Count == 0) return;
            var a = history.Peek();
            try
            {
                Assigner.Undo(a);
                history.Pop();
                done.Remove(a.TargetId);
                RebuildList(keepSelection: false);
                int idx = Listed.FindIndex(t => t.Id == a.TargetId);
                if (idx >= 0) Selected = idx;
                if (a.Source != null && File.Exists(a.Source)) LoadCapture(a.Source);
                SetStatus("Undone: " + Path.GetFileName(a.Target), false);
            }
            catch (Exception e)
            {
                SetStatus("Undo failed: " + e.Message, true);
            }
        }

        internal void ClearCapture()
        {
            if (CaptureTexture != null) Destroy(CaptureTexture);
            CaptureTexture = null;
            CapturePath = null;
        }

        internal void SetStatus(string text, bool error)
        {
            Status = text;
            StatusIsError = error;
        }

        private static string ReadText(string file)
        {
            try
            {
                using (var s = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var r = new StreamReader(s))
                    return r.ReadToEnd();
            }
            catch (FileNotFoundException) { return ""; }
            catch (DirectoryNotFoundException) { return ""; }
        }

        /// <summary>A small camera glyph for the toolbar (no embedded assets).</summary>
        private static Texture2D MakeIcon()
        {
            const int n = 32;
            var tex = new Texture2D(n, n, TextureFormat.ARGB32, false);
            var clear = new Color(0, 0, 0, 0);
            var body = new Color(0.95f, 0.95f, 0.95f, 1f);
            var lens = new Color(0.2f, 0.55f, 0.95f, 1f);
            for (int y = 0; y < n; y++)
                for (int x = 0; x < n; x++)
                {
                    bool inBody = x >= 3 && x <= 28 && y >= 6 && y <= 23;
                    bool inTop = x >= 10 && x <= 18 && y >= 23 && y <= 27;
                    float dx = x - 15.5f, dy = y - 14.5f;
                    float r = Mathf.Sqrt(dx * dx + dy * dy);
                    tex.SetPixel(x, y, r <= 5.5f ? lens : r <= 7f ? clear : inBody || inTop ? body : clear);
                }
            tex.Apply();
            return tex;
        }

        private void OnDestroy()
        {
            ClearCapture();
        }
    }
}
