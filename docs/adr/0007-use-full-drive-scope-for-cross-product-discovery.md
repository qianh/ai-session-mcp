# Use the full Drive scope for cross-product discovery

BrainHub MCP retains the restricted `https://www.googleapis.com/auth/drive` scope, while BrainHub Capture keeps `drive.file`. The broader MCP scope is required to read My Drive root `/Digital_Twin_Profile.md` when another product creates it after MCP authorization without asking the user to select the file later or requiring MCP to create a placeholder. The public OAuth application must complete restricted-scope verification, and runtime operations remain constrained to the BrainHub content root plus that exact portrait path.
