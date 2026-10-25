# Bolt Download Manager

**Made by Arnav** · © 2026 Arnav · MIT License

A fast, crash-proof download manager for Windows with browser integration. It should also run on macOS and Linux, but that hasn't been tested. It's like IDM, plus video-stream downloading. It has no dependencies: only Node.js 20+ is needed.

## Why it's fast

* **Many connections per file, picked by size (Auto).** Under 10 MB uses 4 connections, under 1 GB 8, under 100 GB 16, and **100 GB or more uses Max (32)**. You can choose Normal (4), Fast (8), Ultra (16) or Max (32) per download in the download window. One request finds out whether the server supports ranges. If it does, Bolt splits the file and downloads the pieces in parallel.
* **Sites that limit connections are handled.** If a host refuses extra connections, or silently drops them (some firewalls do), Bolt keeps going with the ones that work and tries one more now and then, instead of failing.
* **Connections open a few at a time** (at most 4 waiting for an answer at once; after an outage, one first). Opening 16–32 at once can count against you with anti-abuse systems: during testing, a real mirror refused this PC entirely right after the old version's burst (the cause can't be confirmed).
* **Servers that refuse browser-like User-Agents are handled.** Some servers hang up on requests with a browser-like User-Agent coming from a download tool (on Hetzner's mirrors browser, library and empty User-Agents were reset; download-tool ones were accepted). Bolt then asks again as `Bolt-Download-Manager/x.y` (measured on Hetzner's mirrors: the old version never got a single byte there).
* **Servers that answer the first request with a plain 200** (allowed by HTTP for "bytes=0-") are checked with one tiny range request and still get many connections.
* **Dynamic re-splitting.** When a connection finishes its piece, it takes over the second half of the biggest piece still downloading. Every connection stays busy until the end, so there's no slow "last 5%".
* **Keep-alive connection reuse, large disk writes (4 MiB for files over 1 GB, which matters on HDDs), and sparse files on NTFS.** Without sparse files, Windows zero-fills the file before writing far into it. That stalled downloads for up to 24 s on an HDD; the fix took a 4 GB test from 314 s to 36 s.
* On servers that limit speed per connection, the test suite measured **8.3× faster with 8 connections than with 1**.
* **Measured against the previous version and a browser-style download** (details in [REPORT.md](REPORT.md)): about 20 % faster than a single browser connection on a real per-connection-limited mirror (where 1.1 could not download at all), 1.4× faster than 1.1 behind a firewall that drops extra connections, and 97–98 % of a 1 Gbit/s line. On fast CDNs a single connection already fills a typical home line, and so does Bolt.

## Why it doesn't lose downloads

* Only bytes that have really been written to disk are recorded as done. The state is saved every second. Killing the process, a crash, sleep or a reboot all resume from exactly where the file ends.
* **Power cuts:** every 15 s the file is flushed to disk, and each piece remembers how far it was flushed. If the PC restarted while Bolt was running, Bolt continues from the flushed positions, so bytes that only reached Windows' cache are fetched again instead of being trusted. The download list is saved every second (the previous version kept as `downloads.json.bak`), and a copy flushed all the way to the disk every 10 s (`downloads.json.safe`), so a list damaged by a power cut is restored from one of them.
* **Disk full:** the download waits ("Waiting for disk space") with everything kept and continues by itself once there is room.
* **Drive unplugged or network share offline:** the progress is kept and the partial file is never touched; the download waits for the folder to come back.
* **File briefly locked** by an antivirus or backup tool: the write is simply tried again.
* **Before a download is called finished** its file size is checked against the download; if pieces are missing they are downloaded again instead of producing a broken file. If Bolt stops right while finishing, the next start finds the finished file instead of downloading it again.
* **Memory stays bounded:** when the disk is slower than the network, connections pause instead of piling up data in memory (at most 96 MB waiting for the disk, for all downloads together).
* A lost network or a server that goes offline means automatic reconnecting with backoff, forever by default. Stalled connections (no data for 20 s) are dropped and reopened.
* **Sleep:** while anything downloads, Bolt keeps Windows from going to sleep on its own. Closing the lid or choosing Sleep yourself still works. After waking, every connection is reopened at once.
* **Restarts and crashes:** Bolt can start with Windows (see Settings) and continues unfinished downloads. If Bolt itself ever crashes, it restarts within seconds and carries on from the file on disk.
* **Progress is never thrown away silently.** If the server suddenly reports a different file size, or ignores the resume request, Bolt retries. If it keeps happening, Bolt stops and keeps the data, so you can choose *Retry*, *Refresh link* or *Restart from zero*. Only small downloads (under 32 MB) start over by themselves.
* **Expired link?** Click *Refresh link…* and paste a new link, or just start the same download again in your browser. The download window offers to continue the unfinished file, and the progress is kept.
* If the server returns 429 or 503 ("too many connections"), Bolt automatically uses fewer connections.
* **Everything is logged** to `%APPDATA%\BoltDM\logs\bolt.log` (*Settings → Open log*): retries, errors and why a download stopped. Links are logged without their query string, so tokens aren't written down.

## Other features

* **Browser extension (Chrome / Edge / Brave).**
  * Takes over downloads, including cookies and referrer, so links that need a login still work.
  * **Checks first.** Before taking a download away from the browser, Bolt makes one small test request. If Bolt can't fetch the link (a login wall, a POST form, a link that works only once), the browser keeps the download and you get a notification saying why.
  * **Download window** (like IDM): file name, size, free space, folder (with *Browse…*), and speed (Auto / Normal / Fast / Ultra / Max). It also has *Download later* and *Use browser*. It can be turned off in the extension's options.
  * **Game-server panel backups** (Pterodactyl, Pelican and similar). Their backup links work only once, so the browser would use them up before Bolt could. The extension catches these links first and gives them to Bolt.
  * Right-click menu: *Download link with Bolt*, *Download all files linked on this page*, *Download with the browser instead*.
  * Detects **videos, audio and HLS streams** playing on a page.
  * If Bolt isn't running, the download stays in the browser, so nothing is lost.
* **HLS (.m3u8) video streams.**
  * Picks the best quality and downloads the parts in parallel.
  * Decrypts AES-128 streams and merges separate audio tracks.
  * With ffmpeg installed, saves the result as .mp4.
* **Video pages of YouTube, Vimeo and similar sites** (optional, needs [yt-dlp](https://github.com/yt-dlp/yt-dlp): `winget install yt-dlp`).
  * These sites stream split audio/video (DASH) that can't be grabbed from network traffic, so Bolt hands the page to yt-dlp.
  * Page links of known video sites go to yt-dlp automatically. For other sites, tick *Video page* under *Advanced* in *Add URL*, use `bolt add <url> --ytdlp`, or the extension's *Download this page's video with Bolt*.
  * Best quality, merged to .mp4 with ffmpeg. Progress, pause and resume work as usual.
* **Queue.** Runs N downloads at the same time. Global and per-download speed limits. Category filters, search, and "x MB/s" in the window title.
* **Paste a link anywhere** in the window (Ctrl+V), or drag and drop links onto it. Ctrl+N opens *Add URL*.
* A command line for scripts and other apps: `bolt add <url>`.

## Installing (for the people you give Bolt to)

Give them **`Bolt-<version>-Windows.exe`** from the `dist` folder. They need nothing else: Node.js is bundled.

1. **Run the installer.** It installs for that Windows user only (no administrator rights) to `%LOCALAPPDATA%\Programs\Bolt`. It adds Start-menu and desktop shortcuts, a tray icon by the clock, an entry in *Settings → Apps*, and optionally starts Bolt with Windows.
2. **Add the browser extension.** Bolt's window shows a banner with the steps until the extension connects:
   1. Open `edge://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
   2. Click **Load unpacked**.
   3. Choose the folder that **Show extension folder** opens (`…\Programs\Bolt\app\extension`).
3. **To update,** run the newer installer. Bolt closes and saves its downloads first; the download list and settings are kept.
4. **To remove,** use *Settings → Apps → Bolt Download Manager → Uninstall*. Downloaded files are always kept; it asks whether to delete the download list.

**Good to know before you ship:**
* **Windows SmartScreen warning.** The installer isn't code-signed, so Windows shows "Windows protected your PC" the first time. People click **More info → Run anyway**. Removing the warning needs a code-signing certificate (bought from a certificate authority) and signing `Bolt.exe` and the installer with it.
* **Never share `extension.pem`** (in the project folder). It's the extension's private key. The build refuses to include it.
* **Defender:** both release files were scanned with Microsoft Defender, and no threats were found.

### Building a release

```bash
powershell -ExecutionPolicy Bypass -File tools\build-release.ps1
```

This creates `dist\Bolt-<version>-Windows.exe` (the installer) and `dist\Bolt-<version>-portable.zip`. It bundles this PC's `node.exe` together with Node's licence. `tools\test-installer.ps1` runs the whole cycle in a sandbox: install, download, browser launcher, upgrade, uninstall.

## Setup from source (developers)

1. Install [Node.js](https://nodejs.org) 20 or newer, if you don't have it.
2. Run once (no admin needed):
   ```bash
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```
   This creates *Bolt Download Manager* shortcuts on the Desktop and in the Start menu. It also lets the browser extension start Bolt on its own. Add `-Startup` to start Bolt in the background when you sign in, or turn on *Start Bolt with Windows* in Settings.
3. Add the extension:
   1. Open `edge://extensions` or `chrome://extensions`.
   2. Turn on **Developer mode**.
   3. Click **Load unpacked** and choose the `extension` folder.

Start Bolt with the shortcut or `Bolt.vbs`, which runs it without a console window. `Bolt.bat` runs it with a visible log.

## Command line

```bash
node bin/bolt.js add "https://example.com/big.iso" --connections 16
```

Other commands: `start`, `open`, `list` and `quit`.

## Files

| Path | What it is |
|---|---|
| `src/download.js` | The segmented HTTP engine: splitting, retries, resume |
| `src/hls.js` | The HLS stream downloader |
| `src/ytdlp.js` | Video pages through yt-dlp (YouTube etc.) |
| `src/manager.js` | The queue and saved state (`%APPDATA%\BoltDM\downloads.json`) |
| `src/server.js` | The local API on `127.0.0.1:9614`. It accepts requests only from the Bolt window and browser extensions, so websites can't use it |
| `ui/` | The app window |
| `extension/` | The browser extension |
| `native-host/` | The small launcher that lets the extension start Bolt |
| `test/` | End-to-end tests |

Settings are stored in `%APPDATA%\BoltDM\settings.json`. Downloads in progress are kept next to the target file as `name.bolt`.

## Tests

```bash
node test/run-tests.js
```

Each case is checked with SHA-256:

* multi-connection download
* the speed comparison (1 vs 8 connections)
* random connection drops
* servers without range support or without Content-Length
* redirects
* short 206 responses
* empty files
* 404
* pause/resume
* the server going offline
* a hard kill of the process
* an encrypted HLS stream
* a video page through yt-dlp, paused and resumed (skipped when yt-dlp isn't installed)
* a host that allows only 3 connections
* a link that expires mid-download, then continued with a new link (only the missing part is fetched)
* a host that ignores resume requests, and a file whose size changes (data kept, never silently restarted)
* a restart while data is still buffered (this used to freeze downloads)
* one-time links: refused when already used, downloaded when caught first
* the PC sleeping (the app frozen for 9 s), then waking
* Auto speed on a virtual 150 GB file: 32 connections, bytes spot-checked
* Bolt being killed mid-download: it restarts itself and finishes the file
* a server that answers "bytes=0-" with a plain 200 but supports ranges (still multi-connection)
* a firewall that silently drops connections beyond 3 (no connection storm; every byte verified)
* the server down for 12 s (back with one connection first, then all of them)
* a server that hangs up on browser User-Agents
* three downloads at once, one paused and resumed
* a power cut (simulated): bytes that never reached the disk are fetched again
* the disk full mid-download, the file briefly locked, the drive unplugged (via `subst`)
* Bolt stopping during the final rename, and a damaged `downloads.json`

`--big` adds a 4 GB test. `node test/stress-150gb.js <folder> [bytes]` is the big one: a 150 GB download with Bolt hard-killed eight times, a server outage and a simulated reboot, then every byte compared (see [REPORT.md](REPORT.md)). `node test/extension-logic.js` runs the extension's logic against a real Bolt.

## Limits

* **Some files can only be saved by the browser.** Examples are Telegram Web files (made by Telegram's own app inside the page), MEGA and other sites that build the file in the page (`blob:` links), and downloads that come from a submitted form. No outside program can fetch these, IDM included. The browser downloads them as usual. They still appear in Bolt's list with live progress, Open and Show in folder, plus a note explaining why the browser handles them.

* Sites that use DRM can't be downloaded. YouTube-style split DASH streams need yt-dlp (see above).
* yt-dlp downloads don't use the browser's cookies, so videos that need a login may fail. A per-download speed limit restarts yt-dlp, and the global limit applies to each yt-dlp download separately.
* Downloads the browser makes with a POST form can't be replayed, and neither can one-time links from sites the extension doesn't recognise. Bolt's check catches these, and the browser downloads them as usual.
* Keeping the PC awake stops *automatic* sleep only. Closing the lid or pressing Sleep still sleeps; downloads continue after waking.
