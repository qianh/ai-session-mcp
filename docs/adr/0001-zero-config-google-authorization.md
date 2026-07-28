# Provide zero-configuration Google authorization

Public BrainHub distributions include a maintained production OAuth application configuration. A user chooses their own Google account and grants the requested permissions; they do not create a Google Cloud project or supply OAuth client configuration. This keeps Drive data user-owned while making installation an install-and-authorize flow; source builds and forks may still override the application configuration.
