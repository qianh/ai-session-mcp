# Use inbox as the only session directory

BrainHub Capture and BrainHub MCP write every captured session under `brain-hub/inbox/<device>/`. BrainHub MCP searches and reads sessions only from this tree. The first public version removes the undefined `sessions/` Drive directory and does not move, archive, or classify inbox entries; `session` in MCP tool names denotes the domain object, not a Drive directory name. A future product that needs a separate lifecycle must introduce it as a new explicit contract.
