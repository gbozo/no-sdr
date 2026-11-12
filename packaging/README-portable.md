# no-sdr (Rust backend) — portable build

This archive contains the Rust backend (`serverrs`), the prebuilt web client,
a default configuration, bookmark data, and launcher scripts.

## Requirements

- Linux x86-64 (glibc), Linux ARM64 (Raspberry Pi 3/4/5), macOS 11+, or
  Windows 11 x86-64.
- An RTL-SDR reachable through `rtl_tcp` (default `127.0.0.1:1234`), or an
  existing `rtl_tcp` server on your network.

## Run

Linux / macOS:

```sh
./run.sh
```

Windows (Command Prompt or PowerShell):

```bat
run.cmd
```

Then open <http://localhost:3000>.

The launchers set `CONFIG_PATH=./config/config.yaml` and
`STATIC_DIR=./static`. Override either environment variable to use a
different configuration or web build.

## Configure

Edit `config/config.yaml` (server port, admin password, dongles and profiles).
The default image is configured for an `rtl_tcp` server; start `rtl_tcp` on the
machine that owns the dongle and update `host`/`port` if needed.

## Codecs

This build includes Opus support. Every platform (Linux x86-64/ARM64, macOS
and Windows) also includes direct USB RTL-SDR and HackRF support through the
built-in native drivers; no librtlsdr, libusb or libhackrf package is required.
On Windows the device must be bound to WinUSB with Zadig; macOS needs nothing.
On Linux, install the bundled `60-serverrs-rtlsdr.rules`, `60-serverrs-hackrf.rules`,
`60-serverrs-airspy.rules`, `60-serverrs-airspyhf.rules`,
`60-serverrs-hydrasdr.rules`, `60-serverrs-elad.rules` and/or
`60-serverrs-rx888.rules` so a non-root user can open the device:

```sh
sudo cp 60-serverrs-*.rules /usr/lib/udev/rules.d/
sudo udevadm control --reload
```

then unplug and replug it.

The SDRplay RSP, LimeSDR and RigExpert Fobos drivers are built in but use the
vendor libraries at runtime; they are not bundled here. Install:

- **SDRplay**: the SDRplay API package and start its service
  (`sudo systemctl enable --now sdrplay`). On Linux an RSP1 also needs the
  in-tree `msi2500`/`msi001` DVB drivers blacklisted.
- **LimeSDR**: LimeSuite and its own `64-limesuite.rules` udev file.
- **Fobos SDR**: the `libfobos` package and its udev rules.

Without the library or service the server still starts; opening a dongle that
uses that source reports the missing dependency in the admin status/log.

All FFT and IQ codecs are enabled by default.

## License

GPL-3.0-or-later. See `LICENSE`.
