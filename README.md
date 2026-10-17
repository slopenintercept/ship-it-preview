# Ship It Studio

Ship It Studio is a clip editor for streamers: bring in your videos, trim them, arrange them into a
reel and export the finished video. The optional **Ship It extension for OBS** saves clips out of
OBS's replay buffer with a hotkey and drops them straight into the Studio.

## Download

**The current build is [`v1.2.8`](https://github.com/slopenintercept/ship-it-preview/releases/tag/v1.2.8).**
If a newer build is listed on the [Releases page](../../releases), take that one instead.

The release page offers three downloads:

- **`ShipIt-1.2.8-Setup.exe`** — both halves in one download. **Take this one** unless you only
  want one half. It installs the Studio and then the extension for you.
- **`ShipItStudio-1.2.8-Setup.exe`** — the Studio (the editor) on its own.
- **`ShipItExtension-1.2.8-Setup.exe`** — the OBS extension on its own.

Taking the two separate files instead of the combined one? **Install the Studio first.**

Windows only for now.

## Install

1. Open the [Releases page](../../releases) and download the file you want.
2. Run it. Windows SmartScreen will show a blue **"Windows protected your PC"** box. Click
   **More info**, then **Run anyway**. This is expected: the installers aren't code-signed yet, and
   SmartScreen warns about anything it hasn't seen signed.
3. Let it finish, then launch Ship It Studio from the Start menu.

Some antivirus tools do the same on the first launch of an unsigned app: hold it back, quarantine
it, or ask you what to do. Allow it, and it should stop asking after that.

The extension needs OBS Studio 32 or newer. If you don't have OBS, the extension's installer will
install it for you first, which is the one prompt asking for admin permission. Start (or restart)
OBS afterwards, then open the Ship It panel from OBS's **Docks** menu.

## Upgrading

Run the new installer straight over your old one. There's nothing to uninstall first, and your
settings, clips and projects are kept. Install both halves of 1.2.8, which the combined download
does. If you're on 0.5.x, `ShipIt-1.2.8-Setup.exe` is the like-for-like replacement.
