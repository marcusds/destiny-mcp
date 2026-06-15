import { ToolDef } from './registry.js';
import { readTools } from './read.js';
import { statsTools } from './stats.js';
import { userTools } from './user.js';
import { clanTools } from './clan.js';
import { actionTools } from './actions.js';
import { manifestTools } from './manifest.js';
import { authTools } from './auth.js';
import { socialTools } from './social.js';
import { fireteamTools } from './fireteam.js';

/** The full set of tools exposed by the server. */
export const allTools: ToolDef[] = [
  ...readTools,
  ...statsTools,
  ...userTools,
  ...clanTools,
  ...actionTools,
  ...manifestTools,
  ...socialTools,
  ...fireteamTools,
  ...authTools,
];

/** name -> ToolDef map for dispatch. */
export const toolMap: Map<string, ToolDef> = new Map(allTools.map((t) => [t.definition.name, t]));

export * from './registry.js';
