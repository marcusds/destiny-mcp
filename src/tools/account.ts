import { ToolDef, tool, str, fields } from './registry.js';
import { CLASS_NAMES, resolveMembership } from './membership.js';

/** Account-level summaries for the authenticated user (or any public profile). */
export const accountTools: ToolDef[] = [
  tool(
    'get_characters',
    "List a player's characters (most recently played first) with class, power, stats by name, title, and play time. Use the characterId values with character-scoped tools. Omit membership to use your authenticated account.",
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: str('Destiny membership ID (omit to use your authenticated account)'),
      },
    },
    async (ctx, a) => {
      const { membershipType, membershipId } = await resolveMembership(
        ctx,
        a.membershipType as number | undefined,
        a.membershipId as string | undefined
      );
      const profile = await ctx.api.getProfile(membershipType, membershipId, [200]);
      const chars: any[] = Object.values(profile.Response?.characters?.data ?? {});

      const statHashes = new Set<string>();
      for (const c of chars) for (const h of Object.keys(c.stats ?? {})) statHashes.add(h);
      const [statDefs, titleDefs] = await Promise.all([
        ctx.manifest.getDefinitions('DestinyStatDefinition', [...statHashes]),
        ctx.manifest.getDefinitions(
          'DestinyRecordDefinition',
          chars.map((c) => c.titleRecordHash).filter(Boolean)
        ),
      ]);

      const characters = chars
        .sort((x, y) => Date.parse(y.dateLastPlayed) - Date.parse(x.dateLastPlayed))
        .map((c) => {
          const stats: Record<string, number> = {};
          for (const [h, v] of Object.entries<number>(c.stats ?? {})) {
            stats[statDefs[h]?.displayProperties?.name || h] = v;
          }
          const titles = titleDefs[String(c.titleRecordHash)]?.titleInfo?.titlesByGenderHash;
          return {
            characterId: c.characterId,
            class: CLASS_NAMES[c.classType] ?? 'Unknown',
            power: c.light,
            stats,
            title: titles?.[String(c.genderHash)],
            lastPlayed: c.dateLastPlayed,
            hoursPlayed: Math.round(Number(c.minutesPlayedTotal) / 60),
          };
        });
      return { membershipType, membershipId, characters };
    }
  ),
];
