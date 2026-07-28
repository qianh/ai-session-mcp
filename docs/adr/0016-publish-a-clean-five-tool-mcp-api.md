# Publish a clean five-tool MCP API

The first public BrainHub MCP release exposes exactly `upload_sessions`, `search_sessions`, `get_session`, `get_portrait`, and `hub_status`, and identifies the server as `brainhub-mcp`. The unreleased prototype API is not treated as a compatibility contract: `pull_portrait`, the unused `include_original` search parameter, and all cards, distillation, and weekly-report language are removed without aliases. Future breaking changes follow semantic versioning after the first stable release.
