/**
 * Pre-built agent runner script, bundled from sandbox-agent/runner.ts by obuild.
 * This is imported as a text string and written into the sandbox at runtime.
 *
 * Build with: pnpm run build:agent
 */
import agentBundle from "../dist/runner.txt";

export const AGENT_RUNNER_SCRIPT: string = agentBundle;
