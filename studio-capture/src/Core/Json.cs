using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace MTSCapture.Core
{
    /// <summary>
    /// Minimal JSON reader (objects → Dictionary, arrays → List, numbers → double).
    /// .NET 4.6 in Unity has no JSON library and JsonUtility cannot read dictionaries.
    /// </summary>
    public static class Json
    {
        public static object Parse(string text)
        {
            var p = new Parser(text);
            p.Ws();
            var v = p.Value();
            p.Ws();
            if (!p.End) throw new FormatException("Trailing characters at " + p.Pos);
            return v;
        }

        private sealed class Parser
        {
            private readonly string s;
            public int Pos;
            public Parser(string text) { s = text ?? ""; }
            public bool End => Pos >= s.Length;

            public void Ws()
            {
                while (Pos < s.Length && char.IsWhiteSpace(s[Pos])) Pos++;
            }

            public object Value()
            {
                if (End) throw new FormatException("Unexpected end");
                char c = s[Pos];
                if (c == '{') return Obj();
                if (c == '[') return Arr();
                if (c == '"') return Str();
                if (Lit("true")) return true;
                if (Lit("false")) return false;
                if (Lit("null")) return null;
                return Num();
            }

            private bool Lit(string word)
            {
                if (string.CompareOrdinal(s, Pos, word, 0, word.Length) != 0) return false;
                Pos += word.Length;
                return true;
            }

            private Dictionary<string, object> Obj()
            {
                var d = new Dictionary<string, object>();
                Pos++;
                Ws();
                if (!End && s[Pos] == '}') { Pos++; return d; }
                while (true)
                {
                    Ws();
                    if (End || s[Pos] != '"') throw new FormatException("Key expected at " + Pos);
                    string k = Str();
                    Ws();
                    if (End || s[Pos] != ':') throw new FormatException(": expected at " + Pos);
                    Pos++;
                    Ws();
                    d[k] = Value();
                    Ws();
                    if (End) throw new FormatException("Unexpected end in object");
                    if (s[Pos] == ',') { Pos++; continue; }
                    if (s[Pos] == '}') { Pos++; return d; }
                    throw new FormatException(", or } expected at " + Pos);
                }
            }

            private List<object> Arr()
            {
                var l = new List<object>();
                Pos++;
                Ws();
                if (!End && s[Pos] == ']') { Pos++; return l; }
                while (true)
                {
                    Ws();
                    l.Add(Value());
                    Ws();
                    if (End) throw new FormatException("Unexpected end in array");
                    if (s[Pos] == ',') { Pos++; continue; }
                    if (s[Pos] == ']') { Pos++; return l; }
                    throw new FormatException(", or ] expected at " + Pos);
                }
            }

            private string Str()
            {
                var sb = new StringBuilder();
                Pos++;
                while (true)
                {
                    if (End) throw new FormatException("Unterminated string");
                    char c = s[Pos++];
                    if (c == '"') return sb.ToString();
                    if (c != '\\') { sb.Append(c); continue; }
                    if (End) throw new FormatException("Bad escape");
                    char e = s[Pos++];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (Pos + 4 > s.Length) throw new FormatException("Bad \\u escape");
                            sb.Append((char)int.Parse(s.Substring(Pos, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            Pos += 4;
                            break;
                        default: throw new FormatException("Bad escape \\" + e);
                    }
                }
            }

            private double Num()
            {
                int start = Pos;
                while (Pos < s.Length && "+-0123456789.eE".IndexOf(s[Pos]) >= 0) Pos++;
                if (start == Pos) throw new FormatException("Value expected at " + Pos);
                return double.Parse(s.Substring(start, Pos - start), NumberStyles.Float, CultureInfo.InvariantCulture);
            }
        }
    }
}
