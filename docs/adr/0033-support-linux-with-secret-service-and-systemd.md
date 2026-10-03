# Support Linux with Secret Service and systemd

BrainHub MCP supports macOS and Linux. Windows stays unsupported.

Linux stores Google refresh tokens only in the freedesktop Secret Service through `secret-tool`. Setup probes that service before opening a browser and stops when `secret-tool` is missing or `org.freedesktop.secrets` is unavailable. There is still no plaintext file fallback.

Linux schedules daily upload and optional portrait sync with systemd user timers under `${XDG_CONFIG_HOME:-~/.config}/systemd/user/`. Existing XDG paths remain the Linux config, state, and model-cache locations. Setup does not enable lingering; a logged-out user session does not run the timers unless the user turns lingering on.

macOS continues to use Keychain and launchd. The `hub_status` scheduler field stays named `launchd`.
