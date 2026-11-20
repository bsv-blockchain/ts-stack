import { mkdirSync, writeFileSync } from "node:fs";
import { enforceSonarQueueGate } from "./sonar-queue-gate.mjs";
const result = await enforceSonarQueueGate(Number(process.env.GITHUB_RUN_ID), {
  baseBranch: "codex/merge-queue-sonar-canary-20261120-r4",
});
mkdirSync(".sonar-policy", { recursive: true });
writeFileSync(
  `.sonar-policy/queue-${result.revision}.json`,
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
