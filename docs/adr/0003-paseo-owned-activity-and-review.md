# Paseo owns Workspace activity and Session review attention

Use Paseo's Workspace activity and persisted Session attention as the source of truth for Sidebar status grouping and unread completion. Preserve Paseo's aggregation priority, including Working ahead of Ready to review in a Workspace with mixed Session states, rather than introducing Deck-specific review bookkeeping or a competing Workspace roll-up. This keeps activity and acknowledgement consistent across Paseo clients.

Opening a Session acknowledges only that Session's finished attention; a visible Session finishing is also considered seen. Workspace-wide acknowledgement would mark other unopened Sessions seen, so it is unsuitable for this interaction. Done means no outstanding completion review according to Paseo, not approval of the result or completion of the task.
