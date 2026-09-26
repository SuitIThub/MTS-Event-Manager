using System;
using System.Collections.Generic;
using System.Linq;

namespace MTSCapture.Core
{
    public enum TargetStatus { Exact, Wildcard, Missing }

    /// <summary>One image of the event: where a capture goes and what it currently is.</summary>
    public sealed class CaptureTarget
    {
        public string Id;
        public string Pattern;
        public int? Step;
        /// <summary>Placeholder values incl. "step"; "$" for a wildcard file.</summary>
        public Dictionary<string, string> Values = new Dictionary<string, string>();
        public TargetStatus Status;
        /// <summary>This target is a "$" file (serves every value of those keys).</summary>
        public bool IsWildcard;
        public string Path;
        public string Existing;
        public List<int> Lines = new List<int>();

        public string Describe(IList<string> keyOrder)
        {
            var parts = new List<string>();
            foreach (var k in keyOrder)
            {
                if (k == BridgeData.PatternKey) parts.Add(Pattern);
                else if (Values.TryGetValue(k, out var v)) parts.Add(k + "=" + v);
            }
            foreach (var kv in Values)
                if (!keyOrder.Contains(kv.Key)) parts.Add(kv.Key + "=" + kv.Value);
            return string.Join(" · ", parts.ToArray());
        }
    }

    /// <summary>The event the VS Code extension currently has open (active-event.json).</summary>
    public sealed class BridgeData
    {
        /// <summary>Pseudo key for sorting by pattern name (main, card, …).</summary>
        public const string PatternKey = "pattern";
        public const int SupportedVersion = 1;

        public int Version;
        public DateTime Written;
        public string Event;
        public string File;
        public List<string> Keys = new List<string>();
        public Dictionary<string, List<string>> KeyValues = new Dictionary<string, List<string>>();
        public List<string> AllowedRoots = new List<string>();
        public List<CaptureTarget> Targets = new List<CaptureTarget>();
        public bool Truncated;

        public static BridgeData FromJson(string json)
        {
            var root = Json.Parse(json) as Dictionary<string, object>;
            if (root == null) throw new FormatException("Bridge file is not a JSON object.");
            var b = new BridgeData
            {
                Version = (int)Num(root, "version"),
                Event = Str(root, "event"),
                File = Str(root, "file"),
                Truncated = root.TryGetValue("truncated", out var tr) && tr is bool tb && tb,
            };
            if (b.Version != SupportedVersion)
                throw new FormatException("Bridge version " + b.Version + " is not supported (expected " + SupportedVersion + ") — update the plugin or the extension.");
            DateTime.TryParse(Str(root, "written") ?? "", null, System.Globalization.DateTimeStyles.RoundtripKind, out b.Written);
            b.Keys = List(root, "keys").Select(o => o as string).Where(s => s != null).ToList();
            if (root.TryGetValue("keyValues", out var kvo) && kvo is Dictionary<string, object> kv)
                foreach (var e in kv)
                    b.KeyValues[e.Key] = (e.Value as List<object> ?? new List<object>()).Select(o => o as string).Where(s => s != null).ToList();
            b.AllowedRoots = List(root, "allowedRoots").Select(o => o as string).Where(s => !string.IsNullOrEmpty(s)).ToList();
            foreach (var o in List(root, "targets"))
            {
                if (!(o is Dictionary<string, object> t)) continue;
                var target = new CaptureTarget
                {
                    Id = Str(t, "id"),
                    Pattern = Str(t, "pattern") ?? "",
                    Step = t.TryGetValue("step", out var st) && st is double d ? (int?)(int)d : null,
                    Status = ParseStatus(Str(t, "status")),
                    IsWildcard = t.TryGetValue("wildcard", out var w) && w is bool wb && wb,
                    Path = Str(t, "path"),
                    Existing = Str(t, "existing"),
                };
                if (t.TryGetValue("values", out var vo) && vo is Dictionary<string, object> vals)
                    foreach (var e in vals)
                        if (e.Value is string sv) target.Values[e.Key] = sv;
                foreach (var l in List(t, "lines"))
                    if (l is double ld) target.Lines.Add((int)ld);
                if (!string.IsNullOrEmpty(target.Path) && !string.IsNullOrEmpty(target.Id)) b.Targets.Add(target);
            }
            return b;
        }

        private static TargetStatus ParseStatus(string s)
        {
            switch (s)
            {
                case "exact": return TargetStatus.Exact;
                case "wildcard": return TargetStatus.Wildcard;
                default: return TargetStatus.Missing;
            }
        }

        private static string Str(Dictionary<string, object> d, string k) => d.TryGetValue(k, out var v) ? v as string : null;
        private static double Num(Dictionary<string, object> d, string k) => d.TryGetValue(k, out var v) && v is double n ? n : 0;
        private static List<object> List(Dictionary<string, object> d, string k) => d.TryGetValue(k, out var v) && v is List<object> l ? l : new List<object>();
    }
}
