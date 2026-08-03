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
| `lang` | UI language (`ja` / `en`) | If omitted, resolved in order: `localStorage['webx68k.lang']` → the browser's `navigator.language` (`ja` if it starts with `ja`) → default `en`. Can be switched at runtime with the language toggle button on the toolbar; the choice is persisted to `localStorage` |
| `bridge` | `1` (or empty) to enable the MCP WebSocket bridge | Connects to `ws://127.0.0.1:3099`. See "MCP support" below |
| `fd1` / `fd2` | URL of a disk image to load into FDD1 / FDD2 | See below |
| `hdd` | URL of a disk image to set into the HDD slot | See below |
| `run` | `1` to auto-boot without showing the start overlay | |
| `system` | `1` to load the bundled system disk (`human302.xdf`) into FDD1 | Ignored if `fd1` is also given — `fd1` takes priority |

Notes on `fd1`/`fd2`/`hdd`:

- The URL must be served from a **CORS-enabled origin**, or the fetch will fail.
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

### Boot overlay

On first load, a start overlay offers two choices:

- **Start Without a Disk** — boots with no disk inserted (the IPL-ROM menu
  appears). If a HDD is already set (see below), this button instead reads
  "Boot with the Selected Disks" and boots with it
- **Start with System Disk** — boots with the bundled `human302.xdf` inserted
  into FDD1, straight into Human68k

Audio playback requires a click due to browser autoplay restrictions, so
clicking anywhere on the overlay (including empty space) behaves like the
first button.

### Drag & drop

There are three places you can drop a disk image, ZIP, or LZH archive; the
drop-accepting area is highlighted with a border while dragging:

- **The screen area** (over the emulator display) — a HDD image goes to the
  HDD slot (a message is shown if it's locked because the machine has already
  booted); a FD image goes to FDD1, or to FDD2 if FDD1 is already occupied and
  FDD2 is free (to make use of the two floppy drives). An archive containing
  multiple images doesn't go into a slot — it's registered as a group and the
  Disk Library opens so you can pick which disk goes where.
- **A drive slot row** (FDD1 / FDD2 / HDD) — inserts straight into that slot,
  as before.
- **The Disk Library dialog** — only registers the file(s) into the library;
  nothing is inserted into a slot, since opening the library means you're
  about to choose a destination yourself.

### Drive slots (FDD1 / FDD2 / HDD)

The toolbar's console footer has three drive rows: FDD1, FDD2, and HDD. Each
row lets you insert a file, insert from the Disk Library, create a blank
disk (FDD only), eject, or download the current image. Dropping a file onto
a slot row inserts it into that slot (see "Drag & drop" above for the other
drop targets).

- **FDD1/FDD2 are hot-swappable** — insert/eject while the core is running,
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

The "File transfer" toolbar button opens an FTP-client-style two-pane UI for
moving files between your browser and a mounted disk image (FAT12/16,
Human68k HDD partitions, Shift_JIS filenames, ZIP/LZH extraction on import).
The HDD can only be edited before boot — editing it saves straight back to
IndexedDB, so the changes survive a page reload. Once the machine has
booted, the HDD row is shown as locked/read-only. FDD slots can be written
to while running.

### Save states

The save/load toolbar buttons snapshot and restore the full emulator state
(CPU, RAM, video, sound, FDD/HDD controllers, etc.) to IndexedDB. Only one
quick-save slot is kept. If the currently inserted disks don't match what
was mounted at save time, you'll be asked to confirm before restoring.

### Mouse

Click "Capture Mouse" on the toolbar, or **double right-click on the
canvas**, to lock the pointer and start sending relative mouse movement to
the guest. Press **Esc** (or the toolbar button again) to release. The
"Mouse Resync" button re-anchors absolute-position tracking if the guest
cursor and host cursor ever drift apart.

### BIOS settings

The "Settings" button opens a panel for registering your own
`IPLROM.DAT`/`CGROM.DAT` (if you have a real, dumped one) and adjusting
machine configuration. Settings persist in the browser and are used on
future visits, taking priority over the bundled files.

### Language toggle

The `EN`/`JA` button on the toolbar switches the UI language at runtime; the
choice is saved and reused on your next visit.

## Bundled ROM / disk images

`public/system/` bundles the following, chosen because they're
redistributable:

| File | Contents | Source / terms |
|---|---|---|
| `iplrom.dat` | X68000 IPL-ROM v1.0 | Released for free redistribution by Sharp Corp. and other rights holders via the `@nifty` Sharp Products Users Forum. Redistributed unmodified and free of charge under the terms in `許諾条件.txt` |
| `human302.xdf` | Human68k version 3.02 system disk | Same terms as above |
| `許諾条件.txt` | License terms for the two files above | **Must be included when redistributing** — do not remove it |
| `cgrom.dat` | Font ROM (CGROM) | The real hardware CGROM isn't covered by the free-redistribution grant, so this is a self-generated replacement built from the public-domain Shinonome font (`tools/gen-cgrom/`). Glyph shapes differ from the real ROM |

If you have a real, dumped IPL-ROM/CGROM, you can load them from the
Settings panel instead — they're saved to IndexedDB and take priority over
the bundled files on future visits.

## HDD/FDD handling caveats

- **HDD**: can only be set/edited before boot; read-only and locked once
  running. Blank HDDs are FAT16 data drives only (no IPL).
- **FDD1/FDD2**: hot-swappable at any time.

## MCP support (control WebX68k from AI agents)

Open the page with `?bridge=1` to have it connect to a local MCP server
(`ws://127.0.0.1:3099`) for screen capture, key/mouse input, and disk
operations. Setup and the tool list live in [mcp/README.md](mcp/README.md).

Note: unlike its sister project WebNP2, X68000's console is graphics-only,
so there's no way to read the screen as text — screen state is inspected via
screenshots (and a `wait_screen_change` tool), not a text dump.

## Development

```sh
npm install
npm run dev     # dev server
npm run build   # type-check + production build (dist/)
```

Building the emulator core itself (px68k-libretro → WebAssembly) is done via
`scripts/build-core.sh`; see [docs/DESIGN.md](docs/DESIGN.md) for the full
build setup and how the FDD1/FDD2/HDD triple-mount trick works.

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
- FDD1/FDD2/HDD triple-mount (via a cmd-file + core-option combination), with
  HDD locked while running and FDD1/FDD2 hot-swappable
- Setting a HDD before boot (from the library, a drop, or the slot buttons),
  and editing its contents while it is only set
- Blank HDD creation (40MB, FAT16-formatted, Human68k-partitioned; carries no
  IPL, so it's a data drive only)
- Real access lamps (lit only on actual read/write frames, not just "disk
  inserted"), tracked per-drive for FDD
- Disk Library (browser-side, IndexedDB), blank FD creation, per-slot
  download
- Loading disk images from a ZIP/LZH archive (drop, file picker, or the `fd1`/
  `fd2`/`hdd` URL parameters): a single image inside goes straight into the
  slot; multiple images are grouped as a folder in the Disk Library for you to
  pick from, since the emulator can't tell whether a title wants FDD1+FDD2
  loaded together or single-drive swapping
- File manager: two-pane file transfer between browser and mounted disk
  images, with Human68k Shift_JIS filename handling and ZIP/LZH extraction
- Save states (gzip-compressed, IndexedDB), with a disk-configuration
  mismatch check before restoring
- Mouse support: pointer-lock relative movement plus a closed-loop absolute
  tracking mode that compensates for IOCS mouse acceleration; capture via
  double right-click or toolbar button, release via Esc
- Audio-drift correction so screen-mode changes (15kHz/31kHz) don't cause
  runaway audio delay
- MCP bridge (`?bridge=1`) for AI-agent control: screenshot, key/mouse
  input, disk operations
- Japanese/English UI toggle
- Own-BIOS loading (IPLROM.DAT/CGROM.DAT) via the Settings panel, persisted
  to IndexedDB and prioritized over the bundled files

## Known limitations

- No joypad support (`RETRO_DEVICE_JOYPAD` always reports nothing pressed).
- No multi-disk-side swapping (`SET_DISK_CONTROL_INTERFACE` requests from
  the core are ignored).
- Only one HDD is exposed in the UI (`Config.HDImage[0]`); px68k-libretro
  itself supports up to 16, but WebX68k has a single HDD slot.
- Dropping/selecting/loading-by-URL a ZIP or LZH archive that contains more
  than one disk image never auto-inserts any of them — it's always registered
  as a group in the Disk Library for you to pick from, since there's no way to
  tell whether a title expects simultaneous FDD1+FDD2 loading or single-drive
  disk swapping.
