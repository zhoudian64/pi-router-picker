/**
 * Pi extension: live model discovery for OpenAI-compatible routers plus a two-level
 * (prefix -> model) picker command `/pick`.
 *
 * Discovery runs during every Pi catalog refresh (session start, opening /model,
 * credential changes, `pi update --models`) and always falls back to the last known
 * list when the router is unreachable, so one failed request never empties the catalogue.
 *
 * Config resolution (later layers override earlier ones):
 *   provider id : $ROUTER_PROVIDER_ID > single providers key in ~/.pi/agent/models.json > "router"
 *   base url    : $ROUTER_BASE_URL    > models.json <provider>.baseUrl
 *   api key     : $ROUTER_API_KEY     > models.json <provider>.apiKey ($ENV interpolation supported)
 *   metadata    : models.json <provider>.models  >  ./router-models.json shipped with this
 *                 package ($ROUTER_MODEL_DEFS=/path/to.json overrides, "" disables the bundle)
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type ChatDef = {
  id: string;
  name: string;
  api?: string;
  baseUrl?: string;
  input: ("text" | "image")[];
  cost: Record<string, number>;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
};

const DEFAULT_PROVIDER_ID = "router";
const FALLBACK_TEMPLATE = {
  input: ["text", "image"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  contextWindow: 128_000,
  maxTokens: 16_384,
};

let providerId = "";
let baseUrl = "";
let fallbackKey: string | undefined;
let configuredApiKeyFromModelsJson = false;
let seedDefs: ChatDef[] = []; // metadata snapshot taken at load time
let liveDefs: ChatDef[] = []; // last published catalogue (kept when discovery fails)
let groupsCache: string[] = []; // /pick argument completion
let lastRefreshError: string | undefined;

const groupOf = (id: string): string => (id.includes("/") ? id.slice(0, id.indexOf("/")) : "~");
const groupLabel = (g: string): string => (g === "~" ? "(no prefix)" : `${g}/`);

const buildGroupsCache = (defs: { id: string }[]): void => {
  groupsCache = [...new Set(defs.map((def) => groupOf(def.id)))].sort();
};

async function readJson(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Resolve a literal key or a "$NAME"/"${NAME}" environment reference. */
function resolveInterpolated(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ref = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/i.exec(value.trim());
  return ref ? process.env[ref[1]] : value.trim();
}

async function loadConfig(): Promise<boolean> {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const modelsJson = await readJson(join(agentDir, "models.json"));
  const providers: Record<string, any> = modelsJson?.providers ?? {};
  const ids = Object.keys(providers);

  providerId = process.env.ROUTER_PROVIDER_ID?.trim() || (ids.length === 1 ? ids[0] : DEFAULT_PROVIDER_ID);
  const configured = providers[providerId];

  baseUrl = String(process.env.ROUTER_BASE_URL ?? configured?.baseUrl ?? "").replace(/\/+$/, "");
  const envKey = resolveInterpolated(process.env.ROUTER_API_KEY);
  configuredApiKeyFromModelsJson = envKey === undefined && configured?.apiKey !== undefined;
  fallbackKey = envKey ?? resolveInterpolated(configured?.apiKey);

  const bundledPath = fileURLToPath(new URL("./router-models.json", import.meta.url));
  const defsFile = process.env.ROUTER_MODEL_DEFS?.trim();
  const defsPath = defsFile === "" ? undefined : defsFile?.trim() ? defsFile : bundledPath;
  const byId = new Map<string, ChatDef>();
  for (const def of ((await readJson(String(defsPath)))?.models ?? [])) {
    if (def?.id) byId.set(def.id, def);
  }
  // models.json wins over the shipped example so per-machine tuning stays authoritative.
  for (const def of (configured?.models ?? [])) {
    if (def?.id) byId.set(def.id, def);
  }
  seedDefs = [...byId.values()].map((def) => ({ ...def, api: def.api ?? "openai-completions", baseUrl: def.baseUrl ?? baseUrl }));
  liveDefs = [...seedDefs];
  buildGroupsCache(liveDefs);

  if (!baseUrl) return false;
  if (!fallbackKey) {
    console.warn(`[router-picker] no API key resolved for provider "${providerId}" (set ROUTER_API_KEY or models.json apiKey), skipping`);
    return false;
  }
  return true;
}

export default async function (pi: any) {
  if (!(await loadConfig())) return;

  pi.registerProvider(providerId, {
    // Credentials/baseUrl stay owned by models.json unless they were resolved from environment
    // variables; Pi rejects a provider with no authentication method, so the env-only setup path
    // has to hand its values over explicitly.
    ...(process.env.ROUTER_BASE_URL?.trim() ? { baseUrl } : {}),
    ...(process.env.ROUTER_API_KEY?.trim() || !configuredApiKeyFromModelsJson ? { apiKey: fallbackKey } : {}),
    name: `Router (${providerId})`,
    // No `models`: models.json / router-models.json stay authoritative for metadata.
    refreshModels: async (ctx: any): Promise<ChatDef[]> => {
      if (ctx.signal.aborted || !ctx.allowNetwork) return liveDefs;
      try {
        const key = ctx.credential?.type === "api_key" ? ctx.credential.key : fallbackKey;
        const response = await fetch(`${baseUrl}/models`, {
          signal: ctx.signal,
          ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as { data?: Array<{ id?: string }> };
        const list = (payload.data ?? []).map((m) => m?.id).filter((id): id is string => typeof id === "string");
        if (!list.length) throw new Error("router returned an empty model list");
        lastRefreshError = undefined;
        liveDefs = list.map(toDef);
        buildGroupsCache(liveDefs);
        return liveDefs;
      } catch (error) {
        // A failed request must never wipe a catalogue that already works.
        lastRefreshError = error instanceof Error ? error.message : String(error);
        return liveDefs;
      }
    },
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    // Pi creates the model runtime before extensions register their providers, so the initial
    // catalog refresh cannot see this provider: pull once here (same pattern as llama.cpp ext).
    const signal = AbortSignal.timeout(15_000);
    try {
      const result = await ctx.modelRegistry.refresh({ providers: [providerId], allowNetwork: true, force: true, signal });
      if (result.aborted) ctx.ui.notify("/pick: router model refresh timed out, using the last known list", "warning");
      const error = result.errors.get(providerId);
      if (error) ctx.ui.notify(`/pick: router /models refresh failed (${error.message}), using the last known list`, "warning");
    } catch (error) {
      ctx.ui.notify(`/pick: model catalog refresh threw ${String(error)}`, "warning");
    }
    buildGroupsCache(ctx.modelRegistry.getAvailable());
  });

  pi.registerCommand("pick", {
    description: "按机器/分组前缀分级选择 router 模型（Esc 退回上一层）",
    getArgumentCompletions: (prefix: string) => {
      const needle = prefix.replace(/^\//, "").toLowerCase();
      const hits = groupsCache.filter((g) => groupLabel(g).toLowerCase().startsWith(needle));
      return hits.length ? hits.map((g) => ({ value: g, label: `${groupLabel(g)} · group` })) : null;
    },
    handler: async (args: string, ctx: any) => {
      if (!ctx.hasUI) return ctx.ui.notify("/pick 需要 TUI 或 RPC 模式", "info");

      let group = args.trim().replace(/\/+$/, "");
      while (true) {
        const available = ctx.modelRegistry.getAvailable() as any[];
        const byGroup = new Map<string, any[]>();
        for (const model of available) {
          const g = groupOf(model.id);
          byGroup.set(g, [...(byGroup.get(g) ?? []), model]);
        }
        if (!byGroup.size) return ctx.ui.notify("没有可用模型（检查 provider 凭据是否配置）", "error");

        // Level 1: pick a machine/group prefix.
        if (!group || !byGroup.has(group)) {
          const labels = [...byGroup.keys()].sort().map((g) => `${groupLabel(g)}  ·  ${byGroup.get(g)!.length} models`);
          const picked = await ctx.ui.select("选择分组（Esc 退出）", labels, { timeout: 120_000 });
          if (!picked) return; // top-level Escape: leave without switching models
          group = picked.split("/")[0];
        }

        // Level 2: pick one model inside that group. Row ids stay unique even when two
        // models share a display name.
        const models = [...byGroup.get(group)!].sort((a, b) => a.id.localeCompare(b.id));
        const labelOf = (m: any) => `${m.id}${m.name && m.name !== m.id ? ` (${m.name})` : ""}${m.reasoning ? "  ·thinking" : ""}`;
        const chosen = await ctx.ui.select(`${groupLabel(group)} 内选模型（Esc 返回分组）`, models.map(labelOf), { timeout: 120_000 });
        if (!chosen) {
          group = ""; // submenu Escape: step back to the group level
          continue;
        }
        const model = models.find((m) => labelOf(m) === chosen);
        if (!model) continue;
        if (!(await pi.setModel(model))) {
          ctx.ui.notify(`该模型缺少可用凭据：${model.provider}/${model.id}`, "error");
          return;
        }
        ctx.ui.notify(`已切换 ${model.provider}/${model.id}`, "info");
        return;
      }
    },
  });
}

/** Metadata template: same-prefix known model first, then generic defaults. */
function templateForId(id: string): Omit<ChatDef, "id" | "name"> {
  const sibling = seedDefs.find((def) => def.id.startsWith(`${groupOf(id)}/`)) ?? seedDefs[0];
  return {
    input: sibling?.input ?? FALLBACK_TEMPLATE.input,
    cost: sibling?.cost ?? FALLBACK_TEMPLATE.cost,
    reasoning: sibling?.reasoning ?? FALLBACK_TEMPLATE.reasoning,
    contextWindow: sibling?.contextWindow ?? FALLBACK_TEMPLATE.contextWindow,
    maxTokens: sibling?.maxTokens ?? FALLBACK_TEMPLATE.maxTokens,
    ...(sibling?.thinkingLevelMap ? { thinkingLevelMap: sibling.thinkingLevelMap } : {}),
  };
}

function toDef(id: string): ChatDef {
  const known = seedDefs.find((def) => def.id === id);
  if (known) return { ...known, api: "openai-completions", baseUrl };
  return { id, name: id, api: "openai-completions", baseUrl, ...templateForId(id) };
}
