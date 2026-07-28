# Keep Drive content independent from upgrades

BrainHub MCP treats previously uploaded Drive sessions as stable user content, not application state. Package releases may migrate local configuration, caches, or rebuildable indexes but never perform a bulk Drive-content migration or rewrite, move, or delete historical content as part of an upgrade. Any future change to the content contract requires a separate explicit product decision rather than an ordinary component release.
