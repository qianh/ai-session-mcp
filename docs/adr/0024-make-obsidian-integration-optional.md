# Make Obsidian integration optional

Obsidian is an optional BrainHub MCP integration, not an installation prerequisite. If setup finds no vault or the user declines to choose one, authorization, upload, search, MCP client registration, and the session-upload schedule still complete; only the portrait-sync schedule remains disabled. `get_portrait` continues to read the Drive portrait, and a later resumable setup run can select the fixed vault and install the missing sync job.
