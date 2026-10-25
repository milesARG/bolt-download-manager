# Bolt 1.2 — speed and reliability report

**Made by Arnav** · © 2026 Arnav · measured on 25 Oct 2026

Everything below was measured on this PC (Windows 11, NVMe SSD on C:, WD Purple 2 TB hard disk on D:, a ~75–80 Mbit/s internet line) by running the old code (a copy of Bolt 1.1.0 taken before any change) and the new code back to back, alternating, each run in a fresh process. "Simulated" means a local test server that imitates the condition; "real" means a public server on the internet. Nothing here is estimated or extrapolated unless it says so.

**Which build.** The work went through several frozen builds. The connection logic (speed, server handling, ETA) was finished first and did not change afterwards; only disk writes and saves changed later.
* **Earlier builds:** the connection, CDN, firewall, 1 Gbit/s and real-server comparisons (except the Hetzner 100 MB pairs) and the 150 GB run.
* **Final build:** the ±20 % ETA runs, the Hetzner 100 MB pairs, the hard-disk pairs, the UI latency, the 20 GB and 200 GB runs, and the 38 tests.

## What was wrong (found by measuring, not guessed)

| Problem | Evidence |
|---|---|
| **Bolt could not download at all from servers that filter User-Agents.** It always sends a Chrome User-Agent, and some servers reset every such connection. | Hetzner's mirror: old Bolt got 0 bytes in 400 s and again in 60 s; curl got 2.4 MB/s from the same PC. A header probe showed the server resets Chrome, Firefox, "Mozilla/5.0", python-requests and an empty User-Agent, and accepts curl, wget, aria2 and `Bolt-Download-Manager/1.2.0`. Why it filters this way isn't known. |
| **16–32 connections opened at once and retried as a burst.** | OVH's mirror: old Bolt opened 16 connections, got 4 and stalled at 64 MB; from then on every connection from this PC, even curl's, timed out (an IP block). A full 1 GiB curl download had run just before, so the burst can't be confirmed as the cause; staggering is justified by the firewall tests on its own. |
| **Firewalls that silently drop extra connections made downloads crawl.** | Simulated: old 31.4 s for 256 MB, new 22.5 s. |
| **A drive unplugged or a network share offline wiped the progress.** On restart the segment map was cleared, and the partial file was deleted once the drive came back. | Code review, then a test using a `subst` drive letter. |
| **Disk full mid-download was a fatal error.** | Code review, then a test with injected `ENOSPC`. |
| **A file briefly locked by an antivirus was a fatal error.** | Code review, then a test with injected `EBUSY`. |
| **Nothing was ever flushed to disk.** After a power cut the state file could claim bytes that never reached the disk, which means silent corruption. | Code review, then a simulated power cut (below). |
| **A crash during the final rename meant downloading the whole file again.** | Code review, then a test. |
| **Memory grew to 470–500 MB** when the disk is slower than the network. | Measured, local source → hard disk. |
| **The ETA jumped around on unsteady lines.** | Simulated swings: 14–44 % average error. |
| A server that answers `Range: bytes=0-` with a plain 200 (allowed by HTTP) got one connection only. | Simulated. |

## Speed — old vs new

| Scenario | Old | New | Browser-style (curl, 1 connection) |
|---|---|---|---|
| **Real**: Hetzner Singapore 100 MB (User-Agent filter, 2-connection limit) | fails (0 bytes) | **36.2 s, 41.6 s** | 51.6 s, 45.3 s → new is **~20 % faster than a browser** |
| **Real**: Hetzner Singapore 1 GB | fails (0 bytes in 400 s) | 384.7 s (2.79 MB/s) | 2.43 MB/s in a 60 s sample |
| **Real**: nodejs.org 97 MB (Cloudflare) | 10.9 / 11.3 / 11.3 s | 10.8 / 11.0 / 10.4 s | 11.8 / 10.2 / 9.7 s |
| **Real**: GitHub release 69 MB | 8.5 / 7.9 / 7.9 s | 8.0 / 8.8 / 8.1 s | 8.6 / 8.3 / 8.7 s |
| Simulated firewall dropping connections beyond 4, 256 MB | 31.4 s | **22.5 s (−28 %, 1.40× faster)** | — |
| Simulated User-Agent filter, 64 MB | fails | 0.24 s | — |
| Simulated 1 Gbit/s line, 2 GiB, 30 ms latency | 18.4 / 18.1 s (93–95 % of the line) | 17.7 / 17.5 s (**97–98 %**, −4 %) | — |
| Simulated 100 Mbit/s line, CDN throttling each connection to 2 MB/s, 1 GiB | 86.4 / 86.4 s (99.4 %) | 86.1 / 86.1 s (99.8 %) | — |
| Local source → hard disk (D:), 2 GiB, the disk is the limit (3 alternating pairs, final build) | 17.8 / 17.8 / 18.0 s; peak memory 410–515 MB; CPU 26–28 % | **17.5 / 17.6 / 17.7 s** (−1 %); peak memory **315–338 MB** (−30 %); CPU 21–24 % | — |

**Honest reading.**
* On fast CDNs this line (~9 MB/s) is the limit. Old Bolt, new Bolt and a single browser connection all fill it; no download manager can be 20–30 % faster there.
* The real gains are on the servers that cause trouble:
  * User-Agent filtering: old Bolt failed completely.
  * Per-connection and connection-count limits: ~20 % faster than a browser on Hetzner.
  * Firewalls that drop extra connections: 1.4× faster.
  * Fast lines: 97–98 % of a 1 Gbit/s line instead of 93–95 %.
* OVH could not be re-tested: it has blocked this PC's address since the old version's run.
* On a hard disk fed 4× faster than it can write, the new build is as fast as the old one (−1 %), with about a third less memory and less CPU. The flush that protects against power cuts costs time there, so its interval was tuned on measurements. With a 5 s interval this case was 5 % slower than the old build (5 pairs); with 15 s it is not slower.

## Reliability — test results

The full suite is `node test/run-tests.js`, **38 of 38 passing**. Each file is checked by SHA-256 or byte for byte. The extension's own check (`test/extension-logic.js`) passes 17 of 17. The 14 new cases are:
* a server that hangs up on browser User-Agents;
* three downloads at once, one paused and resumed (every byte of all three verified);
* a 200 answer to "bytes=0-";
* a firewall black hole (4 dropped attempts for 16 wanted);
* the server down for 12 s (2–5 reconnect attempts during the outage instead of a burst on every retry);
* a simulated power cut, where a megabyte that "never reached the disk" was fetched again and the SHA-256 matches;
* disk full: it waited, then finished intact;
* a locked file: six blocked writes were retried;
* a drive unplugged: 13.4 MB kept, then resumed;
* a crash during the final rename: the finished file was found;
* a damaged `downloads.json`: restored from the `.bak`;
* the main file and its `.bak` both damaged: restored from the flushed `.safe` copy;
* Bolt killed before the server's first answer: it starts cleanly next time. This case was a bug in an early version of this work, caught by the stress test.

While testing, a bug in the **test server** also turned up and was fixed: for files bigger than 64 KB it sent up to 15 wrong bytes now and then. It had been there since 1.1. Bolt had written exactly what it received.

### 150 GB stress test

A real download of a **150,000,000,000-byte** file from a local server to the hard disk (D:), with the state file on the same busy disk (the worst case).
* **Interruptions:**
  * Bolt was hard-killed (`taskkill /F`) at **10.1, 25.2, 50.4, 67.2 (100.8 GB), 75.0, 90.1 and 99.2 %**, and once more while it was finishing.
  * The server went down for 15 s at 40.5 %.
  * The restart after the 90 % kill pretended the PC had rebooted, so Bolt had to continue from the last flushed positions.
* **Result:** the download took **19.0 min** including all of that (131 MB/s on average, the disk's speed). Then **all 150,000,000,000 bytes were read back and compared with what the server sent: 100 % identical** (15.6 min). No restart from zero, and no crash other than the kills.
* **Progress after each kill:** 14.47 of 15.22 GB, 37.41 of 37.73, 74.48 of 75.54, **99.86 of 100.82**, 112.29 of 112.55, 134.70 of 135.14 (the reboot), 147.77 of 148.75, and 149.65 of 149.90 GB were still recorded. The difference, 0.25–1.06 GB, was fetched again. It was data Bolt had received but not yet recorded when it was killed.
  * That build saved the state file with a full flush every second. On a disk busy with a 300 MB/s download, that flush fell behind.
  * The final build saves without waiting and keeps a flushed copy every 10 s.
* **Same test with the final build, 20 GB (same disk, same kill pattern):**
  * all bytes verified;
  * **104–400 MB** to fetch again per kill (about 1–3 s of download);
  * 1.29 GB after the simulated reboot (up to one flush interval of data, here at 417 MB/s).
* Memory during these runs was 230–360 MB (a local source flooding a hard disk; see the notes on memory); CPU 25–46 %.

**200 GB with the final build**, same disk and same pattern:
* Kills at 10.2, 25.1, 50.1 (100.1 GB), 66.7, 75.3, 90.0 and 99.1 %, and once while finishing; the server down for 15 s at 40.4 %; a simulated reboot after the 90 % kill.
* The download took **28.5 min** in all. Then **all 200,000,000,000 bytes were read back and were identical** (25.0 min).
* Progress still recorded after each kill: 19.75 of 20.35, 49.28 of 50.21, **99.86 of 100.10**, 133.16 of 133.47, 150.38 of 150.56, 178.17 of 180.09 (the reboot), 197.44 of 198.29, and 200.00 of 200.00 GB.
* Re-fetched per kill: **174–929 MB**, about 1–3 s at 150–330 MB/s. After the simulated reboot it was 1.9 GB: Bolt went back to the last flush, which was up to 15 s old (here at 139 MB/s). The kill while finishing cost 4 MB.

The 150 GB run used the build before three small final changes: the guard for a kill before the first answer, the save right after the first answer, and the non-blocking two-tier save. The 20 GB run and the 37 tests used the final build.

## Targets

| Metric | Target | Result | How |
|---|---|---|---|
| Speed vs. old version | +20–30 % | **28 % less time, 1.40× the speed** (firewall that drops connections); **old fails, new works** (User-Agent filter, real Hetzner); +4 % on a 1 Gbit/s line; **±0 %** on line-limited CDNs (nothing left to gain) | measured, A/B |
| Stretch +40–50 % | | 1.40× in the firewall case; not reached elsewhere | measured |
| vs. browser | match or beat | **~20 % faster** (Hetzner 100 MB); equal on Cloudflare/GitHub (line-limited) | measured, real |
| Bandwidth use | 90–95 % | **97–98 %** of a simulated 1 Gbit/s line; 99.8 % of 100 Mbit/s | simulated |
| ETA, steady line | ±10 % | **1–2 %** average error (old 0.2–0.7 %) | simulated |
| ETA, moderately unsteady (±20 % swings) | ±15 % | **7.4–8.4 %** (old 13.6–14.2 %) | simulated |
| ETA, strongly unsteady (±50 % swings) | — | 16–21 % (old 38–45 %); a replay of the recorded runs shows no formula does better on an 85 s download | simulated |
| UI update latency | < 100 ms | change → window **0.7 ms** median (3.6 ms max); click → window **3.1 ms** median, 11 ms max; live speed every 0.5 s. On a hard disk saturated by a local source, Pause takes **0.08–0.8 s**: Bolt first writes out up to 96 MB still in memory so the positions stay exact (an earlier build took 6–8 s there, fixed). Resume: 1 ms | measured |
| CPU | < 5 % | **3.2–5.3 %** at 12.5 MB/s, **5–8 %** at 9 MB/s over HTTPS (real); 21–31 % at 120 MB/s (old: the same) | measured |
| Engine memory | < 200 MB | **77–162 MB** for real downloads and up to 1 Gbit/s; **315–338 MB** when a local source floods a hard disk (old: 410–515 MB) | measured |
| Completed-file integrity | 100 % | 100 % in every run; every byte compared in the large-file runs | measured |
| Recovery in the controlled tests | 100 % | 100 % (38/38, 17/17, and the 20 GB, 150 GB and 200 GB runs) | measured |
| Unnecessary loss of verified data | zero | **zero**: nothing that was on disk and recorded was ever thrown away or downloaded from zero. After a hard kill Bolt re-fetches only what it hadn't recorded yet: about 1–3 s of download (0.1–0.9 GB at 100–400 MB/s locally; a few MB on an internet line); after a reboot, up to 15 s | measured |
| 150 GB+ | | **150 GB (earlier build) and 200 GB (final build)**: each with 8 kills, an outage and a simulated reboot, and **100 % of the bytes identical** | measured |
| Crashes | zero | none in any completed run | measured |

## Limits and dependencies

* **Resuming needs the server's help.** It works only if the server supports range requests. If the server can't resume, or the file changed, Bolt keeps the data and says so. If a link expires, it continues once you give it a fresh link ("Refresh link").
* **Power cuts were simulated, not done.** The PC was not switched off. The fix is that the file is flushed every 15 s and each piece records how far it was flushed; after a reboot, Bolt continues from there. The test proves that bytes missing from the disk are fetched again.
* **The ETA on a hard disk fed faster than it can write** (a local source, or internet faster than ~1.2 Gbit/s) is optimistic at first: Windows' cache absorbs the first GBs at memory speed.
* **Memory above 200 MB** happens only in that same case. It is garbage waiting for collection at 600 MB/s of incoming data, not data held by Bolt; a Node app can't force it away.
* **HTTP/3 (QUIC)** is used by browsers on some CDNs; Node has no HTTP/3, so Bolt uses HTTP/1.1. On this line it made no difference.
* **"All rights reserved" was not added**, because Bolt is under the MIT license (`package.json`). The two contradict each other; change the license first if you want it closed-source.

## How to reproduce

* `node test/run-tests.js` runs all 35 tests.
* `node test/bench.js <code folder> <url> <out folder>` times one download and prints its speed, CPU, memory and the ETA shown every second. Run it on a copy of the old version and on this one, alternating.
* `node test/stress-150gb.js <out folder> [bytes]` is the 150 GB test: hard kills, an outage, a simulated reboot, then every byte checked. It needs that much free space; it took about 40 minutes on a hard disk.
