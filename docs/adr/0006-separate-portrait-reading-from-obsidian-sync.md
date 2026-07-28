# Separate portrait reading from Obsidian synchronization

`get_portrait` is the only public portrait MCP tool. It reads the complete My Drive root file `/Digital_Twin_Profile.md` and returns it to the client without writing local files; `pull_portrait` and portrait Diff extraction are removed. A separate daily background task is the only workflow that writes the latest portrait to Obsidian. This keeps MCP reads free of hidden side effects while preserving automatic daily portrait synchronization.
