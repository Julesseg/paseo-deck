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
  id: string;
  name: string;
  project?: ProjectRecord;
  workspaces: readonly WorkspaceTreeNode[];
}

const otherProject: ProjectTreeGroup = { id: "other", name: "Other", workspaces: [] };

function includesFilter(filter: string, ...values: readonly (string | undefined)[]): boolean {
  return !filter || values.some((value) => value?.toLocaleLowerCase().includes(filter));
}

/** Build display groups from stable project and workspace identities. */
export function deriveTree(directory: DirectorySnapshot, query = ""): readonly ProjectTreeGroup[] {
  const filter = query.trim().toLocaleLowerCase();
  const projects = new Map(directory.projects.map((project) => [project.id, project]));
  const groups = new Map<string, ProjectTreeGroup>();
  const getGroup = (workspace: WorkspaceRecord): ProjectTreeGroup => {
    const project = workspace.projectId ? projects.get(workspace.projectId) : undefined;
    const key = project?.id ?? otherProject.id;
    const current = groups.get(key);
    if (current) return current;
    const created: ProjectTreeGroup = project
      ? { id: project.id, name: project.name, project, workspaces: [] }
      : { ...otherProject, workspaces: [] };
    groups.set(key, created);
    return created;
  };

  for (const workspace of directory.workspaces) {
    if (workspace.archived) continue;
    const group = getGroup(workspace);
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
      group.name,
    );
    if (filter && !workspaceMatches && agents.length === 0) continue;
    const visibleAgents = workspaceMatches
      ? directory.agents.filter((agent) => agent.workspaceId === workspace.id && !agent.archived)
      : agents;
    (group.workspaces as WorkspaceTreeNode[]).push({ workspace, agents: visibleAgents });
  }

  return [...groups.values()]
    .filter((group) => group.workspaces.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((group) => ({
      ...group,
      workspaces: [...group.workspaces].sort((left, right) =>
        left.workspace.title.localeCompare(right.workspace.title),
      ),
    }));
}
