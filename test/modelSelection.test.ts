import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/config/defaults.js";
import {
  applyModelSelectionToConfig,
  getAgentStageModel,
  parseModelSelection
} from "../src/core/modelSelection.js";

describe("model selection", () => {
  it("requires agent-qualified model overrides for multi-agent runs", () => {
    const config = createDefaultConfig({
      projectName: "model-selection-test"
    });

    expect(() =>
      applyModelSelectionToConfig(
        config,
        parseModelSelection({
          model: ["sonnet"]
        })
      )
    ).toThrow("exactly one agent");
  });

  it("rejects model overrides for unknown or unselected agents", () => {
    const config = createDefaultConfig({
      projectName: "model-selection-test"
    });

    expect(() =>
      applyModelSelectionToConfig(
        config,
        parseModelSelection({
          models: "gemini=flash"
        }),
        {
          targetAgentIds: ["mock-codex"]
        }
      )
    ).toThrow('Unknown model override agent "gemini"');

    expect(() =>
      applyModelSelectionToConfig(
        config,
        parseModelSelection({
          models: "mock-claude=sonnet"
        }),
        {
          targetAgentIds: ["mock-codex"]
        }
      )
    ).toThrow("does not match the selected agent set");
  });

  it("applies stage-specific overrides only to selected agents", () => {
    const config = createDefaultConfig({
      projectName: "model-selection-test"
    });
    const updated = applyModelSelectionToConfig(
      config,
      parseModelSelection({
        models: "mock-codex=cheap-plan"
      }),
      {
        stage: "plan",
        targetAgentIds: ["mock-codex"]
      }
    );

    expect(updated.agents["mock-codex"]?.models.plan).toBe("cheap-plan");
    expect(updated.agents["mock-claude"]?.models.plan).toBeUndefined();
  });

  it("uses the plan model as the default reconciliation model", () => {
    const config = createDefaultConfig({
      projectName: "model-selection-test"
    });
    const mockCodex = config.agents["mock-codex"];

    if (!mockCodex) {
      throw new Error("Expected mock-codex config.");
    }

    mockCodex.models.plan = "cheap-plan";
    expect(getAgentStageModel(mockCodex, "reconcile")).toBe("cheap-plan");

    mockCodex.models.reconcile = "strong-synthesis";
    expect(getAgentStageModel(mockCodex, "reconcile")).toBe("strong-synthesis");
  });
});
