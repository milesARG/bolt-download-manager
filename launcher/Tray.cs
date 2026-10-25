// Bolt.exe: the tray icon that runs Bolt in the background, and its uninstaller.
//   Bolt.exe                 start Bolt (if needed) and open its window
//   Bolt.exe --background    start Bolt without a window (used at Windows start-up)
//   Bolt.exe --uninstall [--quiet]
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace BoltDM
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            string dir = Path.GetDirectoryName(Application.ExecutablePath);
            var a = new HashSet<string>(args.Select(x => x.ToLowerInvariant()));
            if (a.Contains("--uninstall")) return Uninstaller.Run(dir, a.Contains("--quiet"));

            if (!File.Exists(Bolt.NodeExe(dir)) || !File.Exists(Bolt.BoltJs(dir)))
            {
                MessageBox.Show("Bolt's files are missing from " + dir + ". Please install Bolt again.", Bolt.Name, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            bool background = a.Contains("--background");
            bool first;
            using (new Mutex(true, @"Local\BoltDownloadManager.Tray", out first))
            {
                if (!first)
                {
                    // already running: just show the window
                    if (!background) Bolt.OpenWindow(dir);
                    return 0;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayApp(dir, background));
            }
            return 0;
        }
    }

    class TrayApp : ApplicationContext
    {
        readonly string dir;
        readonly NotifyIcon icon;
        readonly Control ui = new Control();
        readonly System.Threading.Timer watch;
        Process engine;
        volatile bool quitting;
        int downFor;
        Dictionary<string, string> lastStatus;

        public TrayApp(string dir, bool background)
        {
            this.dir = dir;
            ui.CreateControl();   // lets background threads hand work to the UI thread

            var menu = new ContextMenuStrip();
            var open = new ToolStripMenuItem("Open Bolt", null, (s, e) => Bolt.OpenWindow(dir));
            open.Font = new Font(open.Font, FontStyle.Bold);
            menu.Items.Add(open);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Pause all downloads", null, (s, e) => Bolt.Post(Bolt.Port(), "/api/actions/pause-all"));
            menu.Items.Add("Resume all downloads", null, (s, e) => Bolt.Post(Bolt.Port(), "/api/actions/resume-all"));
            menu.Items.Add("Open download folder", null, (s, e) => Bolt.Post(Bolt.Port(), "/api/actions/open-downloads"));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit Bolt", null, (s, e) => Quit());

            icon = new NotifyIcon
            {
                Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath),
                Text = Bolt.Name,
                ContextMenuStrip = menu,
                Visible = true,
            };
            icon.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) Bolt.OpenWindow(dir); };

            ThreadPool.QueueUserWorkItem(_ =>
            {
                EnsureEngine();
                if (!background)
                {
                    for (int i = 0; i < 60 && !Bolt.Ping(Bolt.Port(), 500); i++) Thread.Sleep(250);
                    Bolt.OpenWindow(dir);
                }
            });
            watch = new System.Threading.Timer(_ => Tick(), null, 5000, 3000);
        }

        void EnsureEngine()
        {
            if (quitting || Bolt.Ping(Bolt.Port())) return;
            try { engine = Bolt.StartEngine(dir); } catch (Exception e) { OnUi(() => icon.ShowBalloonTip(5000, Bolt.Name, "Bolt could not start: " + e.Message, ToolTipIcon.Error)); }
        }

        void Tick()
        {
            if (quitting) return;
            int port = Bolt.Port();
            var json = Bolt.Get(port, "/api/downloads", 2500);
            if (json == null)
            {
                if (++downFor < 2) return;   // one missed answer can be a busy moment
                downFor = 0;
                // Quit from somewhere else (Bolt's own Quit, `bolt quit`): the engine exited cleanly.
                if (engine != null && engine.HasExited && engine.ExitCode == 0) { OnUi(ExitAll); return; }
                // Otherwise it is down for some other reason (crashed, killed): start it again.
                if (engine == null || engine.HasExited) EnsureEngine();
                return;
            }
            downFor = 0;
            try { Summarize(json); } catch { /* the tooltip is not worth crashing for */ }
        }

        /// Tray tooltip ("2 downloading · 5.3 MB/s") and a balloon when a download finishes.
        void Summarize(string json)
        {
            var list = new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Deserialize<ArrayList>(json);
            var now = new Dictionary<string, string>();
            int active = 0; double speed = 0;
            var finished = new List<string>();
            foreach (Dictionary<string, object> it in list)
            {
                string id = Convert.ToString(it["id"]);
                string st = it.ContainsKey("status") ? Convert.ToString(it["status"]) : "";
                now[id] = st;
                if (st == "downloading" || st == "connecting" || st == "retrying" || st == "finishing") active++;
                if (it.ContainsKey("speed") && it["speed"] != null) speed += Convert.ToDouble(it["speed"]);
                string was;
                if (lastStatus != null && lastStatus.TryGetValue(id, out was) && was != "completed" && st == "completed")
                    finished.Add(it.ContainsKey("filename") ? Convert.ToString(it["filename"]) : "download");
            }
            lastStatus = now;
            string tip = active == 0 ? Bolt.Name + " - nothing downloading" : string.Format("Bolt - {0} downloading - {1}", active, Rate(speed));
            OnUi(() =>
            {
                icon.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
                if (finished.Count == 1) icon.ShowBalloonTip(4000, "Download complete", finished[0], ToolTipIcon.Info);
                else if (finished.Count > 1) icon.ShowBalloonTip(4000, "Downloads complete", finished.Count + " files finished", ToolTipIcon.Info);
            });
        }

        static string Rate(double b)
        {
            string[] u = { "B/s", "KB/s", "MB/s", "GB/s" };
            int i = 0;
            while (b >= 1024 && i < u.Length - 1) { b /= 1024; i++; }
            return (i == 0 ? b.ToString("0") : b.ToString(b < 10 ? "0.0" : "0")) + " " + u[i];
        }

        void OnUi(Action a)
        {
            try { if (ui.IsHandleCreated) ui.BeginInvoke(a); } catch { }
        }

        void Quit()
        {
            quitting = true;
            icon.Text = "Bolt - closing (saving progress)...";
            ThreadPool.QueueUserWorkItem(_ =>
            {
                int port = Bolt.Port();
                Bolt.Post(port, "/api/actions/quit");
                for (int i = 0; i < 80 && Bolt.Ping(port, 500); i++) Thread.Sleep(250);
                OnUi(ExitAll);
            });
        }

        void ExitAll()
        {
            quitting = true;
            watch.Dispose();
            icon.Visible = false;
            icon.Dispose();
            ExitThread();
        }
    }

    static class Uninstaller
    {
        public static int Run(string dir, bool quiet)
        {
            if (!quiet && MessageBox.Show("Remove " + Bolt.Name + " from this PC?", Bolt.Name, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
                return 1;
            Bolt.StopRunning(dir);
            Bolt.UnregisterNativeHost(dir);
            Bolt.RemoveUninstallEntry();
            foreach (var f in new[] { Environment.SpecialFolder.Desktop, Environment.SpecialFolder.Programs, Environment.SpecialFolder.Startup })
                Bolt.RemoveShortcutIfOurs(Bolt.LinkPath(f), dir);

            if (!quiet && MessageBox.Show("Also delete your download list and settings?\n\n(Files you downloaded are kept either way.)",
                    Bolt.Name, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes)
            {
                try { Directory.Delete(Bolt.DataDir, true); } catch { }
            }
            // This program is inside the folder it removes: a separate cmd waits for it to exit.
            var psi = new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 > nul & rd /s /q \"" + dir + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetTempPath(),
            };
            Process.Start(psi);
            if (!quiet) MessageBox.Show(Bolt.Name + " was removed.", Bolt.Name, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }
    }
}
