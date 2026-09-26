using System;
using System.Collections.Generic;

namespace MTSCapture.Core
{
    /// <summary>The newest GitHub release of MTS Event Manager (extension + this plugin).</summary>
    public sealed class ReleaseInfo
    {
        public string Version;
        /// <summary>Link to the release post.</summary>
        public string Url;
    }

    /// <summary>Version comparison and parsing of GitHub's `releases/latest` response.</summary>
    public static class UpdateCheck
    {
        public const string ReleasesApi = "https://api.github.com/repos/SuitIThub/MTS-Event-Manager/releases/latest";

        /// <summary>"v1.2.3" / "1.2.3" → [1, 2, 3]; null for anything else.</summary>
        public static int[] ParseVersion(string v)
        {
            if (string.IsNullOrEmpty(v)) return null;
            var s = v.Trim();
            if (s.StartsWith("v", StringComparison.OrdinalIgnoreCase)) s = s.Substring(1);
            var parts = s.Split('.');
            if (parts.Length != 3) return null;
            var n = new int[3];
            for (int i = 0; i < 3; i++)
                if (parts[i].Length == 0 || !int.TryParse(parts[i], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out n[i]))
                    return null;
            return n;
        }

        public static bool IsNewer(string candidate, string current)
        {
            var a = ParseVersion(candidate);
            var b = ParseVersion(current);
            if (a == null || b == null) return false;
            for (int i = 0; i < 3; i++)
                if (a[i] != b[i]) return a[i] > b[i];
            return false;
        }

        /// <summary>The release from the API response; drafts, pre-releases and foreign links never count.</summary>
        public static ReleaseInfo FromJson(string json)
        {
            Dictionary<string, object> r;
            try { r = Json.Parse(json) as Dictionary<string, object>; }
            catch (FormatException) { return null; }
            if (r == null) return null;
            if (r.TryGetValue("draft", out var d) && d is bool db && db) return null;
            if (r.TryGetValue("prerelease", out var p) && p is bool pb && pb) return null;
            var tag = r.TryGetValue("tag_name", out var t) ? t as string : null;
            var url = r.TryGetValue("html_url", out var u) ? u as string : null;
            if (ParseVersion(tag) == null || url == null || !url.StartsWith("https://github.com/", StringComparison.Ordinal)) return null;
            return new ReleaseInfo { Version = tag.TrimStart('v', 'V'), Url = url };
        }
    }
}
