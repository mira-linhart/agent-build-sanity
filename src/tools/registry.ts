// Tool registry. Add a new tool: import its module + push to TOOLS.
// The dispatcher iterates here for both `tools/list` and `tools/call`.

import { tool as checkModelCurrency } from "./check_model_currency";
import { tool as checkDepHealth } from "./check_dep_health";
import { tool as checkRuntimeEol } from "./check_runtime_eol";
import type { ToolDefinition } from "../lib/types";

export const TOOLS: ToolDefinition[] = [
  checkModelCurrency,
  checkDepHealth,
  checkRuntimeEol,
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
