import Anthropic from "@anthropic-ai/sdk";
import { WORKDIR } from "./config.js";

export const client = new Anthropic(
  process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {},
);

export { WORKDIR };

// Tool-def type used throughout the project. The Anthropic SDK expects
// input_schema; we keep that key to stay wire-compatible.
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}
