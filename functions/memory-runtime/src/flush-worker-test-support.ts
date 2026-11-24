export const scope = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
};

export const privateModelId = "openrouter/example/private-checkpoint";
export const agentDefinitionId = "01ARZ3NDEKTSV4RRFFQ69G5FAC";
export const agentReleaseForRun = async () => ({
  data: {
    agentDefinitionId,
    manifest: {
      spec: {
        model: { id: privateModelId },
        runtime: {
          modelInputTokenBudget: 32_000,
          modelOutputTokenReserve: 768,
          modelToolProtocol: "gemma4",
        },
      },
    },
  },
});
