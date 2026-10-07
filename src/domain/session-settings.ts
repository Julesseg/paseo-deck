import type { AgentRecord, DirectorySnapshot } from "../contracts/domain.js";

/** Audited installed Paseo 0.8 provider setters, not a protocol capability flag. */
export function existingModelSwitchReason(providerId: string | undefined): string | undefined {
  return providerId && ["claude", "codex", "pi"].includes(providerId)
    ? undefined
    : "Model switching is unverified for this provider";
}

export function sessionSettingChoices(
  directory: DirectorySnapshot,
  agent: AgentRecord | undefined,
  setting: "model" | "mode" | "thinking",
  unavailable?: string,
): Array<{ value: string; label: string; disabled: boolean; description?: string }> {
  const provider = directory.providers.find((item) => item.id === agent?.providerId);
  const model = provider?.models.find((item) => item.id === agent?.modelId);
  const reason =
    unavailable ??
    (provider && !provider.ready
      ? (provider.unavailableReason ?? "Provider is unavailable")
      : undefined) ??
    (!agent || agent.archived
      ? "Session is unavailable"
      : agent.status === "running" || agent.status === "starting"
        ? "Session is busy"
        : undefined);
  const choices =
    setting === "model"
      ? (provider?.models ?? []).map((item) => ({
          value: item.id,
          label: item.name,
          reason: !item.selectable
            ? (item.unavailableReason ?? "Model is unavailable")
            : existingModelSwitchReason(agent?.providerId),
        }))
      : (setting === "mode"
          ? [...new Set([...(provider?.modeIds ?? []), ...(agent?.availableModeIds ?? [])])]
          : [
              ...new Set([
                ...(model?.thinkingLevels ?? []),
                ...(agent?.availableThinkingLevels ?? []),
              ]),
            ]
        ).map((value) => ({
          value,
          label: value,
          reason: (setting === "mode"
            ? agent?.availableModeIds
            : agent?.availableThinkingLevels
          )?.includes(value)
            ? undefined
            : `Session does not support this ${setting === "mode" ? "mode" : "thinking level"}`,
        }));
  if (!choices.length)
    return [
      {
        value: "",
        label: `No ${setting} choices available`,
        disabled: true,
        description: reason ?? "Session does not advertise supported choices",
      },
    ];
  return choices.map((item) => {
    const disabledReason = reason ?? item.reason;
    return {
      value: item.value,
      label: item.label,
      disabled: !!disabledReason,
      ...(disabledReason ? { description: disabledReason } : {}),
    };
  });
}
