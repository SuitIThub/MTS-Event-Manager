using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace MTSCapture.Core
{
    public enum OriginalHandling
    {
        /// <summary>Leave the screenshot where it is.</summary>
        Keep,
        /// <summary>Move it into "assigned" next to it (keeps the capture folder tidy).</summary>
        MoveToAssigned,
        /// <summary>Remove it (moved into the backup folder, so undo still works).</summary>
        Delete,
    }

    /// <summary>One confirmed capture — everything needed to undo it.</summary>
    public sealed class Assignment
    {
        public string TargetId;
        public string Source;
        public string Target;
        /// <summary>The file the target replaced (moved aside), if any.</summary>
        public string ReplacedBackup;
        /// <summary>Where the original screenshot went (MoveToAssigned / Delete).</summary>
        public string SourceMovedTo;
        /// <summary>The same image in another format (the old .webp) moved aside: original path → backup path.</summary>
        public List<KeyValuePair<string, string>> SiblingBackups = new List<KeyValuePair<string, string>>();
        public DateTime When;
        /// <summary>Size of the written file — undo refuses when it changed since.</summary>
        public long WrittenLength;
    }

    public static class FileSafety
    {
        public const int PngHeaderLength = 24;
        private static readonly byte[] PngSignature = { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };

        /// <summary>
        /// Null when `target` may be written: a .png file inside one of the allowed roots, each
        /// an "images" folder of the game or a mod. Anything else returns the reason.
        /// </summary>
        public static string CheckTarget(string target, IEnumerable<string> allowedRoots)
        {
            if (string.IsNullOrEmpty(target)) return "No target path.";
            if (target.Replace('\\', '/').Split('/').Any(seg => seg == ".." || seg == ".")) return "Target path contains '..' — refused.";
            if (!target.EndsWith(".png", StringComparison.OrdinalIgnoreCase)) return "Target is not a .png file — refused.";
            string full;
            try { full = Path.GetFullPath(target); }
            catch (Exception e) { return "Invalid target path: " + e.Message; }
            foreach (var root in allowedRoots ?? Enumerable.Empty<string>())
            {
                string r;
                try { r = Path.GetFullPath(root).TrimEnd('\\', '/'); }
                catch { continue; }
                if (!string.Equals(Path.GetFileName(r), "images", StringComparison.OrdinalIgnoreCase)) continue;
                if (full.StartsWith(r + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return null;
            }
            return "Target is outside the game's images folders — refused.";
        }

        public static bool IsPng(byte[] data) => data != null && data.Length >= PngSignature.Length && PngSignature.SequenceEqual(data.Take(PngSignature.Length));

        /// <summary>Width/height from a PNG header (IHDR) without decoding the image.</summary>
        public static bool TryReadPngSize(byte[] head, out int width, out int height)
        {
            width = height = 0;
            if (head == null || head.Length < PngHeaderLength || !IsPng(head)) return false;
            width = (head[16] << 24) | (head[17] << 16) | (head[18] << 8) | head[19];
            height = (head[20] << 24) | (head[21] << 16) | (head[22] << 8) | head[23];
            return width > 0 && height > 0;
        }

        public static bool TryReadPngSize(string file, out int width, out int height)
        {
            width = height = 0;
            try
            {
                using (var f = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    var head = new byte[PngHeaderLength];
                    return f.Read(head, 0, head.Length) == head.Length && TryReadPngSize(head, out width, out height);
                }
            }
            catch (IOException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
        }
    }

    public static class Assigner
    {
        /// <summary>Formats the engine tries for the same name (`image_extension_candidates`).</summary>
        public static readonly string[] SiblingExtensions = { ".webp", ".jpg", ".jpeg" };

        /// <summary>The same image in another format next to `pngPath` (e.g. the converted .webp).</summary>
        public static List<string> SiblingFormats(string pngPath)
        {
            var stem = Path.Combine(Path.GetDirectoryName(pngPath) ?? "", Path.GetFileNameWithoutExtension(pngPath));
            return SiblingExtensions.Select(ext => stem + ext).Where(File.Exists).ToList();
        }

        /// <summary>
        /// Write `png` to the target (via a temp file). An existing target is moved into
        /// `backupDir` first — never silently lost; the caller must pass `overwrite` = true.
        /// </summary>
        public static Assignment Assign(
            CaptureTarget target, string source, byte[] png, IEnumerable<string> allowedRoots,
            string backupDir, OriginalHandling original, bool overwrite, bool moveOtherFormats = false)
        {
            var refusal = FileSafety.CheckTarget(target.Path, allowedRoots);
            if (refusal != null) throw new InvalidOperationException(refusal);
            if (!FileSafety.IsPng(png)) throw new InvalidOperationException("The capture is not PNG data.");
            string dest = Path.GetFullPath(target.Path);
            var a = new Assignment { TargetId = target.Id, Source = source, Target = dest, When = DateTime.Now };
            if (File.Exists(dest))
            {
                if (!overwrite) throw new InvalidOperationException("The target file exists — confirm overwriting it first.");
                a.ReplacedBackup = UniquePath(Path.Combine(StampDir(backupDir, "replaced"), Path.GetFileName(dest)));
                File.Move(dest, a.ReplacedBackup);
            }
            Directory.CreateDirectory(Path.GetDirectoryName(dest));
            string tmp = dest + ".mtscapture.tmp";
            try
            {
                File.WriteAllBytes(tmp, png);
                File.Move(tmp, dest);
                a.WrittenLength = png.LongLength;
                // The engine loads the pattern's extension first (usually .webp): the old file
                // would hide the new PNG until it is converted. Move it aside (undo restores it).
                if (moveOtherFormats)
                {
                    foreach (var sibling in SiblingFormats(dest))
                    {
                        if (FileSafety.CheckTarget(Path.ChangeExtension(sibling, ".png"), allowedRoots) != null) continue;
                        var backup = UniquePath(Path.Combine(StampDir(backupDir, "replaced"), Path.GetFileName(sibling)));
                        File.Move(sibling, backup);
                        a.SiblingBackups.Add(new KeyValuePair<string, string>(sibling, backup));
                    }
                }
            }
            catch
            {
                if (File.Exists(tmp)) File.Delete(tmp);
                foreach (var s in a.SiblingBackups)
                    if (!File.Exists(s.Key) && File.Exists(s.Value)) File.Move(s.Value, s.Key);
                if (a.WrittenLength > 0 && File.Exists(dest) && new FileInfo(dest).Length == a.WrittenLength) File.Delete(dest);
                if (a.ReplacedBackup != null && !File.Exists(dest)) File.Move(a.ReplacedBackup, dest);
                throw;
            }
            if (source != null && File.Exists(source) && original != OriginalHandling.Keep)
            {
                string dir = original == OriginalHandling.MoveToAssigned
                    ? Path.Combine(Path.GetDirectoryName(source), "assigned")
                    : StampDir(backupDir, "deleted-captures");
                Directory.CreateDirectory(dir);
                a.SourceMovedTo = UniquePath(Path.Combine(dir, Path.GetFileName(source)));
                File.Move(source, a.SourceMovedTo);
            }
            return a;
        }

        /// <summary>Reverse an assignment: remove the written file, restore what it replaced and the screenshot.</summary>
        public static void Undo(Assignment a)
        {
            if (File.Exists(a.Target))
            {
                if (new FileInfo(a.Target).Length != a.WrittenLength)
                    throw new InvalidOperationException("The file changed since it was assigned — undo it by hand.");
                File.Delete(a.Target);
            }
            if (a.ReplacedBackup != null && File.Exists(a.ReplacedBackup)) File.Move(a.ReplacedBackup, a.Target);
            foreach (var s in a.SiblingBackups)
                if (!File.Exists(s.Key) && File.Exists(s.Value)) File.Move(s.Value, s.Key);
            if (a.SourceMovedTo != null && File.Exists(a.SourceMovedTo) && a.Source != null && !File.Exists(a.Source)) File.Move(a.SourceMovedTo, a.Source);
        }

        private static string StampDir(string backupDir, string kind)
        {
            var d = Path.Combine(Path.Combine(backupDir, kind), DateTime.Now.ToString("yyyy-MM-dd"));
            Directory.CreateDirectory(d);
            return d;
        }

        private static string UniquePath(string path)
        {
            if (!File.Exists(path)) return path;
            string dir = Path.GetDirectoryName(path), name = Path.GetFileNameWithoutExtension(path), ext = Path.GetExtension(path);
            for (int i = 1; ; i++)
            {
                var p = Path.Combine(dir, name + " (" + i + ")" + ext);
                if (!File.Exists(p)) return p;
            }
        }
    }
}
