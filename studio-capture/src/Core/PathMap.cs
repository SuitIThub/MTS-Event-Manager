using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace MTSCapture.Core
{
    /// <summary>
    /// VS Code on Linux / macOS, the studio under Wine / Proton: the extension writes Unix paths
    /// (/home/me/game/images/…); Wine sees the Unix file system as a drive (Z:\ by default).
    /// Unix paths from the bridge are mapped onto that drive, everything else is left alone.
    /// </summary>
    public sealed class PathMap
    {
        /// <summary>Drive Wine maps "/" to, e.g. "Z:". Null: no mapping (plain Windows).</summary>
        public readonly string UnixDrive;

        public PathMap(string unixDrive)
        {
            unixDrive = (unixDrive ?? "").Trim().TrimEnd('\\', '/');
            UnixDrive = unixDrive.Length == 2 && char.IsLetter(unixDrive[0]) && unixDrive[1] == ':' ? unixDrive.ToUpperInvariant() : null;
        }

        public static bool IsUnixPath(string p) => !string.IsNullOrEmpty(p) && p[0] == '/' && !p.StartsWith("//", StringComparison.Ordinal);

        /// <summary>"/home/me/x.png" → "Z:\home\me\x.png"; other paths unchanged.</summary>
        public string ToLocal(string p)
        {
            if (UnixDrive == null || !IsUnixPath(p)) return p;
            return UnixDrive + p.Replace('/', '\\');
        }

        /// <summary>Map every path of a bridge in place (targets, existing files, allowed roots).</summary>
        public void Apply(BridgeData b)
        {
            if (UnixDrive == null || b == null) return;
            foreach (var t in b.Targets)
            {
                t.Path = ToLocal(t.Path);
                t.Existing = ToLocal(t.Existing);
            }
            b.AllowedRoots = b.AllowedRoots.Select(ToLocal).ToList();
        }

        /// <summary>
        /// Wine's drive for "/": the setting if given ("auto" = detect), else the first drive whose
        /// root holds the Unix root (Z: unless the prefix was changed). Null on plain Windows.
        /// </summary>
        public static PathMap Detect(string setting, Func<string, bool> directoryExists, bool underWine)
        {
            var s = (setting ?? "").Trim();
            if (s.Length > 0 && !s.Equals("auto", StringComparison.OrdinalIgnoreCase))
                return new PathMap(s.Equals("off", StringComparison.OrdinalIgnoreCase) ? null : s);
            if (!underWine) return new PathMap(null);
            foreach (var d in new[] { "Z", "Y", "X" })
                if (directoryExists(d + @":\etc") && directoryExists(d + @":\usr")) return new PathMap(d + ":");
            return new PathMap("Z:");
        }

        /// <summary>
        /// The bridge file's default location under Wine: the same file the extension uses on
        /// Linux / macOS ($XDG_DATA_HOME or ~/.local/share, …/MTS-Event-Manager/capture/active-event.json).
        /// </summary>
        public string DefaultUnixBridgeFile(IDictionary<string, string> env)
        {
            if (UnixDrive == null) return null;
            env.TryGetValue("XDG_DATA_HOME", out var xdg);
            env.TryGetValue("HOME", out var home);
            string baseDir = IsUnixPath(xdg) ? xdg : IsUnixPath(home) ? home.TrimEnd('/') + "/.local/share" : null;
            return baseDir == null ? null : ToLocal(baseDir.TrimEnd('/') + "/MTS-Event-Manager/capture/active-event.json");
        }
    }
}
