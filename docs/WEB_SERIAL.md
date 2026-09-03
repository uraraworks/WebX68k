# Web Serial

[日本語](WEB_SERIAL.ja.md)

WebX68k can connect the X68000 RS-232C port (Z8530 SCC channel A) to a serial
port selected by the user through the Web Serial API.

## Requirements

- A browser that supports Web Serial:
  - Current releases of Chrome, Edge, or Firefox on desktop.
  - Chrome 148 or later on Android.
- A secure browsing context.
- A serial device or a virtual serial-port pair.
- Explicit user permission through the browser port chooser.

Firefox added Web Serial support in version 151. On first use, Firefox asks the
user to install a generated site-permission add-on before showing the port
chooser. Firefox managed by enterprise policies blocks Web Serial by default; an
administrator must allow it by setting `DefaultSerialGuardSetting` to `3`.

These do not currently support it: Firefox for Android, every browser on
iOS/iPadOS, and Safari on macOS. The serial controls remain hidden when the API
is unavailable.

## Connecting

1. Open **Settings**.
2. Select a baud rate.
3. Select **Connect** and choose the serial port in the browser dialog.
4. Select **Disconnect** before unplugging the device when possible.

The format is 8 data bits, no parity, 1 stop bit, and no hardware flow control.
The baud rate is saved in browser storage. Port permission and the active
connection are managed by the browser and are not persisted by WebX68k.
Canceling the port chooser is not treated as an error; the connection simply
stays disconnected. The chooser is shown for every connection attempt so the
user always confirms the target port.

The selected baud rate configures the physical browser port. The emulated SCC data path is not internally paced at that baud rate.

## Data flow and backpressure

Here, backpressure means application-internal capacity management: bounded FIFOs
and Web Streams writer readiness pause the producer. The bridge implements neither
RTS/CTS hardware flow control nor XON/XOFF software flow control.

- Browser input uses a bounded 4096-byte SCC channel A receive FIFO.
- While that FIFO is full, the current receive chunk remains in JavaScript and
  is retried on the next frame after the guest reads data.
- X68000 output uses a bounded 4096-byte SCC channel A transmit FIFO.
- At most one browser write is active. No further core data is drained until
  that write completes, so an unbounded JavaScript queue cannot form.
- RR0 transmit-ready is cleared while the transmit FIFO is full.
- Guest software that ignores transmit-ready can still lose output.

The bridge supports receive interrupts, transmit-buffer-empty interrupts, RR8
receive-data access, and the WR0 interrupt commands. Interrupt causes are
latched and scheduled fairly so serial traffic does not starve SCC channel B
mouse interrupts. RR0 reports CTS and DCD only while Web Serial is connected.
The browser port uses no hardware flow control.

## Save states and resets

Named states restore fields by name, so a state that lacks the added channel A
fields loads those fields with their reset values. Compatibility with data-only
fast states created by an older core is not guaranteed: the added fields change
the total state size, and no fixed fixture covers loading an older layout.

Browser-owned FIFO contents are not saved. They are cleared on machine reset,
save-state load, browser disconnect, and transport error. In-flight data can be
lost at those boundaries.

## Optional Windows virtual-port smoke check with com0com

1. Install com0com and create a paired virtual port, for example COM10 and COM11.
   Some Windows applications require the Win32 device-path form for port numbers
   above COM9 (for example, `\\.\COM10` and `\\.\COM11`). When
   selecting a port from Tera Term's list, the regular COM10/COM11 names are
   normally sufficient.
2. Connect WebX68k to one side of the pair.
3. Open the other side in Tera Term with the same baud rate and 8N1.
4. In Human68k, run **CTTY AUX**.
5. Enter commands from Tera Term and confirm bidirectional input and output.
6. Run **CTTY CON** from Tera Term to return console input to the X68000 screen
   and keyboard.

Set both transmit and receive character encoding in Tera Term to **Shift JIS**.
Japanese text will be garbled if another encoding is selected.

## Building the bundled core

The SCC implementation belongs to the px68k-libretro dependency. Review and
merge that change before the WebX68k PR, then build from its exact commit:

~~~bash
EMSDK_DIR="$HOME/emsdk" \
CORE_SRC_DIR="../px68k-libretro" \
CORE_GIT_VERSION="<px68k commit id>" \
EMSDK_VERSION="6.0.7" \
./scripts/build-core.sh
~~~

EMSDK_DIR, CORE_SRC_DIR, OUT_DIR, CORE_GIT_DIR, CORE_GIT_VERSION,
EMSDK_VERSION, JOBS, CLEAN_BUILD, ALLOW_DIRTY, and CORE_TEST_EXPORTS can be overridden. CORE_GIT_DIR is useful
when building a Windows Git worktree from WSL. The script performs a clean build
by default, rejects an unknown core revision or a different Emscripten version,
and enables the C++ linker mode required by the core. The generated
`px68k_libretro.build.json` records the core revision, clean/dirty state, and
Emscripten version without user names or absolute paths. Normal builds omit the
SCC diagnostic shim and JavaScript exports; set `CORE_TEST_EXPORTS=1` only for a temporary integration-test build.
The manifest's `testExports` field distinguishes production and diagnostic artifacts.
`CORE_TEST_EXPORTS=1` without an explicit `OUT_DIR` stops with an error instead
of overwriting the bundled `public/core` artifact.

## Automated tests

`test/serial.test.ts` uses mock ports to cover support detection, 8N1 opening,
ordered receive, capacity-aware receive waiting, discarding the parked receive
remainder on machine reset, the single in-flight write limit, resource cleanup,
read and write failures, aborting an in-flight write before closing the port when
the read loop fails, repeated and physical disconnects, connection cancellation
races, port-picker cancellation, retry after open failure, and baud-rate
persistence.

`test/core-serial-integration.test.ts` exercises the compiled SCC implementation,
including FIFO behavior, interrupts, IRQ5 de-assertion once no cause remains,
disconnect handling, save-state loading, and the shared WR2 behavior across
channel resets. It needs a core built with the SCC diagnostic exports, which is
not the bundled artifact. Build that core into a temporary directory outside the
repository, then pass its host-visible path explicitly:

~~~sh
CORE_TEST_EXPORTS=1 OUT_DIR=/path/to/temporary/core ./scripts/build-core.sh
WEBX68K_TEST_CORE_JS=/path/to/temporary/core/px68k_libretro.js npm run test:core
~~~

`npm run test:core` fails instead of silently skipping when
`WEBX68K_TEST_CORE_JS` does not name an existing diagnostic core.

`npm test` cannot fail that way, because the rest of the suite must still run
without a diagnostic core. Instead, every run that skips this file prints a
`[SKIP] test/core-serial-integration.test.ts` block on stdout with the reason and
the two commands above, so a green summary never hides the fact that the core
integration tests did not run.

## Behavior notes

- Select the same baud rate in the browser and the X68000 guest. The Web Serial API cannot detect a baud-rate mismatch automatically.
- Bytes transmitted by the guest while disconnected are discarded. The SCC remains transmit-ready, and stale bytes are not sent after reconnection.
- RR1 reports All Sent. Browser input retained for retry in JavaScript does not set Rx Overrun merely because the FIFO is full.
- Bytes are not retried automatically after an operating-system or device write failure, avoiding duplicated or reordered data.
- IRQ5 is withdrawn as soon as no interrupt cause remains, so draining the receive FIFO or reading the last mouse byte does not leave a spurious pending interrupt.
- CTS and DCD stay low while disconnected, because modem control is outside the supported scope.
- Build settings can be overridden with `EMSDK_DIR`, `CORE_SRC_DIR`, `OUT_DIR`,
  `CORE_GIT_DIR`, `CORE_GIT_VERSION`, `EMSDK_VERSION`, `JOBS`, `CLEAN_BUILD`,
  `ALLOW_DIRTY`, and `CORE_TEST_EXPORTS`.
- `scripts/build-core.sh` stops by default when the core worktree is dirty. Set `ALLOW_DIRTY=1` only when the local core changes are intentional.

The behavior above is covered by the automated tests described in
"Automated tests"; reviewers are not expected to reproduce it by hand. The
com0com procedure is an optional end-to-end smoke check for anyone who already
has a device or a virtual port pair available.

## Supported scope

This bridge targets CTTY AUX and ordinary asynchronous 8N1 terminal communication.
Synchronous modes, parity and framing errors, BREAK, DMA/WAIT, external-status interrupts,
in-service tracking (including WR0 Reset Highest IUS), and applications that require
modem-control behavior are outside its supported scope.
