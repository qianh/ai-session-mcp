# Synchronize the portrait to a fixed Obsidian vault

Setup binds daily portrait synchronization to one explicit Obsidian vault. Every run atomically overwrites `<vault>/BrainHub/portrait.md` from the authoritative My Drive root file `/Digital_Twin_Profile.md` without retaining dated history, selecting the most recently used vault, or falling back to another directory. If the fixed target is unavailable, the old file remains intact and the task reports failure for a later retry.
