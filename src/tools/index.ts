import { ToolDef } from './registry.js';
import { readTools } from './read.js';
import { statsTools } from './stats.js';
import { userTools } from './user.js';
import { clanTools } from './clan.js';
import { actionTools } from './actions.js';
import { manifestTools } from './manifest.js';
import { authTools } from './auth.js';
import { socialTools } from './social.js';
import { inventoryTools } from './inventory.js';

/** The full set of tools exposed by the server. */
export const allTools: ToolDef[] = [
  ...readTools,
  ...inventoryTools,
  ...statsTools,
  ...userTools,
  ...clanTools,
  ...actionTools,
  ...manifestTools,
  ...socialTools,
  ...authTools,
];

/** name -> ToolDef map for dispatch. */
export const toolMap: Map<string, ToolDef> = new Map(allTools.map((t) => [t.definition.name, t]));

export * from './registry.js';
