# Use notified manual npm upgrades

BrainHub MCP does not install a self-update daemon or mutate the global npm environment. `hub_status` checks npm for a newer release at most once per day and reports availability without contacting a BrainHub service; users upgrade with `npm install -g brainhub-mcp@latest`. On first launch, a new version transactionally migrates local configuration and indexes. A failed migration preserves the previous data and prevents the incompatible version from continuing.
