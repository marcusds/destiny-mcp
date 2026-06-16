# AGENTS.md

> **This is an example `AGENTS.md`** — copy it to the _parent_ directory of this repo (or wherever
> your AI agent's working directory is), fill in the placeholders under **Account**, and delete this
> notice. It primes an agent session with the context needed to drive the `destiny2` MCP server
> without re-fetching identity data on every turn.

## Purpose

This project exists for interacting with the **Destiny 2 API** (Bungie.net Platform API). There is
no application source code to build or run here — the work is operating against live Destiny 2 account
and game data through an MCP server, and recording notes, scripts, or analysis derived from it.

## How interaction works

All Destiny 2 access goes through the **`destiny2` MCP server**, configured at
`http://<host>:<port>/mcp` (Streamable HTTP transport, local scope). It wraps the Bungie API and
handles OAuth. (Note: this server is reached _via_ Archon, but Archon is the client/manager — the
Destiny tools themselves are served by `destiny2`.)

- MCP tools load only at session start. If the tools are missing, the session was started before the
  server was added — reload Claude Code or run `/mcp` to reconnect.
- Tools are namespaced after the name you register this server under in your MCP config. This doc
  assumes `destiny2`, i.e. `mcp__destiny2__*`. If you registered it under a different key, substitute
  that prefix everywhere below. Load a tool's schema before calling it, e.g. `ToolSearch` with
  `select:mcp__destiny2__get_inventory_summary`.
- **Transport auth:** the `/mcp` endpoint requires `Authorization: Bearer <token>`. This is configured
  once in the Archon/MCP client connection, not per tool call — the agent does not send it. The token
  value is `D2_MCP_AUTH_TOKEN` in the server's `.env` (kept there, not duplicated here). If the
  destiny2 tools disappear after a restart, the client is missing/!matching this header.

## Authentication

- Bungie OAuth is handled server-side. Check state with `auth_status`.
- If not authenticated, use `get_auth_url` → user approves → `submit_auth_code`.
- `[auth]`-tagged tools require an authenticated session; `[write]`-tagged tools mutate live game state.
- Once authenticated, inventory/profile tools may **omit** the membership args to act on this account.

## Account

- Bungie name: **YourName#0000** (bungieNet membershipId `<bungieNetMembershipId>`). _Verify via `auth_status`._
- Cross-save active; primary platform is **Steam** (membershipType `3`, destiny membershipId
  `<destinyMembershipId>`). _Verify via live Bungie-name lookup._
- Characters _(verify via authenticated profile)_:
  - **Hunter** (primary): `<hunterCharacterId>`
  - **Warlock**: `<warlockCharacterId>`
  - **Titan**: `<titanCharacterId>`
- **Directive:** Prefer these identity details directly for profile/inventory/character operations
  rather than re-fetching membership data each time. (The server also caches membership, so omitting
  the args on an authenticated session is cheap and always current.)

## Common operations

- **Inventory (preferred):** use **`get_inventory_summary`** — it returns compact, name-resolved rows
  (`name`, `itemType`, `tier`, `location`, `character`, `quantity`, `instanceId`, `hash`) with
  filtering (`location` / `itemType` / `tier` / `nameContains`) and pagination (`limit` / `offset`).
  Omit the membership to use this account. Reads come from a snapshot that **auto-refreshes hourly**;
  pass `refresh=true` (or call `reload_inventory`) to force a live pull. This replaces dumping a full
  profile and resolving hashes client-side.
- **Raw profile (only when you need components the summary doesn't expose):** `get_destiny_profile`
  with component numbers — 100 Profiles, 200 Characters, 201 CharacterInventories, 205
  CharacterEquipment, 102 ProfileInventories (vault), 300 ItemInstances, 800 Collectibles, 900 Records.
  Request only the components you need.
- **Item name ↔ hash:** raw API responses give item _hashes_, not names. Resolve with
  **`manifest_lookup`** against `DestinyInventoryItemDefinition` — pass `hashes: [...]` to resolve many
  in **one** call. Use `manifest_search` to find a definition by name. (Do **not** use
  `search_destiny_entities`; Bungie has disabled that endpoint.)
- **Item instance detail:** `get_destiny_item` inspects a **known `instanceId`** (perks/stats/sockets)
  — it cannot look an item up by name. To find an item, use `get_inventory_summary` first, then take
  its `instanceId`.
- **Subclass / mods (preferred):** use **`insert_plug_by_name`** — give it `itemId` + `plugName`
  (e.g. "Arc Staff", "Skip Grenade", "Grenade Kickstart") and it resolves the _currently-valid_ hash
  and the _correct socket_ for you. Do **not** hand-resolve plug hashes via `manifest_search` + raw
  `insert_socket_plug_free` (the manifest holds sunset duplicates — easy to pick a dead hash). For a
  2nd copy of a mod, call it again (it fills the next socket).
- **Armor (with stats):** use **`get_armor`** — returns every owned piece (incl. vault) with resolved
  Armor 3.0 stats, `gearTier` (1–5), and energy in one call. Filter by `slot` / `nameContains` /
  `minTier`. Don't loop `get_destiny_item` per piece.
- **Equip / move:** `equip_item`, `equip_items`, `transfer_item`, `pull_from_postmaster`,
  `set_item_lock_state`. Loadout slots: `get_character_loadouts` (find a free slot), `snapshot_loadout`,
  `equip_loadout`, `clear_loadout`, `update_loadout_identifiers`.
- **Clan / social:** `get_clan*`, `get_friend_list`, clan admin tools (invite/kick/ban/approve).
- **Stats / history:** `get_activity_history`, `get_historical_stats`, `get_post_game_carnage_report`.

## Editing builds & loadouts — read this first

Hard-won rules (these cause confusing failures otherwise):

- **Must be in orbit / Tower / a social space.** `equip_item`, `insert_plug_by_name`, and
  `snapshot_loadout` are **forbidden in activities** (errors `1671 DestinyCannotPerformActionAtThisLocation`
  / `1634 DestinyCharacterNotInTower`). If a write fails this way, ask the user to go to orbit, then retry.
  `transfer_item` and `set_item_lock_state` work anywhere.
- **Assume aspects / fragments / mods are unlocked.** These are progression unlocks, not inventory
  items, and the API doesn't cheaply expose per-plug unlock state — so **don't try to pre-verify** them.
  Just proceed to apply: `insert_plug_by_name` either succeeds or reports the exact plug that isn't
  unlocked. Only the _exotic/legendary items themselves_ are worth an ownership check (via
  `get_inventory_summary` / `get_armor`); the subclass plugs and mods are assumed available until an
  insert proves otherwise. (Apply-and-observe beats guessing.)
- **Exotic equip conflict (`1641 DestinyItemUniqueEquipRestricted`).** Only **one exotic weapon** and
  **one exotic armor** piece can be equipped at a time. If equipping an exotic fails with 1641, first
  **equip any non-exotic item in the slot of the currently-equipped exotic** of that category (e.g.
  swap the equipped exotic heavy for a legendary heavy before equipping an exotic hand cannon), then
  equip the desired exotic. Find the current exotic via `get_inventory_summary { location: "equipped" }`
  (tier = Exotic) and pick any Legendary in the same slot as the replacement.
- **Artifact mods cannot be set via the API.** There is no endpoint for the seasonal artifact. The user
  must toggle those by hand on the artifact screen. Always state this; never claim you applied them.
- **Stat name mapping (Armor 3.0, 2025):** the six stats are Weapons / Health / Class / Grenade / Super
  / Melee. "Discipline" → **Grenade** stat; "Class ability / Mobility" → **Class** stat. Armor "tier"
  / "stars" = `gearTier` (1–5); "favor 5-star" = prefer higher `gearTier`.
- **Loadout slots may be full.** Check `get_character_loadouts` for a `free` slot before snapshotting
  (snapshotting a locked slot 500s). If all slots are taken, you cannot save a new build without
  overwriting an existing slot — confirm with the user before doing so.
- **You cannot author a loadout from a spec.** The only way to create one is `snapshot_loadout`, which
  captures **currently-equipped** gear into a slot — so saving a build means equipping it first.
- **Order of operations for a build:** equip exotic + subclass → `insert_plug_by_name` for each
  ability/aspect/fragment → finalize armor (mods are lost if you swap the piece afterward) →
  `insert_plug_by_name` for each mod → (optionally) snapshot to a free slot. Then hand the user the
  artifact-mod list to set manually.

## Working notes

- Prefer `get_inventory_summary` over raw `get_destiny_profile` for anything inventory-related — it
  keeps large payloads out of context and resolves names for you. Only fall back to the raw profile
  for components the summary doesn't cover, and request the minimum component set.
- membershipType codes: 1 Xbox, 2 PSN, 3 Steam, 4 Blizzard, 5 Stadia, 6 Epic, 254 BungieNext, -1 All.
- classType codes: 0 Titan, 1 Hunter, 2 Warlock.

---

## Core Game Concepts & Loadout Optimization

This section is a **reasoning framework** for interpreting build requests, not a source of truth for
current game values. Destiny 2's systems change every season/expansion.

> **⚠️ Verify against the live game.** The armor/stat system was overhauled in **Edge of Fate /
> "Armor 3.0" (2025)** — stats were renamed, the per-stat range changed (stats can now exceed 100),
> and the old "six stats, Tier 1–10, 100 cap, 99 ≈ 90" model no longer applies. **Do not hardcode
> stat names, caps, or tier breakpoints.** Resolve current stat definitions from the manifest
> (`DestinyStatDefinition`) and read the character's actual stat values from the profile before
> reasoning about a build.

When a user requests a build adjustment, parse and categorize components into five pillars before
making any API updates.

### The Five Pillars of a Destiny 2 Build

#### I. Subclass (The Base Engine)

Every build centres on a damage element/subclass (Arc, Solar, Void, Stasis, Strand, or Prismatic).

- **Super & Abilities:** every build defines a Super, Class Ability, Melee, and Grenade.
- **Aspects:** class-specific perks; most subclasses allow **2 Aspects**, and the equipped Aspects
  determine how many Fragment slots are available.
- **Fragments:** universal subclass modifiers. If a user lists more Fragments than the equipped
  Aspects allow, surface the conflict and ask for guidance rather than silently dropping one.

#### II. Exotic Armor (The Build Anchor)

- **Rule:** only **one** Exotic armor piece can be equipped at a time.
- **Execution:** if a user requests a new Exotic, check whether another Exotic is equipped in a
  different slot and swap it for a Legendary alternative first.

#### III. Armor Stats & Tiers

Use **`get_armor`** to read every owned piece with resolved stats + `gearTier` + energy in one call —
don't reason from memory. Armor 3.0 (2025) stats are **Weapons / Health / Class / Grenade / Super /
Melee**; map the user's intent (e.g. "Discipline" → **Grenade**, "class ability" → **Class**) and
honor "5-star" as higher `gearTier`. When prioritizing a stat, pick the highest-`gearTier` pieces that
maximize it, and surface real tradeoffs (a higher-tier piece can have a _lower_ roll in the priority
stat — show the user both rather than silently choosing).

#### IV. Armor Mods (The Modifiers)

Armor mods cost **Energy Capacity** on each piece. Calculate the energy cost of mandatory/requested
mods first, then spend remaining capacity on stat mods toward the user's goals. Mod and energy rules
also shifted with Armor 3.0 — confirm costs/capacity from the manifest rather than assuming fixed
numbers.

#### V. Seasonal Artifact Mods

Artifact mods are passive unlocks on the seasonal artifact grid and don't cost armor energy. Confirm a
requested artifact mod is actually unlocked on the character's current artifact before relying on it.

### Decision & Execution Logic Flow

1. **Parse & validate subclass components.** Inspect the character profile; equipping an incompatible
   ability throws an API exception. Ensure Super, Grenade, Melee, Aspects, and Fragments match the
   chosen element.
2. **Equip the anchor Exotic first.** Locate the requested Exotic via `get_inventory_summary`
   (`tier: Exotic`, `nameContains: ...`), take its `instanceId`, transfer it to the character if it's
   in the vault, then `equip_item`. This locks that slot and forces the other armor choices to be
   Legendary.
3. **Optimize Legendary armor.** Scan inventory + vault for the remaining slots and filter for
   combinations that maximize the prioritized stats at the current effective breakpoints.
4. **Calculate energy and apply mods.** Budget mandatory mods first, then allocate the rest to
   stat/damage mods.

### Handling Ambiguities

- **If stats are tied:** default to the piece with the higher survivability stat (confirm the current
  survivability stat name from the manifest).
- **If mod energy is exceeded:** downgrade to a cheaper mod rather than attempting an over-budget
  insert that will API-error.
- **If items are in the vault:** `transfer_item` them to the character before equipping.

---

## Strict Capability & System Guardrails

### 1. Trust the MCP tools over base knowledge

- **Loadouts/gear ARE API-supported.** Do not tell the user that subclasses, abilities, aspects,
  fragments, or mods cannot be modified via the API — the server exposes equip/loadout/socket tools.
- **Never guess item source or lore.** If you don't know where an item comes from, say so rather than
  inventing a source.

### 2. Armor mods are sockets, not inventory items

- Don't look for armor mods (e.g. _Grenade Kickstart_) in character inventories or the vault. They are
  account-wide unlocks applied to item socket definitions. Assume standard mods are unlocked unless an
  explicit socket API error proves otherwise.

### 3. Proper-noun awareness

- Treat terms like "Skip Grenade" as literal item/ability names in the manifest, not instructions.
