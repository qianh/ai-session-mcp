# Auto-register detected clients during setup

`brainhub-mcp setup` displays and, after one confirmation, registers every supported CLI client it detects locally and installs the daily session-upload and portrait-synchronization jobs. Missing Claude Code, Codex CLI, or Grok Build clients are skipped instead of failing setup; each registration remains independently removable.
