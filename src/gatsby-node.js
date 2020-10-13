import { runApisInSteps } from "~/utils/run-steps";
import * as steps from "~/steps/index";

module.exports = runApisInSteps({
  pluginOptionsSchema: [steps.declarePluginOptionsSchema],
  createSchemaCustomization: [
    steps.setGatsbyApiToState,
    steps.ensurePluginRequirementsAreMet,
    steps.ingestRemoteSchema,
    steps.createSchemaCustomization,
  ],

  sourceNodes: [
    steps.setGatsbyApiToState,
    [
      steps.persistPreviouslyCachedImages,
      steps.sourcePreviews,
      steps.sourceNodes,
    ],
    steps.setImageNodeIdCache,
  ],

  onPostBuild: [steps.setImageNodeIdCache],

  onCreateDevServer: [
    [steps.setImageNodeIdCache, steps.startPollingForContentUpdates],
  ],
});
