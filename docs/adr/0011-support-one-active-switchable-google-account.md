# Support one active, switchable Google account

Each BrainHub MCP configuration binds exactly one active Google account and one selected BrainHub root while allowing explicit account switching. Upload watermarks, backfill decisions, retry state, Drive cursors, and local indexes are partitioned by both the Google account permission ID and root folder ID. A newly used binding receives confirmed history backfill, while returning to a known binding resumes its prior state. Switching never deletes data from the previously active Drive; simultaneous accounts require separate configurations.
