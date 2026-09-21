import type {
  AgentRecord,
  DirectorySnapshot,
  ProjectRecord,
  WorkspaceRecord,
} from "../contracts/domain.js";

export interface WorkspaceTreeNode {
  workspace: WorkspaceRecord;
  agents: readonly AgentRecord[];
}

export interface ProjectTreeGroup {
  kind: "project";
  id: string;
  name: string;
  project: ProjectRecord;
  workspaces: readonly WorkspaceTreeNode[];
}

export interface RootWorkspaceTreeNode extends WorkspaceTreeNode {
  kind: "workspace";
}

export type DirectoryTreeNode = ProjectTreeGroup | RootWorkspaceTreeNode;

export function projectForWorkspace(
  projects: readonly ProjectRecord[],
  workspace: WorkspaceRecord,
): ProjectRecord | undefined {
  return workspace.projectId
    ? projects.find((project) => project.id === workspace.projectId)
    : undefined;
}

function includesFilter(filter: string, ...values: readonly (string | undefined)[]): boolean {
  return !filter || values.some((value) => value?.toLocaleLowerCase().includes(filter));
}

/** Build display groups from stable project and workspace identities. */
export function deriveTree(directory: DirectorySnapshot, query = ""): readonly DirectoryTreeNode[] {
  const filter = query.trim().toLocaleLowerCase();
  const groups = new Map<string, ProjectTreeGroup>();
  const roots: RootWorkspaceTreeNode[] = [];
  const getGroup = (project: ProjectRecord): ProjectTreeGroup => {
    const key = project.id;
    const current = groups.get(key);
    if (current) return current;
    const created: ProjectTreeGroup = {
      kind: "project",
      id: project.id,
      name: project.name,
      project,
      workspaces: [],
    };
    groups.set(key, created);
    return created;
  };

  for (const workspace of directory.workspaces) {
    if (workspace.archived) continue;
    const project = projectForWorkspace(directory.projects, workspace);
    const agents = directory.agents.filter((agent) => {
      if (agent.workspaceId !== workspace.id || agent.archived) return false;
      return includesFilter(
        filter,
        agent.title,
        agent.id,
        agent.providerId,
        agent.modelId,
        agent.status,
      );
    });
    const workspaceMatches = includesFilter(
      filter,
      workspace.title,
      workspace.directory,
      project?.name,
    );
    if (filter && !workspaceMatches && agents.length === 0) continue;
    const visibleAgents = workspaceMatches
      ? directory.agents.filter((agent) => agent.workspaceId === workspace.id && !agent.archived)
      : agents;
    if (project) {
      (getGroup(project).workspaces as WorkspaceTreeNode[]).push({
        workspace,
        agents: visibleAgents,
      });
    } else {
      roots.push({ kind: "workspace", workspace, agents: visibleAgents });
    }
  }

  const projectNodes = [...groups.values()]
    .filter((group) => group.workspaces.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((group) => ({
      ...group,
      workspaces: [...group.workspaces].sort((left, right) =>
        left.workspace.title.localeCompare(right.workspace.title),
      ),
    }));
  return [
    ...projectNodes,
    ...roots.sort((left, right) => left.workspace.title.localeCompare(right.workspace.title)),
  ];
}
