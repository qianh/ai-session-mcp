# Provide a non-destructive complete uninstall

BrainHub MCP provides `brainhub-mcp uninstall` as the supported cleanup operation before removing the npm package. After one explicit confirmation it unregisters detected MCP clients, removes scheduled tasks, revokes Google authorization, and deletes local credentials, indexes, caches, configuration, and runtime state. It never deletes the user's Drive data or an Obsidian portrait that was previously written. npm lifecycle scripts do not perform this cleanup implicitly.
