// Shared by Bolt.exe (tray app + uninstaller) and the setup program.
// C# 5 / .NET Framework 4.5+, which every Windows 10/11 PC has.
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

namespace BoltDM
{
    static class Bolt
    {
        public const string Name = "Bolt Download Manager";
        public const string Publisher = "Arnav";
        public const string ExtensionId = "oljpffpdpmcipbelpjbakpgdlmepgebl";
        public const string HostName = "com.bolt.launcher";
        public const string UninstallKeyName = "BoltDownloadManager";
        public static readonly string[] Browsers = { @"Google\Chrome", @"Microsoft\Edge", @"BraveSoftware\Brave-Browser", "Chromium" };

        public static string DefaultInstallDir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Bolt"); }
        }

        // Tests point these somewhere harmless; normal runs use the real places.
        static string Env(string name) { var v = Environment.GetEnvironmentVariable(name); return string.IsNullOrEmpty(v) ? null : v; }
        public static string RegRoot { get { return Env("BOLT_TEST_REGROOT") ?? "Software"; } }
        public static string DataDir
        {
            get { return Env("BOLT_DATA_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "BoltDM"); }
        }
        public static string ShortcutDir(Environment.SpecialFolder f)
        {
            var test = Env("BOLT_TEST_SHORTCUT_DIR");
            return test != null ? Path.Combine(test, f.ToString()) : Environment.GetFolderPath(f);
        }
        public static string LinkPath(Environment.SpecialFolder f) { return Path.Combine(ShortcutDir(f), Name + ".lnk"); }

        public static string NodeExe(string dir) { return Path.Combine(dir, "runtime", "node.exe"); }
        public static string BoltJs(string dir) { return Path.Combine(dir, "app", "bin", "bolt.js"); }

        public static int Port()
        {
            try
            {
                var s = File.ReadAllText(Path.Combine(DataDir, "settings.json"));
                var m = Regex.Match(s, "\"port\"\\s*:\\s*(\\d+)");
                if (m.Success) return int.Parse(m.Groups[1].Value);
            }
            catch { }
            return 9614;
        }

        static HttpWebRequest Request(int port, string path, int timeoutMs)
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + path);
            req.Proxy = null;   // never send localhost traffic through a system proxy
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            return req;
        }

        public static string Get(int port, string path, int timeoutMs = 3000)
        {
            try
            {
                using (var r = (HttpWebResponse)Request(port, path, timeoutMs).GetResponse())
                using (var sr = new StreamReader(r.GetResponseStream(), Encoding.UTF8)) return sr.ReadToEnd();
            }
            catch { return null; }
        }

        public static bool Ping(int port, int timeoutMs = 1500)
        {
            var s = Get(port, "/api/ping", timeoutMs);
            return s != null && s.Contains("\"bolt\"");
        }

        public static bool Post(int port, string path, string json = "{}")
        {
            try
            {
                var req = Request(port, path, 5000);
                req.Method = "POST";
                req.ContentType = "application/json";
                var b = Encoding.UTF8.GetBytes(json);
                req.ContentLength = b.Length;
                using (var s = req.GetRequestStream()) s.Write(b, 0, b.Length);
                using (req.GetResponse()) { }
                return true;
            }
            catch { return false; }
        }

        /// Start the download engine (the Node supervisor) hidden. Returns its process.
        public static Process StartEngine(string dir)
        {
            var psi = new ProcessStartInfo(NodeExe(dir), "\"" + BoltJs(dir) + "\" start --no-open")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = dir,
            };
            return Process.Start(psi);
        }

        /// Open Bolt's window (the engine starts it if needed).
        public static void OpenWindow(string dir)
        {
            var psi = new ProcessStartInfo(NodeExe(dir), "\"" + BoltJs(dir) + "\" open")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = dir,
            };
            try { Process.Start(psi); } catch { }
        }

        static bool IsUnder(string file, string dir)
        {
            if (string.IsNullOrEmpty(file)) return false;
            var d = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
            return Path.GetFullPath(file).StartsWith(d, StringComparison.OrdinalIgnoreCase);
        }

        /// Close a running Bolt cleanly (it saves progress), then make sure nothing from `dir` is left running.
        public static void StopRunning(string dir)
        {
            int port = Port();
            if (Ping(port))
            {
                Post(port, "/api/actions/quit");
                for (int i = 0; i < 80 && Ping(port, 500); i++) Thread.Sleep(250);
            }
            int self = Process.GetCurrentProcess().Id;
            foreach (var name in new[] { "Bolt", "node" })
            {
                foreach (var p in Process.GetProcessesByName(name))
                {
                    try
                    {
                        if (p.Id != self && IsUnder(p.MainModule.FileName, dir)) { p.Kill(); p.WaitForExit(5000); }
                    }
                    catch { /* not ours, or already gone */ }
                }
            }
        }

        // ------------------------------------------------------------ shortcuts

        public static void CreateShortcut(string lnk, string target, string args, string workDir, string icon)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(lnk));
            var t = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(t);
            object sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
            var st = sc.GetType();
            st.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { target });
            st.InvokeMember("Arguments", BindingFlags.SetProperty, null, sc, new object[] { args ?? "" });
            st.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { workDir });
            st.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { icon + ",0" });
            st.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { Name });
            st.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
        }

        public static string ShortcutTarget(string lnk)
        {
            try
            {
                var t = Type.GetTypeFromProgID("WScript.Shell");
                object shell = Activator.CreateInstance(t);
                object sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
                return (string)sc.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, sc, null);
            }
            catch { return null; }
        }

        /// Remove a shortcut only if it points into this install (never someone else's).
        public static void RemoveShortcutIfOurs(string lnk, string dir)
        {
            if (!File.Exists(lnk)) return;
            var target = ShortcutTarget(lnk);
            if (target == null || IsUnder(target, dir)) try { File.Delete(lnk); } catch { }
        }

        // ------------------------------------------------------------ browser launcher (native messaging)

        static string JsonString(string s) { return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

        public static void RegisterNativeHost(string dir, bool registry)
        {
            string hostDir = Path.Combine(dir, "app", "native-host");
            string bat = Path.Combine(hostDir, "bolt-launcher.bat");
            File.WriteAllText(bat, "@echo off\r\n\"" + NodeExe(dir) + "\" \"%~dp0bolt-launcher.js\" %*\r\n", new UTF8Encoding(false));
            string json = Path.Combine(hostDir, HostName + ".json");
            File.WriteAllText(json, "{\r\n  \"name\": " + JsonString(HostName) +
                ",\r\n  \"description\": \"Starts Bolt Download Manager\",\r\n  \"path\": " + JsonString(bat) +
                ",\r\n  \"type\": \"stdio\",\r\n  \"allowed_origins\": [ \"chrome-extension://" + ExtensionId + "/\" ]\r\n}\r\n", new UTF8Encoding(false));
            if (!registry) return;
            foreach (var b in Browsers)
                using (var k = Registry.CurrentUser.CreateSubKey(RegRoot + "\\" + b + "\\NativeMessagingHosts\\" + HostName)) k.SetValue("", json);
        }

        /// Remove the launcher registration, but only where it points into this install.
        public static void UnregisterNativeHost(string dir)
        {
            foreach (var b in Browsers)
            {
                string key = RegRoot + "\\" + b + "\\NativeMessagingHosts\\" + HostName;
                string val = null;
                using (var k = Registry.CurrentUser.OpenSubKey(key)) if (k != null) val = k.GetValue("") as string;
                if (val != null && IsUnder(val, dir)) try { Registry.CurrentUser.DeleteSubKeyTree(key, false); } catch { }
            }
        }

        // ------------------------------------------------------------ Apps & features entry

        static string UninstallKey { get { return RegRoot + @"\Microsoft\Windows\CurrentVersion\Uninstall\" + UninstallKeyName; } }

        public static void WriteUninstallEntry(string dir, string version, long sizeKb)
        {
            using (var k = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                string exe = Path.Combine(dir, "Bolt.exe");
                k.SetValue("DisplayName", Name);
                k.SetValue("DisplayVersion", version);
                k.SetValue("Publisher", Publisher);
                k.SetValue("DisplayIcon", exe + ",0");
                k.SetValue("InstallLocation", dir);
                k.SetValue("UninstallString", "\"" + exe + "\" --uninstall");
                k.SetValue("QuietUninstallString", "\"" + exe + "\" --uninstall --quiet");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                k.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, sizeKb), RegistryValueKind.DWord);
                k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            }
        }

        public static void RemoveUninstallEntry()
        {
            try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch { }
        }

        public static long FolderSizeKb(string dir)
        {
            long n = 0;
            try { foreach (var f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)) n += new FileInfo(f).Length; } catch { }
            return n / 1024;
        }
    }
}
