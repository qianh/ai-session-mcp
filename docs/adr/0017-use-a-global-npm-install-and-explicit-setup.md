# Use a global npm install and explicit setup

The supported BrainHub MCP installation flow is `npm install -g brainhub-mcp` followed by `brainhub-mcp setup`. The explicit setup command owns browser-based Google authorization, confirmed history backfill, fixed Obsidian vault selection, detected-client registration, and scheduled-task installation. The package does not launch interactive setup from npm lifecycle scripts because those scripts do not provide a dependable interactive environment.
