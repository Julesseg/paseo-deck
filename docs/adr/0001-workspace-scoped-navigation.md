# Workspace-scoped navigation

The sidebar navigates projects and workspaces. Opening a workspace sets the main pane's scope; its sessions and terminals appear in one tab row. Sidebar movement changes only the highlight, so browsing other workspaces does not replace the current timeline or terminal. This gives the sidebar a stable hierarchy and keeps resource navigation beside its content.

The tradeoff is an extra activation step before using a workspace's resources. Workspace activity combines sessions and terminals to help choose where to go. Its order stays fixed while the sidebar has focus, then updates on leaving the sidebar or refreshing, so a status change cannot move the highlighted row during keyboard navigation.
