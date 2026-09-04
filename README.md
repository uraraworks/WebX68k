# WebX68k

[日本語](README.ja.md)

A web-based X68000 emulator player, powered by [px68k-libretro](https://github.com/uraraworks/px68k-libretro)
(`emscripten` branch) compiled to WebAssembly. The ROM and system disk are
bundled, so it's a "just open the URL and Human68k boots" experience.

See [docs/DESIGN.md](docs/DESIGN.md) for design and implementation details.

## Try it now

- **Live site**: <https://uraraworks.github.io/WebX68k/>
- **Introduction page**: <https://uraraworks.github.io/WebX68k/about.html?lang=en>
- **Help page**: <https://uraraworks.github.io/WebX68k/help.html?lang=en>

## Usage

### URL parameters

| Parameter | Meaning | Notes |
|---|---|---|
| `lang` | UI language (`ja` / `en`) | If omitted, resolved in order: `localStorage['webx68k.lang']` → the browser's `navigator.language` (`ja` if it starts with `ja`) → default `en`. Can be switched at runtime with the language toggle button in the toolbar's "..." menu; the choice is persisted to `localStorage` |
| `bridge` | `1` (or empty) to enable the MCP WebSocket bridge | Connects to `ws://127.0.0.1:3099`. See "MCP support" below |
| `fd1` / `fd2` | URL of a disk image to load into FDD0 / FDD1 | See below |
| `hdd` | URL of a disk image to set into the HDD slot | See below |
| `lib` | URL of a disk image to register in the Disk Library only (repeatable) | See below |
| `cpu` | `10`/`16`/`25`/`33`/`66`/`100` to override the CPU clock (MHz) for this boot only | A one-off override for reproducing a recommended environment from a shared URL. Reflected in the settings UI but not persisted to `localStorage` (opening the link alone must not overwrite the user's saved default) |
| `ram` | `1`–`12` to override the RAM size (MB) for this boot only | A one-off override for reproducing a recommended environment from a shared URL. Reflected in the settings UI but not persisted to `localStorage` (opening the link alone must not overwrite the user's saved default) |
| `aspect` | `4:3` or `native` to override the display aspect ratio mode for this boot only | A one-off override for reproducing a recommended environment from a shared URL. Reflected in the toggle button state but not persisted to `localStorage` (opening the link alone must not overwrite the user's saved default) |
| `run` | `1` to auto-boot without showing the start overlay | |
| `system` | `1` to load the bundled system disk (`human302.xdf`) into FDD0 | Ignored if `fd1` is also given — `fd1` takes priority |

Notes on `fd1`/`fd2`/`hdd`:

- The URL must be served from a **CORS-enabled origin**. GitHub raw, GitHub
  Pages, and your own CORS-enabled server work directly (plain fetch).
- GitHub **blob URLs** (`https://github.com/<owner>/<repo>/blob/<ref>/<path>`)
  and **raw URLs** (`.../raw/<ref>/<path>`) are automatically rewritten to
  `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` before
  fetching, so they are fetched directly without going through the relay
  service (`raw.githubusercontent.com` is CORS-enabled; the plain `github.com`
  URL redirects there without CORS headers, so a direct fetch would fail).
  You can paste a `blob` URL copied straight from the GitHub UI. **Release
  asset URLs** (`.../releases/download/<tag>/<asset>` and
  `.../releases/latest/download/<asset>`) are not rewritten, since
  `raw.githubusercontent.com` cannot serve release assets — these still go
  through the relay service as before (or direct fetch if `VITE_DISK_PROXY`
  is unset).
- Google Drive share links return an HTML viewer page instead of the raw file
  when fetched directly (no CORS error, just the wrong content), so the
  public page **fetches this host through a relay service from the start**.
  If you fork and host this yourself, you need to set `VITE_DISK_PROXY` (see
  below) to use this — without it, this host is reported as unfetchable.
- Dropbox share links are fetched **directly**: the app automatically
  rewrites just the hostname before fetching, so you can paste the URL
  exactly as copied ("Copy link", with `dl=0` left as-is — no need to change
  it to `dl=1`). This works even without a relay service configured. Only
  file-level share links (`/scl/fi/...`) have been verified; folder shares
  and password-protected links are untested. If direct fetch fails, it falls
  back to the relay service as before (when one is configured).
- **OneDrive share links (`1drv.ms` / `onedrive.live.com` / `sharepoint.com`)
  are not supported** — they don't work even through the relay (confirmed by
  testing). Please use Google Drive or Dropbox instead.
- If you use Google Drive, sharing must be set to **"Anyone with the link"**
  (leaving it "Restricted" redirects to a login page and fetching fails).
  Also make sure you copy the **full share link without truncating it** —
  links issued before 2021 carry a `resourcekey` query parameter, and
  dropping it causes the same login-page redirect.
- Revisiting the same URL does **not** re-download it — the image already saved
  in the browser (including any edits made from the guest side) is reused.
- If the URL points to a **ZIP or LZH archive**, it is fetched and extracted the
  same way as a dropped archive (see below): a single disk image inside goes
  straight into the requested slot; multiple images are registered as a group
  in the Disk Library, which opens automatically with that group expanded so
  you can pick which disk goes where.
- `run=1` is skipped automatically when the archive resolves to multiple disks,
  since there's no way to know which one should boot.
- With `run=1`, playback starts muted due to browser autoplay restrictions —
  the first click or key press enables audio.
- A `hdd` image is only *set* into the slot before boot; it does not boot by
  itself unless `run=1` is also given. While set (and before boot), you can
  still edit its contents via file transfer.

Notes on `lib` (for sharing links to multi-disk collections):

- Use `?lib=<url>` and repeat it (`&lib=<url2>`, ...) to specify **multiple
  URLs** (comma-separated values aren't supported, since a URL itself can
  contain a comma).
- Unlike `fd1`/`fd2`/`hdd`, `lib` registers images **regardless of their kind**
  (FD or HDD) — a ZIP mixing HDD and FD images can be registered as-is (the
  usual kind check still applies once you insert an image into a slot).
- Regardless of how many disk images it resolves to, `lib` never auto-inserts
  into a slot — it **always opens the Disk Library** so the recipient can pick
  what to use.
- `run=1` is skipped whenever `lib` is given.
- If combined with `fd1`/`fd2`/`hdd`, those slots are processed first, then
  `lib`.
- Fetching, resuming on revisit, and archive extraction follow the same rules
  as `fd1`/`fd2`/`hdd` (CORS required, no re-download on revisit, ZIP/LZH
  auto-extracted).

### Toolbar

Six buttons stay directly on the toolbar: Pause, Fullscreen, Virtual
Keyboard, Screenshot, Speed, and Reset. Everything else lives behind the
"..." (More) button as a two-level menu: Display (4:3 display toggle), Input
(mouse capture/resync, gamepad settings), Disk (Disk Library, file transfer),
and State (save/load state) groups, plus Settings, Help, and the language
toggle listed directly below the groups. At 640px and wider, opening a group
keeps the menu open and shows the submenu cascading to the right of it
(flipping to the left near the screen edge); narrower screens replace the
menu in place with a "← Back" row instead.

Below 640px (phone width), Speed also moves off the toolbar into a
standalone row at the top of the "..." menu (this keeps the toolbar from
wrapping to two rows when it doesn't have room for both Speed and the
virtual pad). Speed doesn't fit any of the four groups, so it isn't grouped
with the others; the row's label shows the current multiplier and gets a
checkmark while enabled.

Reset sits apart at the toolbar's right edge, a finger's width from the
frequently-pressed buttons, since a misclick there is costlier than on the
others.

**Pause stops emulation and shows a translucent "Paused" overlay** on the
screen. Resume only from the play button in the center of that overlay —
clicking elsewhere on it does nothing, to avoid accidental resumes. Audio
keeps running while paused; once the frame supply stops it fades out
naturally to silence and fades back in on resume. Pause state is not
preserved across a reload (reloading the page always resumes).

**Reset performs a full core restart**, not just a CPU reset: it flushes any
pending disk writes back to storage, then tears down and rebuilds the whole
emulator core. This is needed because core options — CPU speed, RAM size,
pad type — are only read once, on the core's first frame, so a soft reset
wouldn't pick up changes made in Settings the way a restart does. The
restart happens automatically as one continuous operation, though, so it
doesn't leave the HDD slot unlocked for you to swap disks — see "Drive
slots" below.

### Boot overlay

On first load, a start overlay offers two choices:

- **Start Without a Disk** — boots with no disk inserted (the IPL-ROM menu
  appears). If a HDD is already set (see below), this button instead reads
  "Boot with the Selected Disks" and boots with it
- **Start with System Disk** — boots with the bundled `human302.xdf` inserted
  into FDD0, straight into Human68k

Audio playback requires a click due to browser autoplay restrictions, so
starting playback always begins from one of these two buttons — clicking
elsewhere on the overlay does nothing.

`AudioWorklet` is only available in a secure context (`https:` or
`localhost`); opening the page over a plain LAN IP address (`http://
192.168.x.x:port/`) leaves it unavailable. In that case WebX68k now boots
silently instead of failing to boot at all — audio simply has nowhere to
go.

### Web Serial / RS-232C

The Settings dialog can connect X68000 SCC channel A to a host serial port in a
desktop browser that supports Web Serial, such as Chrome, Edge, or Firefox.
Web Serial requires HTTPS. Firefox for Android, browsers on iOS/iPadOS, and
Safari on macOS do not currently expose this API.
Setup, platform notes, and a Windows com0com loopback procedure are documented
in [docs/WEB_SERIAL.md](docs/WEB_SERIAL.md).

### Drag & drop

There are three places you can drop a disk image, ZIP, or LZH archive; the
drop-accepting area is highlighted with a border while dragging:

- **The screen area** (over the emulator display) — a HDD image goes to the
  HDD slot (a message is shown if it's locked because the machine has already
  booted); a FD image goes to FDD0, or to FDD1 if FDD0 is already occupied and
  FDD1 is free (to make use of the two floppy drives). An archive containing
  multiple images doesn't go into a slot — it's registered as a group and the
  Disk Library opens so you can pick which disk goes where.
- **A drive slot row** (FDD0 / FDD1 / HDD) — inserts straight into that slot,
  as before.
- **The Disk Library dialog** — only registers the file(s) into the library;
  nothing is inserted into a slot, since opening the library means you're
  about to choose a destination yourself.

### Drive slots (FDD0 / FDD1 / HDD)

The toolbar's console footer has three drive rows: FDD0, FDD1, and HDD. Each
row lets you insert a file, insert from the Disk Library, create a blank
disk (FDD only), eject, or download the current image. Dropping a file onto
a slot row inserts it into that slot (see "Drag & drop" above for the other
drop targets).

- **FDD0/FDD1 are hot-swappable** — insert/eject while the core is running,
  no reset needed.
- **HDDs can only be handled before boot.** The emulator core cannot swap a
  HDD while running, so dropping/inserting a HDD image before boot no longer
  boots the machine either: it is just *set* into the HDD slot (the slot name
  is shown in italics). While it is only set, you can edit its contents from
  the file transfer dialog; once you're ready, press the boot overlay's first
  button (see "Boot overlay" above — its label switches to "Boot with the
  Selected Disks" once a HDD is set). After boot, the HDD slot buttons and its
  entry in the file transfer target list are disabled — reload the page to
  return to the pre-boot state and swap the HDD image.
- **Create a blank HDD** with the "Create blank HDD" button on the HDD slot
  row: it builds a 40MB, FAT16-formatted, Human68k-partitioned image, saves
  it to the Disk Library, and sets it into the HDD slot. It carries no IPL
  (boot code), so it can't boot on its own — boot Human68k from a floppy and
  use it as a data drive (confirmed on real hardware: booting the system
  disk picks it up as `C:`, and `DIR C:` reports "40779K Byte 使用可能").

### Disk Library

Disk images you've loaded are kept in a browser-side library (IndexedDB), so
you can re-insert them into any slot later without re-uploading.

### File transfer (file manager)

The "File transfer" entry in the toolbar's "..." menu (Disk group) opens an FTP-client-style two-pane UI for
moving files between your browser and a mounted disk image (FAT12/16,
Human68k HDD partitions, Shift_JIS filenames, ZIP/LZH extraction on import).
The HDD can only be edited before boot — editing it saves straight back to
IndexedDB, so the changes survive a page reload. Once the machine has
booted, the HDD row is shown as locked/read-only. FDD slots can be written
to while running.

### Save states

The save/load entries in the toolbar's "..." menu (State group) snapshot and restore the full emulator state
(CPU, RAM, video, sound, FDD/HDD controllers, etc.) to IndexedDB. Only one
quick-save slot is kept. If the currently inserted disks don't match what
was mounted at save time, you'll be asked to confirm before restoring.

A state records *which* disks were mounted, not their contents. Disk contents are
persisted separately by the autosave below, so loading a state does not rewind a
disk to how it was at save time.

### Disk autosave

Whatever the guest writes to a disk is written back to the disk library
(IndexedDB) automatically. px68k keeps those writes only in the core's in-memory
image (FDD) or the emscripten FS file (HDD), so without this they would vanish
when the page goes away.

- Write-only dirty flags live in the fork (`FDD_DirtyMask` in fdd.c, `SASI_Dirty`
  in sasi.c) and are read through `core-shim.c` getters each frame. Unlike the
  access-lamp flags they are not cleared per frame — the host clears them right
  before it snapshots, so writes during a snapshot are not lost.
- Reading an FDD image requires an eject/re-insert, which the guest sees as a
  media change, so it only happens 1.5s after the access lamp goes quiet. The HDD
  is read straight from the FS file, with a minimum interval instead.
- Write-back also runs on eject, before `restartCore()`, and on
  `visibilitychange` (hidden).
- The bundled system disk (human302.xdf) is excluded — it is a fixed library entry.

### Screenshot

The "Screenshot" toolbar button saves the current display as a PNG
(`webx68k_YYYYMMDD_HHMMSS.png`). The canvas always tracks the core's actual
video resolution (it's resized in `handleVideoRefresh()` whenever the mode
changes — 256x256 / 512x512 / 768x512 etc.), so the saved image is exactly
the resolution currently being displayed, with no letterboxing to crop.

### Emulation speed

The toolbar's "Speed" button is an ON/OFF toggle. OFF (the default) runs at
100% (normal) speed; ON runs at whatever multiplier is chosen in the
settings panel (25% / 50% / 75% / 150% / 200% / 300% / 400% / Unlimited,
default 200%). While ON, the button shows a badge with the current
multiplier (`∞` for Unlimited). The change takes effect immediately from
the toggle itself — no reset needed — and audio pitch shifts along with
it, like a tape running fast or slow (BGM speeds up too). The setting is
not saved, so playback always starts at OFF (100%) on boot and after a
reset.

How fast it can actually go depends on your device's processing power. 400%
is a selectable ceiling, not a guaranteed speed — the settings panel shows
the measured speed you're actually getting, so you can see where it tops
out.

"Unlimited" is a separate mode with no target multiplier — it runs as fast
as your device's processing power allows. It comes with two trade-offs:
audio is silent, because samples are produced many times faster than real
time and the existing pitch-shifting resampler can't keep up; and the
screen updates at roughly 20-30fps instead, since paying the rendering cost
every tick would leave no time for core execution. The settings panel's
measured-speed display still works in Unlimited mode, so you can see the
actual percentage you're getting.

This is separate from the machine configuration's "CPU speed"
(`px68k_cpuspeed`, 10-100MHz) setting: that one changes the emulated
hardware's actual clock and needs a reset, while this one just changes the
host's execution pace and applies immediately.

### Virtual keyboard

The keyboard icon on the toolbar opens an X68000-layout virtual keyboard.
SHIFT, CTRL, OPT.1 and OPT.2 are one-shot modifiers consumed after the next
regular key; Caps, Kana, Roman and Code Input stay visually locked until tapped
again. Multi-modifier chords, multi-touch input, and long-press repeat are
supported. Open the separate keypad only when needed with the Keypad button.
Kana labels reflect the virtual keyboard's client-side state; if it differs from the guest, press the Kana key again to bring them back in sync.

Long-press repeat delay/interval follow the X68000's own SRAM setting (the one
SWITCH.X changes), for both the physical and virtual keyboard. Changing it via
SWITCH.X while running is picked up live. As on real hardware, repeat keeps the
key held and emits make codes only; a single break code is sent when the key is
actually released.

SRAM (boot drive, memory size, key repeat, and other SWITCH.X settings) is
automatically persisted to IndexedDB, so these settings survive a page reload.
That said, key repeat is the only SWITCH.X setting the host emulates itself —
key-click sound and keyboard LED control aren't supported, and the memory
size always follows the settings dialog rather than SWITCH.X.

### Virtual pad (on-screen pad)

For playing games on a phone, the "Show Input Panel" toolbar button (also
toggled by the keyboard/pad/mouse chip once a panel is open) can show a touch virtual pad
instead of the virtual keyboard or virtual trackpad — they're mutually
exclusive. Directional
input is an analog-stick-style control (a fixed base with a knob, snapping to
8 directions), so a light tap near the edge of the circle is enough to get a
direction out.

What each on-screen part sends is a **profile**: a map from a screen part
(stick directions, buttons) to either a joystick input or a keyboard key.
Four built-in profiles are included: Joystick (2 Buttons), Cursor Keys +
Space, Tenkey, and Joystick (6 Buttons). The 6-button layout follows a real
Mega Drive 6-button pad — X/Y/Z on the top row, A/B/C on the bottom, both
rising left to right.

The pad's on-screen position is chosen automatically from **measured**
layout space (never a hardcoded screen-width breakpoint), in one of three
placements:

- **Panel** — when there's spare room below the screen (as in portrait), the
  pad sits in the same slot as the virtual keyboard, as a docked strip. The
  screen is not shrunk.
- **Sides** — when there's spare room on the left and right of the screen (as
  in landscape), the stick and buttons go there instead, so nothing covers
  the guest screen.
- **Overlay** — when neither kind of margin is big enough, the pad is drawn
  semi-transparently on top of the screen.

Pressing the pad chip while the pad is showing opens the profile-select menu.

#### Editing the pad's assignments

"Edit assignments…" at the end of the pad chip's profile menu opens an editor for
the pad's 12 input sources (stick up/down/left/right, A/B/C, X/Y/Z, and
Aux 1/2). Each row can be bound to either a keyboard key or a joystick
button.

The key picker shares the same layout as the virtual keyboard; assigning a
key automatically advances to the next row. Editing a built-in profile
automatically creates a copy for you to edit — the built-in itself is never
changed.

### Keyboard-to-joystick mapping

For PC users without a gamepad who want to play joystick-only software, a
physical key can be mapped to a joystick input. Open it from the toolbar's
"..." menu → Input group → "Keyboard Assignment". **It is disabled by
default**, so it never gets in the way of normal typing until turned on.

Three built-in profiles are included: Arrows -> Joystick (2 Buttons), Arrows
-> Joystick (6 Buttons) (for CPSF-MD-style software), and Arrows -> Numpad —
the last one also doubles as a way to play numpad-only software on a laptop
that has no numpad. Once enabled, any key you've mapped stops working as a
regular character key. Press "Add Key" and then press the physical key you
want to register; it's added as a new input source that you can bind to a
joystick button or a keyboard key. Editing a built-in profile automatically
creates a copy for you to edit — the built-in itself is never changed.

### Mouse

Click "Capture Mouse" in the toolbar's "..." menu (Input group), or
**double right-click on the canvas**, to lock the pointer and start sending
relative mouse movement to the guest. Press **Esc** (or the same menu item
again) to release. The "Mouse Resync" entry in the same group re-anchors
absolute-position tracking if the guest cursor and host cursor ever drift
apart.

On touch devices (where the Pointer Lock API is unavailable — e.g. iOS
Safari), open the **virtual trackpad** instead, via the mouse option on the
keyboard/pad/mouse input-panel chip (or the "Show Input Panel" toolbar button). It's
the third kind of input panel alongside the virtual keyboard and virtual
pad, and it sits in the same strip between the screen and the toolbar
rather than over the screen — so your finger never covers the guest
display while you operate it.

Operation is laptop-trackpad style: drag with one finger to move the
cursor by the finger's motion (with the mouse sensitivity setting
applied), tap for a left click at the current cursor position, two-finger
tap for a right click, and long-press (450ms) to hold the left button
down, then drag to drag. Because the cursor moves independently of the
finger, it is never hidden under your fingertip. Two-finger drag (the
usual trackpad gesture for scrolling/wheel) is not supported — the X68000
mouse only has left/right buttons, with no wheel concept to map it to.

### Display mode (dot-for-dot / 4:3)

WebX68k defaults to dot-for-dot: the core's native resolution drawn at
square pixels, unchanged since the emulator's first release. Real X68000
hardware, however, always fills a 4:3 monitor regardless of the active video
mode. The "..." menu's Display group offers a **4:3 display** toggle that
reproduces that look; the choice is saved to `localStorage`.

The correction is always applied by *enlarging* one axis, never by
shrinking — 512x512-family modes (aspect ratio below 4:3) stretch
horizontally, 768x512-family modes (aspect ratio above 4:3) stretch
vertically. Shrinking is deliberately avoided: the canvas uses
`image-rendering: pixelated`, and scaling a mode like the 768x512 text
screen down would drop 1px-wide character strokes, making text unreadable.
Interpolation is only enabled while 4:3 mode is active — dot-for-dot stays
crisp. The frame around the screen always reserves the 4:3-sized box, so
toggling the mode never shifts the surrounding layout.

### Fullscreen

The "Fullscreen" toolbar button makes the **whole card — including the
toolbar** — fill the display, not just the screen. This means Reset,
switching the input panel, and the rest of the toolbar all stay usable while
fullscreen. The X68000 can switch resolution while running (256x256 /
512x512 / 768x512, etc.), but fullscreen keeps whichever aspect ratio is
currently selected — dot-for-dot or 4:3 (see "Display mode" above) — and
letterboxes with black bars, matching the windowed view's look. Click the
button again, or press **Esc**, to exit fullscreen.

On iPhone, the Fullscreen API is only available on `<video>` elements, so
WebX68k falls back to a page-side pseudo-fullscreen (collapsing the
surrounding page UI) instead — the toolbar still remains visible there too.

If mouse capture is also active while fullscreen, pressing **Esc once
releases both at the same time** — it does not take two presses. This is a
browser-level behavior we can't override (the release can't be
`preventDefault`-ed, and re-entering fullscreen right after can't be done
from script either); since native fullscreen swallows Esc, it's the only way
to release the mouse while fullscreen — an intentional trade-off in favor of
immersion.

### BIOS settings

The "Settings" entry in the toolbar's "..." menu opens a panel for registering your own
`IPLROM.DAT`/`CGROM.DAT` (if you have a real, dumped one) and adjusting
machine configuration. Settings persist in the browser and are used on
future visits, taking priority over the bundled files.

### Language toggle

The `EN`/`JA` button in the toolbar's "..." menu switches the UI language at
runtime; the choice is saved and reused on your next visit.

### Add to Home Screen (PWA)

On iPhone, there is no way for a web page to hide the browser's URL bar.
Adding WebX68k to the Home Screen and launching it from there starts it in
standalone mode, without the URL bar (on Android, the Fullscreen toolbar
button already hides it, since native fullscreen is supported there).

**Saved disks, state, and BIOS (IndexedDB) are not shared between the Home
Screen app and a regular browser (Safari/Chrome)** — on iOS, the Home Screen
app, Safari, and Chrome each have their own independent storage (confirmed on
a real device). It's best to pick one and stick with it; if you play from the
Home Screen app, you also need to register disks from that same app. This is
an iOS platform limitation that cannot be worked around from the app side.

## Bundled ROM / disk images

`public/system/` bundles the following, chosen because they're
redistributable:

| File | Contents | Source / terms |
|---|---|---|
| `iplrom.dat` | X68000 IPL-ROM v1.0 | Released for free redistribution by Sharp Corp. and other rights holders via the `@nifty` Sharp Products Users Forum. Redistributed unmodified and free of charge under the terms in `許諾条件.txt` |
| `human302.xdf` | Human68k version 3.02 system disk | Same terms as above |
| [`許諾条件.txt`](public/system/許諾条件.txt) | License terms for the two files above | **Must be included when redistributing** — do not remove it. It sits next to the images in `public/system/`, and is served on the published site at [`/system/許諾条件.txt`](https://uraraworks.github.io/WebX68k/system/許諾条件.txt) |
| `cgrom.dat` | Font ROM (CGROM) | The real hardware CGROM isn't covered by the free-redistribution grant, so this is a self-generated replacement built from the public-domain Shinonome font (`tools/gen-cgrom/`). Glyph shapes differ from the real ROM |

If you have a real, dumped IPL-ROM/CGROM, you can load them from the
Settings panel instead — they're saved to IndexedDB and take priority over
the bundled files on future visits.

## HDD/FDD handling caveats

- **HDD**: can only be set/edited before boot; read-only and locked once
  running. Blank HDDs are FAT16 data drives only (no IPL).
- **FDD0/FDD1**: hot-swappable at any time.

## Sprout68k shared runtime

Opening a `#p1=` link (a program shared from
[Sprout68k](https://github.com/uraraworks/Sprout68k)) needs a 5 KB runtime, bundled
under `public/sprout-runtime/v1/`. It is **fetched at build time and served by this
site at runtime**, so shared links keep working offline and do not depend on GitHub
being reachable.

To update it to a newer ABI version:

```sh
node tools/fetch-sprout-runtime.mjs
```

This pulls from the pinned release tag (`runtime-v1`), verifies every file against the
manifest, and writes `public/sprout-runtime/v1/` and `src/sprout-share.mts`. Then update
`EXPECTED_MANIFEST_SHA256` in `test/sprout-share.test.ts` to the new manifest hash —
that constant is what proves the bundled copy really is the published release, so the
test fails until you do.

**Older runtime versions must never be deleted.** Code in a shared URL calls the jump
table of the version it was built against.

## MCP support (control WebX68k from AI agents)

Open the page with `?bridge=1` to have it connect to a local MCP server
(`ws://127.0.0.1:3099`) for screen capture, key/mouse input, and disk
operations.

Setup is a single self-contained file — no `git clone`, no `npm install`,
just Node.js 18+:

```sh
curl -fLO https://github.com/uraraworks/WebX68k/releases/latest/download/webx68k-mcp.mjs
claude mcp add webx68k -- node "$PWD/webx68k-mcp.mjs"
```

Then open `https://uraraworks.github.io/WebX68k/?bridge=1` (use a
Chromium-based browser or Firefox — Safari blocks `ws://` from https pages
even to localhost). Full instructions and the tool list live in
[mcp/README.md](mcp/README.md).

The `screen_text` tool reads 8x16 ANK and 16x16 kanji drawn on the text screen
(TVRAM) and returns recognition diagnostics. It cannot read text drawn on GVRAM,
BG, or sprites (as used by many games); use `screenshot` when coverage is near
zero. See [mcp/README.md](mcp/README.md) for details.

## Development

```sh
npm install
npm run dev     # dev server
npm run build   # type-check + production build (dist/)
```

To enable relay fetching for Google Drive, set the `VITE_DISK_PROXY`
environment variable at build time to the URL of your own relay service (no
trailing `/`). If unset (the default), no relay is used and sources that the
direct fetch fails for will simply error out. See the comment in
[.github/workflows/deploy.yml](.github/workflows/deploy.yml) for how this is
configured for the public GitHub Pages build. Dropbox does not need this
setting — it is fetched directly via an automatic hostname rewrite (falling
back to the relay, when configured, only if direct fetch fails for an
unverified share format).

Building the emulator core itself (px68k-libretro → WebAssembly) is done via
`scripts/build-core.sh`; see [docs/DESIGN.md](docs/DESIGN.md) for the full
build setup and how the FDD0/FDD1/HDD triple-mount trick works.

## License

This repository is **GPLv2** ([COPYING](COPYING)).

- `public/core/px68k_libretro.js`/`.wasm` are built from the GPLv2
  [px68k-libretro](https://github.com/libretro/px68k-libretro), using the
  [uraraworks/px68k-libretro](https://github.com/uraraworks/px68k-libretro)
  `emscripten` branch fork (minimal patches for access-lamp support); build
  steps are in [scripts/build-core.sh](scripts/build-core.sh).
- The frontend (`src/`) is licensed GPLv2 as well, since it operates as one
  program with the core.
- `cgrom.dat`, generated by `tools/gen-cgrom/`, derives its glyphs from the
  public-domain Shinonome font (see
  [tools/gen-cgrom/NOTICE.md](tools/gen-cgrom/NOTICE.md)).
- `public/system/`'s ROM/disk images are **not** GPLv2 — they're covered by
  the license terms described above instead.

## Implemented features

- Bundled IPL-ROM/Human68k system disk — boots with no setup required
- Boot overlay with "Start Without a Disk" (relabeled "Boot with the Selected
  Disks" when a HDD is set) / "Start with System Disk"
- FDD0/FDD1/HDD triple-mount (via a cmd-file + core-option combination), with
  HDD locked while running and FDD0/FDD1 hot-swappable
- Setting a HDD before boot (from the library, a drop, or the slot buttons),
  and editing its contents while it is only set
- Blank HDD creation (40MB, FAT16-formatted, Human68k-partitioned; carries no
  IPL, so it's a data drive only)
- Real access lamps (lit only on actual read/write frames, not just "disk
  inserted"), tracked per-drive for FDD
- Disk Library (browser-side, IndexedDB), blank FD creation (2HD 1232KB), per-slot
  download
- Loading disk images from a ZIP/LZH archive (drop, file picker, or the `fd1`/
  `fd2`/`hdd` URL parameters): a single image inside goes straight into the
  slot; multiple images are grouped as a folder in the Disk Library for you to
  pick from, since the emulator can't tell whether a title wants FDD0+FDD1
  loaded together or single-drive swapping
- File manager: two-pane file transfer between browser and mounted disk
  images, with Human68k Shift_JIS filename handling and ZIP/LZH extraction
- Save states (gzip-compressed, IndexedDB), with a disk-configuration
  mismatch check before restoring
- Mouse support: pointer-lock relative movement plus a closed-loop absolute
  tracking mode that compensates for IOCS mouse acceleration; capture via
  double right-click or the toolbar's "..." menu, release via Esc
- Audio-drift correction so screen-mode changes (15kHz/31kHz) don't cause
  runaway audio delay
- 4:3 display mode: reproduces the real hardware's fixed 4:3 aspect ratio by
  enlarging one axis (never shrinking, to keep 1px text lines intact);
  dot-for-dot remains the default
- MCP bridge (`?bridge=1`) for AI-agent control: screenshot, TVRAM ANK/kanji text,
  key/mouse input, disk operations
- Japanese/English UI toggle
- Gamepad support (Gamepad API): per-port selection between the standard 2-button
  pad and 8-button CPSF-MD/CPSF-SFC-equivalent pads. Button/axis assignment editing
  (detect mode, combo-box selection, deadzone adjustment), assigning keyboard keys
  to pad buttons/axes, per-pad port pinning, and all settings persisted to the
  browser's localStorage. A settings dialog covers ports/pad type/assignments
- Own-BIOS loading (IPLROM.DAT/CGROM.DAT) via the Settings panel, persisted
  to IndexedDB and prioritized over the bundled files
- Virtual pad (on-screen touch pad) for phones: analog-stick-style
  direction input with 8-way snapping, 4 built-in profiles (2-button
  joystick / cursor keys+space / tenkey / 6-button joystick), a full
  assignment editor, and 3 auto-selected placements (panel/sides/overlay)
  measured from actual available space
- Keyboard-to-joystick mapping for PC users without a gamepad (3 built-in
  profiles), off by default
- Fullscreen now covers the whole card (toolbar included), with an iPhone
  pseudo-fullscreen fallback since the Fullscreen API there only supports
  `<video>`
- Add to Home Screen (PWA) support so iPhone can hide the browser's URL bar
- Boots silently (instead of failing to boot) when `AudioWorklet` is
  unavailable, e.g. opening the page over a plain LAN IP address

## Known limitations

- Joypad (gamepad) input is supported. The pad type — standard 2-button or
  8-button CPSF-MD/CPSF-SFC — can be switched per port. A pad-type change takes
  effect the next time the core starts; it does not apply immediately while
  running, but it does take effect after pressing Reset (which now restarts
  the core — see "Toolbar" above). The Cyberstick (analog mode) is not
  supported.
- No multi-disk-side swapping (`SET_DISK_CONTROL_INTERFACE` requests from
  the core are ignored).
- Only one HDD is exposed in the UI (`Config.HDImage[0]`); px68k-libretro
  itself supports up to 16, but WebX68k has a single HDD slot.
- Dropping/selecting/loading-by-URL a ZIP or LZH archive that contains more
  than one disk image never auto-inserts any of them — it's always registered
  as a group in the Disk Library for you to pick from, since there's no way to
  tell whether a title expects simultaneous FDD0+FDD1 loading or single-drive
  disk swapping.
