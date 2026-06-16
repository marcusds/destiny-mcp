# d2-mcp — Destiny 2 MCP Server

A comprehensive [Model Context Protocol](https://modelcontextprotocol.io) server for the
[Bungie.net Destiny 2 API](https://bungie-net.github.io/multi/index.html). It exposes **81 tools**
spanning public reads, authenticated write actions, clan management, friends, a server-side inventory
cache, and a local manifest database.

> Forked from [`DevNvll/destiny-mcp`](https://github.com/DevNvll/destiny-mcp) (MIT) — fork maintained
> at [`marcusds/destiny-mcp`](https://github.com/marcusds/destiny-mcp) — extended with a hardened
> OAuth flow, write actions, clan management, user lookups, and an on-disk manifest cache.

## What's included

| Category                  | Tools                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Profiles & items**      | `get_destiny_profile`, `get_destiny_character`, `get_destiny_item`, `get_linked_profiles`                                                                                                                                                                                                                                                           |
| **Inventory (cached)**    | `get_inventory_summary`, `reload_inventory`                                                                                                                                                                                                                                                                                                         |
| **Player search**         | `search_destiny_player`, `search_destiny_player_by_bungie_name`, `search_by_global_name`                                                                                                                                                                                                                                                            |
| **Stats**                 | `get_activity_history`, `get_historical_stats`, `get_historical_stats_for_account`, `get_aggregate_activity_stats`, `get_unique_weapon_history`, `get_leaderboards`, `get_leaderboards_for_character`, `get_clan_leaderboards`, `get_clan_aggregate_stats`, `get_historical_stats_definition`, `get_post_game_carnage_report`, `report_pgcr_player` |
| **Public game data**      | `get_public_milestones`, `get_public_milestone_content`, `get_public_vendors`                                                                                                                                                                                                                                                                       |
| **Users**                 | `get_bungie_user_by_id`, `get_membership_data_by_id`                                                                                                                                                                                                                                                                                                |
| **Clans (read)**          | `get_clan`, `get_clan_by_name`, `get_clan_members`, `get_clan_admins`, `get_groups_for_member`, `get_potential_groups_for_member`, `search_clans`, `get_clan_weekly_reward_state`, `get_clan_banner_source`                                                                                                                                         |
| **Clans (auth/write)**    | `get_clan_pending_members`, `get_clan_banned_members`, `get_clan_invited_individuals`, `invite_clan_member`, `approve_clan_member`, `approve_all_clan_pending`, `deny_all_clan_pending`, `kick_clan_member`, `ban_clan_member`, `unban_clan_member`, `edit_clan`, `edit_clan_banner`                                                                |
| **Friends (auth)**        | `get_friend_list`, `get_friend_request_list`, `issue_friend_request`, `accept_friend_request`, `decline_friend_request`, `remove_friend`, `remove_friend_request`, `get_platform_friend_list`                                                                                                                                                       |
| **Authenticated reads**   | `get_current_user`, `get_character_vendors`, `get_character_vendor`, `get_collectible_node_details`                                                                                                                                                                                                                                                 |
| **Inventory writes**      | `transfer_item`, `pull_from_postmaster`, `equip_item`, `equip_items`, `set_item_lock_state`, `set_quest_tracked_state`, `insert_socket_plug_free`                                                                                                                                                                                                   |
| **Loadout writes**        | `equip_loadout`, `snapshot_loadout`, `clear_loadout`, `update_loadout_identifiers`                                                                                                                                                                                                                                                                  |
| **AWA (advanced writes)** | `awa_initialize_request`, `awa_get_action_token`                                                                                                                                                                                                                                                                                                    |
| **Manifest**              | `get_destiny_manifest`, `get_destiny_entity_definition`, `manifest_lookup`, `manifest_search`, `manifest_list_tables`, `search_destiny_entities`                                                                                                                                                                                                    |
| **OAuth**                 | `auth_status`, `get_auth_url`, `submit_auth_code`                                                                                                                                                                                                                                                                                                   |

Tools tagged `[auth]` require an OAuth login; `[write]` tools mutate live game state.

## Setup

1. **Register an application** at https://www.bungie.net/en/Application.
   - Copy your **API Key**.
   - For `[auth]`/`[write]` tools, set the app to **Confidential**, copy the **OAuth client_id** and
     **client_secret**, and register a redirect URL (e.g. `https://localhost:7777/callback`).

2. **Configure**
   ```bash
   cp .env.example .env   # fill in BUNGIE_API_KEY (+ OAuth vars for auth tools)
   npm install
   npm run build
   ```

## Running

```bash
npm start              # stdio mode (default; for clients that spawn the binary)
npm run start:http     # HTTP server on :3000 — Streamable HTTP at /mcp + WebSocket
npm run start:http -- --port 3001
```

The HTTP server exposes two transports on one port:

| Transport           | Endpoint                   | Use it for                                 |
| ------------------- | -------------------------- | ------------------------------------------ |
| **Streamable HTTP** | `http://<host>:<port>/mcp` | Archon and most modern MCP clients         |
| **WebSocket**       | `ws://<host>:<port>`       | clients that speak the WebSocket transport |
| **stdio**           | `node dist/index.js stdio` | clients that spawn the server process      |

`GET http://<host>:<port>/` returns a small JSON health/info payload.

### Claude Desktop / MCP client config

```json
{
  "mcpServers": {
    "d2": {
      "command": "node",
      "args": ["/path/to/d2-mcp/dist/index.js", "stdio"],
      "env": {
        "BUNGIE_API_KEY": "your_api_key",
        "BUNGIE_CLIENT_ID": "your_client_id",
        "BUNGIE_CLIENT_SECRET": "your_client_secret",
        "BUNGIE_REDIRECT_URI": "https://localhost:7777/callback"
      }
    }
  }
}
```

## Docker

The image runs the HTTP server (Streamable HTTP `/mcp` + WebSocket on one port) — the natural fit
for a long-running container. Stdio clients that spawn the binary should use `node dist/index.js stdio`.

```bash
cp .env.example .env       # fill in BUNGIE_API_KEY (+ OAuth vars)
docker compose up -d --build
# Streamable HTTP:  http://localhost:3000/mcp   (point Archon / modern clients here)
# WebSocket:        ws://localhost:3000
```

- **Binding:** the port is published on **all interfaces (`0.0.0.0`)** by default. The WebSocket
  transport has no authentication and stored OAuth tokens permit account writes, so anyone who can
  reach this host+port has full access — keep it on a trusted/firewalled network or front it with an
  authenticating proxy. Set `D2_MCP_BIND=127.0.0.1` to restrict it to loopback.
- **Port:** override the host port with `D2_MCP_PORT=3737 docker compose up -d` if 3000 is taken.
- **Auth:** set `D2_MCP_AUTH_TOKEN` in `.env` to require `Authorization: Bearer <token>` on both
  transports — strongly recommended whenever the port is reachable off-host.
- **Persistence:** tokens + the ~350 MB SQLite manifest cache live in the named volume `d2-data`
  (mounted at `/data`), so they survive restarts and image rebuilds.
- **Credentials** are read from `.env` via `env_file` — they are never baked into the image
  (`.env` is in `.dockerignore`).

### OAuth inside Docker

Run the interactive login as a one-off; tokens are written into the shared `d2-data` volume, so the
running service picks them up on its next request:

```bash
docker compose run --rm -p 7777:7777 d2-mcp node dist/index.js auth
```

Open the printed URL, approve, and paste the redirected URL back at the prompt (see below).

## Authentication (for write actions)

Public reads need only `BUNGIE_API_KEY`. The authenticated tools require a one-time OAuth login:

```bash
npm run auth          # prints an authorize URL, captures the callback, stores tokens
```

The `auth` command starts a local listener on `BUNGIE_OAUTH_PORT` to capture the redirect, and also
accepts the code/redirect URL pasted into the terminal as a fallback. Tokens are persisted to
`~/.d2-mcp/tokens.json` (override with `D2_MCP_DATA_DIR`) and **auto-refresh** — you only log in once.

Alternatively, drive it from an agent: call `get_auth_url`, open the URL, then `submit_auth_code`
with the resulting code or redirect URL. Use `auth_status` to check state, and `npm run logout` /
the `logout` command to clear tokens.

## Manifest cache

The first manifest call downloads Bungie's native **SQLite** manifest (`mobileWorldContentPaths`),
unzips it, and caches the database on disk (`~/.d2-mcp/manifest/<version>/world.content`), keyed by
manifest version. Lookups query the DB **row-by-row via `better-sqlite3`**, so a single hash lookup
never loads an entire (tens-of-MB) definition table into memory. A new game version transparently
re-downloads and prunes the old cache. The full DB is ~350 MB on disk.

- `manifest_lookup` — resolve a single `{table, hash}` from the cache
- `manifest_search` — find definitions by name (e.g. search `DestinyInventoryItemDefinition` for a weapon)
- `manifest_list_tables` — list available definition tables
- `get_destiny_entity_definition` — fetch one definition directly from the API (no cache)
- `manifest_lookup` accepts `hashes: [...]` to resolve many hashes in a single call

## Inventory cache

To avoid re-fetching (and re-resolving) a full profile on every question, the server keeps a
**flattened, name-resolved inventory snapshot** per membership:

- `get_inventory_summary` returns compact rows (`name`, `itemType`, `tier`, `location`, `character`,
  `quantity`, `instanceId`, `hash`) with filtering (`location` / `itemType` / `tier` / `nameContains`)
  and pagination (`limit` / `offset`). Omit the membership to use your authenticated account.
- The authenticated account's primary membership is **auto-refreshed hourly** (configurable via
  `D2_MCP_INVENTORY_REFRESH_MINUTES`); reads hit the cached snapshot, so they're instant and don't
  hammer Bungie. The auto-refresh only runs once you've completed `d2-mcp auth`.
- `reload_inventory` (or `get_inventory_summary refresh=true`) forces an immediate live pull.
- Snapshots persist to `~/.d2-mcp/inventory/` so restarts are warm.

## Coverage & caveats

Covers the gameplay-relevant Bungie API surface: Destiny2 (profiles, items, stats, vendors, all
inventory/loadout write actions), GroupV2 (clan reads + full management), User, and Social/Friends.

- **Private profiles:** `get_destiny_profile` / `get_destiny_character` / `get_destiny_item`
  automatically attach your OAuth token when authenticated, so private components (full vault, etc.)
  resolve once you've run `d2-mcp auth`. Without a token they work for public profiles only.
- **`search_destiny_entities`** targets a Bungie endpoint that Bungie has **disabled server-side**
  (returns `ErrorCode 21 NotFound`). It's kept for completeness — use **`manifest_search`** instead,
  which searches the local cache and works.
- **No fireteam tools.** The legacy clan Fireteam service is dead — its endpoints return
  `ErrorCode 5 SystemDisabled`. The modern Fireteam Finder that replaced it is absent from Bungie's
  published API spec (only entity/definition schemas exist), so it can't be targeted reliably.
  Neither is included.
- **Intentionally skipped** (low value for a play-assistant): Forum, Content/CMS, Trending,
  CommunityContent, Tokens/Bungie Rewards, and App-usage endpoints.

## Reference

**Platform types:** `1` Xbox · `2` PSN · `3` Steam · `4` Blizzard · `5` Stadia · `6` Epic · `254` BungieNext · `-1` All

**Common components:** `100` Profiles · `200` Characters · `201` Inventories · `205` Equipment ·
`300` Item Instances · `302` Perks · `304` Stats · `305` Sockets · `400-402` Vendors · `800` Collectibles · `900` Records

**Rate limiting:** 25 requests / 10s (built-in, shared across all tools).

## Architecture

```
src/
  config.ts            env -> BungieConfig
  auth.ts              OAuth: login flow, disk persistence, auto-refresh
  destiny-api.ts       Bungie API client (public + Bearer-authed paths)
  manifest.ts          versioned, on-disk SQLite manifest cache (better-sqlite3)
  rate-limiter.ts      sliding-window limiter
  server.ts            MCP server wiring (stdio + websocket)
  index.ts             CLI (stdio | websocket | auth | logout)
  tools/               one module per domain, aggregated via a registry
    registry.ts        ToolDef type + schema helpers
    read|stats|user|clan|actions|manifest|auth.ts
    index.ts           allTools + name->handler map
```

Adding a tool = add a `tool(...)` entry in the relevant `tools/*.ts` module; it is auto-registered.

## AGENTS.md

[`AGENTS.example.md`](./AGENTS.example.md) is a ready-to-use template for AI agent sessions (Claude
Code, Cursor, etc.). Copy it to your working directory as `AGENTS.md`, fill in the placeholders under
**Account** with your Bungie membership IDs and character IDs, and agents will have the context they
need to drive the MCP server without re-fetching identity data on every turn. It also encodes
hard-won rules about API constraints, build order-of-operations, and Armor 3.0 stat naming.

## License

MIT
