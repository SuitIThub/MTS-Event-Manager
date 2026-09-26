using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using MTSCapture.Core;

internal static class Program
{
    private static int failures;

    private static void Check(bool ok, string what)
    {
        if (!ok) failures++;
        Console.WriteLine((ok ? "ok   " : "FAIL ") + what);
    }

    private static int Main(string[] args)
    {
        var tmp = Path.Combine(Path.GetTempPath(), "mts-capture-tests-" + Guid.NewGuid().ToString("N"));
        var images = Path.Combine(tmp, "game", "images");
        Directory.CreateDirectory(images);
        try
        {
            JsonTests();
            var bridge = BridgeTests(images);
            OrderTests(bridge);
            SafetyTests(tmp, images);
            AssignTests(tmp, images, bridge);
            if (args.Length > 0) RealBridge(args[0]);
        }
        finally
        {
            Directory.Delete(tmp, true);
        }
        Console.WriteLine("capture plugin core problems: " + failures);
        return failures == 0 ? 0 : 1;
    }

    private static void JsonTests()
    {
        var o = (Dictionary<string, object>)Json.Parse("{\"a\": [1, 2.5, -3e2], \"b\": \"x\\\"y\\\\z\\u00e4\", \"c\": null, \"d\": true, \"e\": {}}");
        var a = (List<object>)o["a"];
        Check(a.Count == 3 && (double)a[1] == 2.5 && (double)a[2] == -300, "json: numbers");
        Check((string)o["b"] == "x\"y\\zä" && o["c"] == null && (bool)o["d"], "json: strings, escapes, null, bool");
        bool threw = false;
        try { Json.Parse("{\"a\": 1,}"); } catch (FormatException) { threw = true; }
        Check(threw, "json: malformed input throws");
    }

    private static string Esc(string s) => s.Replace("\\", "\\\\");

    private static BridgeData BridgeTests(string images)
    {
        var targets = new List<string>();
        foreach (var level in new[] { "$", "1", "2" })
            foreach (var uniform in new[] { "$", "a", "b" })
                foreach (var step in new[] { "0", "1" })
                {
                    bool wild = level == "$" || uniform == "$";
                    var path = Path.Combine(images, "ev", "ev " + level + " " + uniform + " " + step + ".png");
                    string status = !wild && level == "1" && uniform == "a" ? "exact" : "missing";
                    targets.Add("{\"id\":\"main|" + level + uniform + step + "\",\"pattern\":\"main\",\"step\":" + step +
                        ",\"values\":{\"school_level\":\"" + level + "\",\"uniform\":\"" + uniform + "\",\"step\":\"" + step + "\"}," +
                        "\"status\":\"" + status + "\",\"wildcard\":" + (wild ? "true" : "false") + ",\"path\":\"" + Esc(path) + "\",\"lines\":[3]}");
                }
        targets.Add("{\"id\":\"end|x\",\"pattern\":\"end\",\"step\":null,\"values\":{\"school_level\":\"1\"},\"status\":\"wildcard\",\"wildcard\":false,\"path\":\"" + Esc(Path.Combine(images, "ev", "end 1.png")) + "\",\"lines\":[]}");
        var json = "{\"version\":1,\"written\":\"2026-09-26T12:00:00.000Z\",\"event\":\"ev\",\"file\":\"x.rpy\"," +
                   "\"keys\":[\"school_level\",\"uniform\",\"step\"]," +
                   "\"keyValues\":{\"school_level\":[\"$\",\"1\",\"2\"],\"uniform\":[\"$\",\"a\",\"b\"],\"step\":[\"0\",\"1\"]}," +
                   "\"allowedRoots\":[\"" + Esc(images) + "\"],\"targets\":[" + string.Join(",", targets) + "]}";
        var b = BridgeData.FromJson(json);
        Check(b.Event == "ev" && b.Targets.Count == 19 && b.AllowedRoots.Count == 1 && b.Written.Year == 2026, "bridge: parsed event, targets, roots, time");
        Check(b.Targets.Count(t => t.IsWildcard) == 10 && b.Targets.Last().Step == null && b.Targets.Last().Status == TargetStatus.Wildcard, "bridge: wildcard flags, null step, status");
        bool threw = false;
        try { BridgeData.FromJson("{\"version\":2}"); } catch (FormatException) { threw = true; }
        Check(threw, "bridge: other versions are refused");
        return b;
    }

    private static void OrderTests(BridgeData b)
    {
        var order = TargetOrdering.Normalize(new[] { "uniform", "gone", "school_level" }, b);
        Check(string.Join(",", order) == "uniform,school_level,pattern,step", "order: saved order kept, unknown dropped, new appended");

        var missing = new ListOptions { Mode = CaptureMode.Missing };
        var byLevel = TargetOrdering.Build(b, new List<string> { "pattern", "school_level", "uniform", "step" }, missing, new HashSet<string>());
        Check(byLevel.All(t => !t.IsWildcard) && byLevel.All(t => t.Status != TargetStatus.Exact), "missing mode: no $ images, no existing ones");
        var seq = string.Join(" ", byLevel.Where(t => t.Pattern == "main").Select(t => t.Values["school_level"] + t.Values["uniform"] + t.Values["step"]));
        Check(seq == "1b0 1b1 2a0 2a1 2b0 2b1", "order level > uniform > step: " + seq);
        var byUniform = TargetOrdering.Build(b, new List<string> { "uniform", "school_level", "step", "pattern" }, missing, new HashSet<string>());
        var seq2 = string.Join(" ", byUniform.Where(t => t.Pattern == "main").Select(t => t.Values["school_level"] + t.Values["uniform"] + t.Values["step"]));
        Check(seq2 == "2a0 2a1 1b0 1b1 2b0 2b1", "order uniform > level > step: " + seq2);
        Check(byLevel.Any(t => t.Pattern == "end"), "missing mode: $-covered image listed by default");
        Check(!TargetOrdering.Build(b, order, new ListOptions { Mode = CaptureMode.Missing, WildcardCoveredIsMissing = false }, new HashSet<string>()).Any(t => t.Pattern == "end"), "missing mode: $-covered hidden when switched off");

        var withWild = TargetOrdering.Build(b, new List<string> { "pattern", "school_level", "uniform", "step" }, new ListOptions { Mode = CaptureMode.Missing, IncludeWildcardTargets = true }, new HashSet<string>());
        Check(withWild.First().Values["school_level"] == "$" && withWild.First().Values["uniform"] == "$", "$ images offered first when enabled");
        var all = TargetOrdering.Build(b, order, new ListOptions { Mode = CaptureMode.All }, new HashSet<string>());
        Check(all.Count == 9 && all.Any(t => t.Status == TargetStatus.Exact), "all mode: every image incl. existing (no $ images unless enabled)");
        var done = new HashSet<string> { byLevel[0].Id };
        Check(TargetOrdering.Build(b, order, missing, done).All(t => t.Id != byLevel[0].Id), "missing mode: assigned targets drop out");

        var saved = TargetOrdering.ParseSaved(TargetOrdering.SerializeSaved(new Dictionary<string, List<string>> { { "ev", order } }));
        Check(string.Join(",", saved["ev"]) == string.Join(",", order), "order: saved per event round-trips");
    }

    private static void SafetyTests(string tmp, string images)
    {
        var roots = new[] { images };
        Check(FileSafety.CheckTarget(Path.Combine(images, "ev", "x 1.png"), roots) == null, "safety: png under game/images accepted");
        Check(FileSafety.CheckTarget(Path.Combine(images, "ev", "..", "..", "x.png"), roots) != null, "safety: '..' refused");
        Check(FileSafety.CheckTarget(Path.Combine(tmp, "game", "scripts", "x.png"), roots) != null, "safety: outside images refused");
        Check(FileSafety.CheckTarget(Path.Combine(images, "ev", "x.rpy"), roots) != null, "safety: non-png refused");
        Check(FileSafety.CheckTarget(Path.Combine(tmp, "game", "x.png"), new[] { Path.Combine(tmp, "game") }) != null, "safety: a root that is not an images folder is ignored");
        Check(FileSafety.CheckTarget(images + "_evil" + Path.DirectorySeparatorChar + "x.png", roots) != null, "safety: sibling folder with the same prefix refused");

        var png = Png(1280, 720);
        Check(FileSafety.TryReadPngSize(png, out var w, out var h) && w == 1280 && h == 720, "png: size read from the header");
        Check(!FileSafety.TryReadPngSize(new byte[] { 0xFF, 0xD8, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, out _, out _), "png: jpg header is not a png");
    }

    private static void AssignTests(string tmp, string images, BridgeData b)
    {
        var caps = Path.Combine(tmp, "cap");
        Directory.CreateDirectory(caps);
        var backup = Path.Combine(tmp, "backup");
        var target = b.Targets.First(t => !t.IsWildcard && t.Status == TargetStatus.Missing);
        var src = Path.Combine(caps, "shot1.png");
        File.WriteAllBytes(src, Png(1920, 1080));

        var a = Assigner.Assign(target, src, File.ReadAllBytes(src), b.AllowedRoots, backup, OriginalHandling.MoveToAssigned, false);
        Check(File.Exists(target.Path) && !File.Exists(src) && File.Exists(Path.Combine(caps, "assigned", "shot1.png")), "assign: copied, folders created, original moved to assigned/");

        var src2 = Path.Combine(caps, "shot2.png");
        File.WriteAllBytes(src2, Png(1920, 1080, 7));
        bool refused = false;
        try { Assigner.Assign(target, src2, File.ReadAllBytes(src2), b.AllowedRoots, backup, OriginalHandling.Keep, false); }
        catch (InvalidOperationException) { refused = true; }
        Check(refused && File.ReadAllBytes(target.Path).Length == Png(1920, 1080).Length, "assign: existing target is never replaced without confirm");

        var a2 = Assigner.Assign(target, src2, File.ReadAllBytes(src2), b.AllowedRoots, backup, OriginalHandling.Keep, true);
        Check(a2.ReplacedBackup != null && File.Exists(a2.ReplacedBackup) && File.Exists(src2) && File.ReadAllBytes(target.Path).Length == Png(1920, 1080, 7).Length, "assign: confirmed replace backs the old file up, keeps the original");
        Assigner.Undo(a2);
        Check(File.ReadAllBytes(target.Path).Length == Png(1920, 1080).Length && !File.Exists(a2.ReplacedBackup), "undo: replaced file restored");
        Assigner.Undo(a);
        Check(!File.Exists(target.Path) && File.Exists(src), "undo: written file removed, original moved back");

        // The converted .webp of the same image: moved aside so the game shows the new PNG; undo restores it.
        var webp = Path.ChangeExtension(target.Path, ".webp");
        File.WriteAllBytes(webp, new byte[] { 9, 9, 9 });
        var srcW = Path.Combine(caps, "shotw.png");
        File.WriteAllBytes(srcW, Png(1920, 1080, 3));
        var keepW = Assigner.Assign(target, srcW, File.ReadAllBytes(srcW), b.AllowedRoots, backup, OriginalHandling.Keep, false, moveOtherFormats: false);
        Check(File.Exists(webp) && keepW.SiblingBackups.Count == 0, "other format kept when the option is off");
        Assigner.Undo(keepW);
        var aw = Assigner.Assign(target, srcW, File.ReadAllBytes(srcW), b.AllowedRoots, backup, OriginalHandling.Keep, false, moveOtherFormats: true);
        Check(File.Exists(target.Path) && !File.Exists(webp) && aw.SiblingBackups.Count == 1 && File.Exists(aw.SiblingBackups[0].Value),
            "old .webp moved to the backup when the PNG is assigned");
        Check(Assigner.SiblingFormats(target.Path).Count == 0, "no other format left next to the PNG");
        Assigner.Undo(aw);
        Check(!File.Exists(target.Path) && File.Exists(webp) && File.ReadAllBytes(webp).Length == 3, "undo puts the .webp back");
        File.Delete(webp);

        var outside = new CaptureTarget { Id = "x", Path = Path.Combine(tmp, "game", "scripts", "evil.png") };
        refused = false;
        try { Assigner.Assign(outside, src, File.ReadAllBytes(src), b.AllowedRoots, backup, OriginalHandling.Keep, true); }
        catch (InvalidOperationException) { refused = true; }
        Check(refused && !File.Exists(outside.Path), "assign: path outside images refused, nothing written");

        var a3 = Assigner.Assign(target, src, File.ReadAllBytes(src), b.AllowedRoots, backup, OriginalHandling.Delete, false);
        File.WriteAllBytes(target.Path, new byte[] { 1, 2, 3 });
        bool undoRefused = false;
        try { Assigner.Undo(a3); } catch (InvalidOperationException) { undoRefused = true; }
        Check(undoRefused && File.Exists(target.Path), "undo: refused when the file changed since");
    }

    private static void RealBridge(string file)
    {
        var b = BridgeData.FromJson(File.ReadAllText(file));
        var order = TargetOrdering.DefaultOrder(b);
        var missing = TargetOrdering.Build(b, order, new ListOptions(), new HashSet<string>());
        Check(b.Targets.Count > 0 && b.Targets.All(t => FileSafety.CheckTarget(t.Path, b.AllowedRoots) == null),
            "real bridge " + b.Event + ": " + b.Targets.Count + " targets, all paths allowed; " + missing.Count + " to capture, order " + string.Join(",", order));
        foreach (var t in missing.Take(3)) Console.WriteLine("     next: " + t.Describe(order) + " → " + Path.GetFileName(t.Path));
    }

    /// <summary>A minimal PNG (signature + IHDR only) — enough for header checks and copying.</summary>
    private static byte[] Png(int w, int h, int extra = 0)
    {
        var bytes = new List<byte> { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, (byte)'I', (byte)'H', (byte)'D', (byte)'R' };
        bytes.AddRange(new[] { (byte)(w >> 24), (byte)(w >> 16), (byte)(w >> 8), (byte)w, (byte)(h >> 24), (byte)(h >> 16), (byte)(h >> 8), (byte)h });
        bytes.AddRange(new byte[5 + extra]);
        return bytes.ToArray();
    }
}
