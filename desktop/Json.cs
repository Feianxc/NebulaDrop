using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Web.Script.Serialization;

namespace NebulaDrop
{
    /// <summary>JSON 小工具：基于 .NET Framework 自带的 JavaScriptSerializer，避免额外依赖。</summary>
    internal static class J
    {
        private static JavaScriptSerializer Make() => new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };

        internal static string Stringify(object o) => Make().Serialize(o);

        internal static Dictionary<string, object> Parse(string s)
        {
            if (string.IsNullOrWhiteSpace(s)) return null;
            try { return Make().DeserializeObject(s) as Dictionary<string, object>; }
            catch { return null; }
        }

        internal static object ParseAny(string s)
        {
            if (string.IsNullOrWhiteSpace(s)) return null;
            try { return Make().DeserializeObject(s); }
            catch { return null; }
        }

        internal static object Get(this Dictionary<string, object> d, string k) =>
            d != null && d.TryGetValue(k, out var v) ? v : null;

        internal static string Str(this Dictionary<string, object> d, string k)
        {
            var v = d.Get(k);
            return v == null ? null : Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        internal static long Long(this Dictionary<string, object> d, string k, long def = 0)
        {
            var v = d.Get(k);
            if (v == null) return def;
            try { return Convert.ToInt64(v, CultureInfo.InvariantCulture); } catch { return def; }
        }

        internal static bool Bool(this Dictionary<string, object> d, string k, bool def = false)
        {
            var v = d.Get(k);
            if (v is bool b) return b;
            if (v == null) return def;
            if (v is string s) return s == "true" || s == "1";
            try { return Convert.ToInt64(v, CultureInfo.InvariantCulture) != 0; } catch { return def; }
        }

        internal static Dictionary<string, object> Obj(this Dictionary<string, object> d, string k) =>
            d.Get(k) as Dictionary<string, object>;

        internal static List<object> Arr(this Dictionary<string, object> d, string k)
        {
            var v = d.Get(k);
            if (v is object[] a) return new List<object>(a);
            if (v is ArrayList al) return new List<object>(al.ToArray());
            return v as List<object>;
        }

        internal static List<string> StrList(this Dictionary<string, object> d, string k)
        {
            var a = d.Arr(k);
            var r = new List<string>();
            if (a == null) return null;
            foreach (var x in a) if (x is string s) r.Add(s);
            return r;
        }

        internal static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
}
