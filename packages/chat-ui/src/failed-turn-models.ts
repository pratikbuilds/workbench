import {
  chatCapableModels,
  providerDisplayName,
} from "@corbits/inference-settings";
import type { ModelInfo } from "@corbits/inference-settings";

import { CHAT_STRINGS } from "./strings";

export const FAILED_TURN_MODEL_PICKER_LIMIT = 4;

export type FailedTurnModelChoice = {
  readonly canonicalName: string;
  readonly label: string;
};

function offeringSupportsTools(capabilities: readonly string[]): boolean {
  return capabilities.some((capability) =>
    capability.startsWith("function-calling"),
  );
}

function toolCapableModels(models: readonly ModelInfo[]): readonly ModelInfo[] {
  const kept: ModelInfo[] = [];
  for (const model of chatCapableModels(models)) {
    const offerings = model.offerings.filter((offering) =>
      offeringSupportsTools(offering.capabilities),
    );
    if (offerings.length === 0) continue;
    kept.push(
      offerings.length === model.offerings.length
        ? model
        : { ...model, offerings: [...offerings] },
    );
  }
  return kept;
}

function toChoices(
  models: readonly ModelInfo[],
  limit: number,
): readonly FailedTurnModelChoice[] {
  return models
    .filter((model) => model.offerings.length > 0)
    .slice(0, limit)
    .map((model) => {
      const topOffering = model.offerings[0];
      return {
        canonicalName: model.canonicalName,
        label: CHAT_STRINGS.workbenchSettingsAgentDetailModelOption(
          model.displayName ?? model.canonicalName,
          topOffering === undefined
            ? ""
            : providerDisplayName(topOffering.providerName),
        ),
      };
    });
}

/**
 * Two-to-four tenant-available chat models for the failed-turn strip
 * picker — the same connected, chat-capable filter Settings' agent
 * model select uses, capped so the strip stays a quiet inline row.
 */
export function failedTurnModelChoices(
  models: readonly ModelInfo[],
  limit = FAILED_TURN_MODEL_PICKER_LIMIT,
): readonly FailedTurnModelChoice[] {
  return toChoices(chatCapableModels(models), limit);
}

/**
 * Same picker as {@link failedTurnModelChoices}, restricted to offerings
 * that advertise function-calling — the recovery set when the failure
 * was that the current model cannot use tools.
 */
export function failedTurnToolCapableModelChoices(
  models: readonly ModelInfo[],
  limit = FAILED_TURN_MODEL_PICKER_LIMIT,
): readonly FailedTurnModelChoice[] {
  return toChoices(toolCapableModels(models), limit);
}
