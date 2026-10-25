// The setup program. Bolt's files (the bundled Node runtime, the app and
// Bolt.exe) are embedded as payload.zip. Installs for the current user only,
// so it never needs administrator rights.
//   Bolt-1.3.0-Windows.exe                       normal install with a window
//   ... /S [/D=<folder>] [/NoStart] [/NoShortcuts] [/NoRegistry] [/Startup]   silent (used by tests)
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace BoltDM
{
    class Options
    {
        public string Dir = Bolt.DefaultInstallDir;
        public bool Silent, NoStart, NoShortcuts, NoRegistry, Startup = true, Desktop = true;
    }

    static class SetupProgram
    {
        [STAThread]
        static int Main(string[] args)
        {
            var o = new Options();
            foreach (var a in args)
            {
                var l = a.ToLowerInvariant();
                if (l == "/s") o.Silent = true;
                else if (l.StartsWith("/d=")) o.Dir = Path.GetFullPath(a.Substring(3).Trim('"'));
                else if (l == "/nostart") o.NoStart = true;
                else if (l == "/noshortcuts") o.NoShortcuts = true;
                else if (l == "/noregistry") o.NoRegistry = true;
                else if (l == "/nostartup") o.Startup = false;
            }
            if (o.Silent)
            {
                try { Installer.Run(o, s => Console.WriteLine(s)); return 0; }
                catch (Exception e) { Console.Error.WriteLine("Install failed: " + e.Message); return 1; }
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm(o));
            return 0;
        }
    }

    static class Installer
    {
        public static void Run(Options o, Action<string> progress)
        {
            progress("Closing Bolt if it is running (your downloads are saved)...");
            Bolt.StopRunning(o.Dir);

            progress("Copying files...");
            Directory.CreateDirectory(o.Dir);
            // Replace the program files completely, so no file from an older version is left behind.
            // Downloads and settings live in %APPDATA%\BoltDM and are not touched.
            foreach (var sub in new[] { "app", "runtime" })
            {
                var p = Path.Combine(o.Dir, sub);
                if (Directory.Exists(p)) DeleteWithRetry(p);
            }
            using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (var zip = new ZipArchive(payload, ZipArchiveMode.Read))
            {
                foreach (var e in zip.Entries)
                {
                    var target = Path.GetFullPath(Path.Combine(o.Dir, e.FullName));
                    if (!target.StartsWith(Path.GetFullPath(o.Dir), StringComparison.OrdinalIgnoreCase)) continue;   // never outside the folder
                    if (e.FullName.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    for (int i = 0; ; i++)
                    {
                        try { e.ExtractToFile(target, true); break; }
                        catch (IOException) { if (i >= 20) throw; Thread.Sleep(250); }   // antivirus may hold a file briefly
                    }
                }
            }

            progress("Connecting the browser extension...");
            Bolt.RegisterNativeHost(o.Dir, !o.NoRegistry);

            string exe = Path.Combine(o.Dir, "Bolt.exe");
            if (!o.NoShortcuts)
            {
                progress("Creating shortcuts...");
                Bolt.CreateShortcut(Bolt.LinkPath(Environment.SpecialFolder.Programs), exe, "", o.Dir, exe);
                if (o.Desktop) Bolt.CreateShortcut(Bolt.LinkPath(Environment.SpecialFolder.Desktop), exe, "", o.Dir, exe);
                var startup = Bolt.LinkPath(Environment.SpecialFolder.Startup);
                if (o.Startup) Bolt.CreateShortcut(startup, exe, "--background", o.Dir, exe);
                else Bolt.RemoveShortcutIfOurs(startup, o.Dir);
            }
            if (!o.NoRegistry) Bolt.WriteUninstallEntry(o.Dir, Version.Text, Bolt.FolderSizeKb(o.Dir));

            if (!o.NoStart)
            {
                progress("Starting Bolt...");
                Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = o.Dir, UseShellExecute = true });
            }
            progress("Done.");
        }

        static void DeleteWithRetry(string path)
        {
            for (int i = 0; ; i++)
            {
                try { Directory.Delete(path, true); return; }
                catch (Exception) { if (i >= 20) throw; Thread.Sleep(250); }
            }
        }
    }

    class SetupForm : Form
    {
        readonly Options o;
        readonly Label status = new Label();
        readonly ProgressBar bar = new ProgressBar();
        readonly Button go = new Button();
        readonly Button showExt = new Button();
        readonly CheckBox startup = new CheckBox();
        readonly CheckBox desktop = new CheckBox();
        bool done;

        public SetupForm(Options o)
        {
            this.o = o;
            Text = "Install " + Bolt.Name;
            Font = new Font("Segoe UI", 9.5f);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(520, 330);
            AutoScaleMode = AutoScaleMode.Dpi;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            var logo = new PictureBox { Image = Icon != null ? Icon.ToBitmap() : null, SizeMode = PictureBoxSizeMode.Zoom, Bounds = new Rectangle(24, 22, 48, 48) };
            var title = new Label { Text = Bolt.Name, Font = new Font("Segoe UI Semibold", 15f), AutoSize = true, Location = new Point(86, 22) };
            var sub = new Label { Text = "Version " + Version.Text + "  ·  by " + Bolt.Publisher, ForeColor = Color.DimGray, AutoSize = true, Location = new Point(88, 54) };
            var info = new Label
            {
                Text = "Fast, resumable downloads with browser integration.\r\nInstalls for you only (no administrator rights needed) to:\r\n" + o.Dir,
                Bounds = new Rectangle(24, 90, 470, 60),
            };
            desktop.Text = "Put a shortcut on the desktop";
            desktop.Checked = true;
            desktop.Bounds = new Rectangle(24, 158, 470, 24);
            startup.Text = "Start Bolt with Windows (unfinished downloads continue after a restart)";
            startup.Checked = true;
            startup.Bounds = new Rectangle(24, 184, 470, 24);
            bar.Bounds = new Rectangle(24, 222, 470, 10);
            bar.Style = ProgressBarStyle.Marquee;
            bar.Visible = false;
            status.Bounds = new Rectangle(24, 238, 470, 40);
            status.ForeColor = Color.DimGray;
            showExt.Text = "Show extension folder";
            showExt.Bounds = new Rectangle(24, 284, 170, 30);
            showExt.Visible = false;
            showExt.Click += (s, e) => Process.Start("explorer.exe", "\"" + Path.Combine(o.Dir, "app", "extension") + "\"");
            go.Text = "Install";
            go.Bounds = new Rectangle(394, 284, 100, 30);
            go.Click += (s, e) => { if (done) Close(); else Start(); };
            AcceptButton = go;
            Controls.AddRange(new Control[] { logo, title, sub, info, desktop, startup, bar, status, showExt, go });
        }

        void Start()
        {
            o.Startup = startup.Checked;
            o.Desktop = desktop.Checked;
            go.Enabled = startup.Enabled = desktop.Enabled = false;
            bar.Visible = true;
            var t = new Thread(() =>
            {
                try
                {
                    Installer.Run(o, s => BeginInvoke((Action)(() => status.Text = s)));
                    BeginInvoke((Action)Finished);
                }
                catch (Exception e)
                {
                    BeginInvoke((Action)(() =>
                    {
                        bar.Visible = false;
                        status.ForeColor = Color.Firebrick;
                        status.Text = "Install failed: " + e.Message;
                        go.Enabled = true;
                    }));
                }
            });
            t.IsBackground = true;
            t.Start();
        }

        void Finished()
        {
            done = true;
            bar.Visible = false;
            status.ForeColor = SystemColors.ControlText;
            status.Text = "Bolt is installed and running (look for its icon by the clock).\r\n" +
                          "Last step: add the browser extension. Bolt's window shows how.";
            showExt.Visible = true;
            go.Text = "Finish";
            go.Enabled = true;
        }
    }
}
