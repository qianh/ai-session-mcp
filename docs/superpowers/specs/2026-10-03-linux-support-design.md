# Linux Support Design

## Goal

Run BrainHub MCP setup, credential storage, and daily jobs on Linux, including Arch Linux, with the same no-plaintext-token rule as macOS.

## Platforms

- macOS keeps Keychain and launchd.
- Linux uses Secret Service and systemd user timers.
- Any other platform, including Windows, still raises `PLATFORM_UNSUPPORTED` with `BrainHub MCP supports macOS and Linux`.

## Credentials

`PlatformSecretStore` on Linux calls `secret-tool`:

- `search service <service>` probes the daemon before setup writes config and before interactive OAuth opens a browser.
- `store --label "BrainHub MCP Google OAuth"` writes the token on stdin.
- `lookup` reads it.
- `clear` deletes it. A missing item is ignored. A D-Bus failure is not.

A missing `secret-tool` tells the user to install `libsecret` and a provider such as `gnome-keyring`. An unavailable `org.freedesktop.secrets` tells the user to start `gnome-keyring` or `kwallet`. Both raise `SECRET_STORE_UNAVAILABLE`, as does a `lookup` that fails for any reason other than a missing item, such as a locked collection; a missing item returns no credential. Tokens never go into argv, TOML, SQLite, or a permission-restricted file.

## Scheduling

Linux units live in `${XDG_CONFIG_HOME:-~/.config}/systemd/user/`:

- `brainhub-upload.service` is `Type=oneshot` and runs `upload --json`.
- `brainhub-upload.timer` uses `OnCalendar=*-*-* HH:MM:00` and `Persistent=true`.
- An Obsidian vault also installs `brainhub-sync.service` and `brainhub-sync.timer` for `portrait sync --json`.

Install runs `systemctl --user daemon-reload` and `systemctl --user enable --now`. Uninstall runs `disable --now`, deletes the unit files, and reloads. Setup does not run `loginctl enable-linger`.

## Paths and status

Linux keeps the existing XDG config, state, and model-cache paths. `hub_status` continues to report scheduler state under the field name `launchd`.

## Tests

Cover `secret-tool` stdin storage, missing-binary and missing-daemon probes, systemd unit contents, enable/disable, Linux setup probing before config writes, and Windows rejection for setup, uninstall, secrets, and the scheduler.
