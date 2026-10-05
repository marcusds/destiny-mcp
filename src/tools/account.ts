import { ToolDef, ToolContext, tool, num, str, bool, fields } from './registry.js';
import { CLASS_NAMES, resolveMembership } from './membership.js';

/** DestinyRecordState flag: objectives not yet complete. */
const OBJECTIVE_NOT_COMPLETED = 4;
/** DestinyRecordState flag: hidden from the player (secret triumph not yet revealed). */
const OBSCURED = 8;

/** Find a seal (title) presentation node by node name or title text. */
async function findSeal(ctx: ToolContext, query: string): Promise<{ node: any; title: string }> {
  const q = query.trim().toLowerCase();
  const nodes = (await ctx.manifest.getAll('DestinyPresentationNodeDefinition')).filter(
    (n) => n.completionRecordHash
  );
  const records = await ctx.manifest.getDefinitions(
    'DestinyRecordDefinition',
    nodes.map((n) => n.completionRecordHash)
  );
  const seals = nodes
    .map((node) => {
      const t = records[String(node.completionRecordHash)]?.titleInfo;
      return t?.hasTitle ? { node, title: (t.titlesByGender?.Male ?? '') as string } : null;
    })
    .filter((x): x is { node: any; title: string } => x !== null);
  const name = (x: { node: any }) => (x.node.displayProperties?.name ?? '').toLowerCase();
  const match =
    seals.find((x) => x.title.toLowerCase() === q || name(x) === q) ??
    seals.find((x) => x.title.toLowerCase().includes(q) || name(x).includes(q));
  if (!match) throw new Error(`No title/seal matching "${query}".`);
  return match;
}

/** Fraction of a record's objectives completed (by progress), 0..1. */
function fraction(comp: any): number {
  const objs: any[] = comp?.intervalObjectives?.length
    ? comp.intervalObjectives
    : (comp?.objectives ?? []);
  if (!objs.length)
    return (comp?.state ?? OBJECTIVE_NOT_COMPLETED) & OBJECTIVE_NOT_COMPLETED ? 0 : 1;
  const sum = objs.reduce(
    (acc, o) => acc + Math.min(1, (o.progress ?? 0) / Math.max(1, o.completionValue ?? 1)),
    0
  );
  return sum / objs.length;
}

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

  tool(
    'get_title_progress',
    'Progress toward a title (seal): its triumphs with objective progress, incomplete ones first, closest-to-done first. Find the seal by title ("Fated Weapon") or seal name ("The Edge of Fate"). Character-scoped triumphs use your best character. Omit membership to use your authenticated account.',
    {
      properties: {
        title: str('Title or seal name, e.g. "Fated Weapon", "Edge of Fate", "Rivensbane"'),
        includeComplete: bool('Also list completed triumph names (default false)'),
        membershipType: fields.membershipType(),
        membershipId: str('Destiny membership ID (omit to use your authenticated account)'),
      },
      required: ['title'],
    },
    async (ctx, a) => {
      const { membershipType, membershipId } = await resolveMembership(
        ctx,
        a.membershipType as number | undefined,
        a.membershipId as string | undefined
      );
      const { node, title } = await findSeal(ctx, a.title as string);

      // Collect record hashes from the seal node and any nested child nodes.
      const recordHashes: number[] = [];
      const walk = async (n: any): Promise<void> => {
        for (const r of n?.children?.records ?? []) recordHashes.push(r.recordHash);
        const kids: number[] = (n?.children?.presentationNodes ?? []).map(
          (c: any) => c.presentationNodeHash
        );
        if (!kids.length) return;
        const defs = await ctx.manifest.getDefinitions('DestinyPresentationNodeDefinition', kids);
        for (const k of kids) await walk(defs[String(k)]);
      };
      await walk(node);

      const sealHash = String(node.completionRecordHash);
      const [profile, recordDefs] = await Promise.all([
        ctx.api.getProfile(membershipType, membershipId, [900]),
        ctx.manifest.getDefinitions('DestinyRecordDefinition', recordHashes),
      ]);
      const R = profile.Response ?? {};
      const profileRecords: Record<string, any> = R.profileRecords?.data?.records ?? {};
      const charRecords: Array<Record<string, any>> = Object.values<any>(
        R.characterRecords?.data ?? {}
      ).map((c) => c.records ?? {});

      const objectiveHashes = new Set<number>();
      const entries = recordHashes.map((h) => {
        const def = recordDefs[String(h)];
        // Character-scoped records: use the character with the most progress.
        const comp =
          profileRecords[String(h)] ??
          charRecords
            .map((c) => c[String(h)])
            .filter(Boolean)
            .sort((x, y) => fraction(y) - fraction(x))[0];
        const objectives: any[] = comp?.intervalObjectives?.length
          ? comp.intervalObjectives
          : (comp?.objectives ?? []);
        for (const o of objectives) objectiveHashes.add(o.objectiveHash);
        return { h, def, comp, objectives };
      });
      const objectiveDefs = await ctx.manifest.getDefinitions('DestinyObjectiveDefinition', [
        ...objectiveHashes,
      ]);

      const triumphs = entries.map(({ h, def, comp, objectives }) => {
        const state: number = comp?.state ?? OBJECTIVE_NOT_COMPLETED;
        // Interval (multi-step) records keep the not-completed flag even after
        // every interval is done; judge those by their interval objectives.
        const complete = comp?.intervalObjectives?.length
          ? comp.intervalObjectives.every((o: any) => o.complete)
          : (state & OBJECTIVE_NOT_COMPLETED) === 0;
        const secret = (state & OBSCURED) !== 0;
        return {
          hash: h,
          name: secret ? '(secret triumph)' : (def?.displayProperties?.name ?? String(h)),
          description: secret ? undefined : def?.displayProperties?.description,
          complete,
          percent: Math.round(fraction(comp) * 100),
          objectives: complete
            ? undefined
            : objectives.map((o) => ({
                task: objectiveDefs[String(o.objectiveHash)]?.progressDescription || undefined,
                progress: `${o.progress ?? 0}/${o.completionValue}`,
                complete: o.complete,
              })),
        };
      });
      const incomplete = triumphs.filter((t) => !t.complete).sort((x, y) => y.percent - x.percent);
      // The seal's own counter is authoritative: it can require fewer triumphs
      // than the seal lists (e.g. 24 of 29), and the API doesn't say which count.
      const sealObjective = (
        profileRecords[sealHash] ?? charRecords.map((c) => c[sealHash]).find(Boolean)
      )?.objectives?.[0];
      return {
        seal: node.displayProperties?.name,
        title,
        completed: triumphs.length - incomplete.length,
        total: triumphs.length,
        ...(sealObjective && {
          sealProgress: `${sealObjective.progress}/${sealObjective.completionValue}`,
          ...(sealObjective.completionValue < triumphs.length && {
            note: `The title needs ${sealObjective.completionValue} of these ${triumphs.length} triumphs.`,
          }),
        }),
        incomplete,
        ...(a.includeComplete === true && {
          complete: triumphs.filter((t) => t.complete).map((t) => t.name),
        }),
      };
    }
  ),

  tool(
    'get_checklist',
    'Which individual collectibles you have found in a checklist (e.g. "Kepler Urns", "Kepler Ability Chests", "Feathers of Light", "Lost Sectors", "Region Chests"). Returns found/total, the missing entries by name/number, and where entries were found (the activity you were in, plus the sub-area for Kepler urns/chests), learned automatically as you collect them. Omit name to list available checklists. Omit membership to use your authenticated account.',
    {
      properties: {
        name: str('Checklist name or part of it (omit to list all checklists)'),
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
      const all = await ctx.manifest.getAll('DestinyChecklistDefinition');
      const q = (a.name as string | undefined)?.trim().toLowerCase();
      if (!q) {
        return all
          .map((c) => ({ name: c.displayProperties?.name, entries: c.entries?.length ?? 0 }))
          .filter((c) => c.name)
          .sort((x, y) => x.name.localeCompare(y.name));
      }
      const name = (c: any) => (c.displayProperties?.name ?? '').toLowerCase();
      const checklist = all.find((c) => name(c) === q) ?? all.find((c) => name(c).includes(q));
      if (!checklist) throw new Error(`No checklist matching "${a.name}".`);

      // For your own account, read once through the tracker (which also records
      // any new finds) so the answer matches what was logged; otherwise read directly.
      const primary = await ctx.inventory.resolvePrimary().catch(() => undefined);
      const own =
        primary?.membershipType === membershipType && primary?.membershipId === membershipId;
      const profile =
        (own && (await ctx.checklists?.observe().catch(() => undefined))) ||
        (await ctx.api.getProfile(membershipType, membershipId, [104]));
      const R = profile.Response ?? {};
      const key = String(checklist.hash);
      // Profile-scoped checklists live on profileProgression; character-scoped
      // ones on each character (an entry counts as found on any character).
      const states: Array<Record<string, boolean>> = [
        R.profileProgression?.data?.checklists?.[key],
        ...Object.values<any>(R.characterProgressions?.data ?? {}).map((c) => c.checklists?.[key]),
      ].filter(Boolean);
      const entries: any[] = checklist.entries ?? [];
      const missing = entries
        .filter((e) => !states.some((s) => s[String(e.hash)]))
        .map((e) => e.displayProperties?.name ?? String(e.hash));
      const learned = entries
        .map((e) => ctx.checklists?.locationOf(e.hash))
        .filter((l): l is NonNullable<typeof l> => Boolean(l))
        .map((l) => ({
          entry: l.entry,
          ...(l.area ? { area: l.area } : l.candidates && { possibleAreas: l.candidates }),
          ...(l.activity && { activity: l.activity }),
          foundAt: l.foundAt,
        }));
      return {
        checklist: checklist.displayProperties?.name,
        found: entries.length - missing.length,
        total: entries.length,
        missing,
        ...(learned.length && { foundLocations: learned }),
      };
    }
  ),

  tool(
    'get_reputation',
    'Faction/syndicate reputation ranks for a character (e.g. "The Pikers", "Totality Division", "Vanguard"): rank number and name, progress within the rank, and reputation still needed to reach targetRank. Defaults to your most recently played character. Omit membership to use your authenticated account.',
    {
      properties: {
        name: str('Filter by faction/reputation name (substring)'),
        targetRank: num('Rank to compute the remaining reputation for (e.g. 5)'),
        characterId: str('Character ID (default: most recently played)'),
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
      const profile = await ctx.api.getProfile(membershipType, membershipId, [200, 202]);
      const R = profile.Response ?? {};
      const chars: any[] = Object.values(R.characters?.data ?? {});
      const characterId =
        (a.characterId as string | undefined) ??
        chars.sort((x, y) => Date.parse(y.dateLastPlayed) - Date.parse(x.dateLastPlayed))[0]
          ?.characterId;
      const factions: any[] = Object.values(
        R.characterProgressions?.data?.[characterId]?.factions ?? {}
      );
      const defs = await ctx.manifest.getDefinitions(
        'DestinyProgressionDefinition',
        factions.map((f) => f.progressionHash)
      );
      const q = (a.name as string | undefined)?.toLowerCase();
      const target = a.targetRank as number | undefined;

      const reputations = factions
        .map((f) => {
          const def = defs[String(f.progressionHash)];
          const steps: any[] = def?.steps ?? [];
          const name: string = def?.displayProperties?.name ?? '';
          // Rank N is step index N-1; a step's progressTotal is the rep needed to finish it.
          const rank = f.level + 1;
          let toTarget: number | undefined;
          if (target !== undefined) {
            toTarget = 0;
            if (rank < target) {
              toTarget = f.nextLevelAt - f.progressToNextLevel;
              for (let i = f.level + 1; i < target - 1; i++) {
                toTarget += steps[Math.min(i, steps.length - 1)]?.progressTotal ?? 0;
              }
            }
          }
          return {
            name,
            rank,
            rankName: steps[Math.min(f.level, steps.length - 1)]?.stepName || undefined,
            progress: `${f.progressToNextLevel}/${f.nextLevelAt}`,
            total: f.currentProgress,
            ...(toTarget !== undefined && { [`toRank${target}`]: toTarget }),
          };
        })
        .filter((r) => r.name && (!q || r.name.toLowerCase().includes(q)))
        .sort((x, y) => x.name.localeCompare(y.name));
      return { characterId, reputations };
    }
  ),
];
