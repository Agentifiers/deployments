import type { ModelGatewayService } from "@deployments-ai/model-gateway";

export type BrainModelGateway = ModelGatewayService | (() => Promise<ModelGatewayService>);

export function loadBrainModelGateway(gateway: BrainModelGateway): Promise<ModelGatewayService> {
  return typeof gateway === "function" ? gateway() : Promise.resolve(gateway);
}
