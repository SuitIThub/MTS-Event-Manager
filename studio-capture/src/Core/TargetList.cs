using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace MTSCapture.Core
{
    public enum CaptureMode
    {
        /// <summary>Every image of the event, existing ones too (re-shoots overwrite after a confirm).</summary>
        All,
        /// <summary>Only images that have no file yet.</summary>
        Missing,
    }

    public sealed class ListOptions
    {
        public CaptureMode Mode = CaptureMode.Missing;
        /// <summary>Offer "$" files (one image for every value of a key) as extra targets.</summary>
        public bool IncludeWildcardTargets;
        /// <summary>Missing mode: an image only served by a "$" file still counts as missing.</summary>
        public bool WildcardCoveredIsMissing = true;
    }

    /// <summary>
    /// Which targets are listed and in which order. The key order is the nesting of the
    /// loops: the first key changes slowest. "Level, then uniform" lists every uniform of
    /// level 1, then every uniform of level 2, …
    /// </summary>
    public static class TargetOrdering
    {
        public static List<string> DefaultOrder(BridgeData b)
        {
            var order = new List<string> { BridgeData.PatternKey };
            order.AddRange(b.Keys.Where(k => k != BridgeData.PatternKey));
            return order;
        }

        /// <summary>A saved order adapted to the event: unknown keys dropped, new keys appended.</summary>
        public static List<string> Normalize(IEnumerable<string> saved, BridgeData b)
        {
            var valid = DefaultOrder(b);
            var result = (saved ?? Enumerable.Empty<string>()).Where(valid.Contains).Distinct().ToList();
            result.AddRange(valid.Where(k => !result.Contains(k)));
            return result;
        }

        public static bool IsListed(CaptureTarget t, ListOptions o, ISet<string> done)
        {
            if (t.IsWildcard && !o.IncludeWildcardTargets) return false;
            if (o.Mode == CaptureMode.All) return true;
            if (done != null && done.Contains(t.Id)) return false;
            return t.Status == TargetStatus.Missing || (t.Status == TargetStatus.Wildcard && o.WildcardCoveredIsMissing);
        }

        public static List<CaptureTarget> Build(BridgeData b, IList<string> order, ListOptions o, ISet<string> done)
        {
            var patternRank = new Dictionary<string, int>();
            foreach (var t in b.Targets)
                if (!patternRank.ContainsKey(t.Pattern)) patternRank[t.Pattern] = patternRank.Count;
            var listed = b.Targets.Where(t => IsListed(t, o, done)).ToList();
            listed.Sort((x, y) =>
            {
                foreach (var key in order)
                {
                    int c = key == BridgeData.PatternKey
                        ? Rank(patternRank, x.Pattern).CompareTo(Rank(patternRank, y.Pattern))
                        : CompareValue(b, key, x, y);
                    if (c != 0) return c;
                }
                return string.CompareOrdinal(x.Id, y.Id);
            });
            return listed;
        }

        private static int Rank(Dictionary<string, int> ranks, string p) => ranks.TryGetValue(p, out var r) ? r : int.MaxValue;

        private static int CompareValue(BridgeData b, string key, CaptureTarget x, CaptureTarget y)
        {
            bool hx = x.Values.TryGetValue(key, out var vx);
            bool hy = y.Values.TryGetValue(key, out var vy);
            if (!hx || !hy) return hx == hy ? 0 : hx ? 1 : -1;
            if (vx == vy) return 0;
            if (b.KeyValues.TryGetValue(key, out var domain))
            {
                int ix = domain.IndexOf(vx), iy = domain.IndexOf(vy);
                if (ix >= 0 && iy >= 0) return ix.CompareTo(iy);
            }
            // "$" first, then numbers numerically, then text.
            if (vx == "$") return -1;
            if (vy == "$") return 1;
            if (double.TryParse(vx, NumberStyles.Float, CultureInfo.InvariantCulture, out var nx) &&
                double.TryParse(vy, NumberStyles.Float, CultureInfo.InvariantCulture, out var ny))
                return nx.CompareTo(ny);
            return string.Compare(vx, vy, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>Serialized order per event ("event\tkey,key" lines) — kept in the plugin's config folder.</summary>
        public static Dictionary<string, List<string>> ParseSaved(string text)
        {
            var d = new Dictionary<string, List<string>>();
            foreach (var line in (text ?? "").Split('\n'))
            {
                var tab = line.IndexOf('\t');
                if (tab <= 0) continue;
                d[line.Substring(0, tab).Trim()] = line.Substring(tab + 1).Trim().Split(',').Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
            }
            return d;
        }

        public static string SerializeSaved(Dictionary<string, List<string>> d) =>
            string.Join("\n", d.OrderBy(e => e.Key, StringComparer.Ordinal).Select(e => e.Key + "\t" + string.Join(",", e.Value.ToArray())).ToArray()) + "\n";
    }
}
