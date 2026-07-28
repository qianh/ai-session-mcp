# Separate official and source-build OAuth identities

The npm release of BrainHub MCP includes the maintained BrainHub Desktop OAuth client and provides zero-configuration authorization to end users. Source builds and forks must provide their own OAuth client, Google Cloud project, consent configuration, and verification; they must not default to the official BrainHub OAuth identity. The official release pipeline supplies its release-specific OAuth configuration without making that identity the default development configuration.
