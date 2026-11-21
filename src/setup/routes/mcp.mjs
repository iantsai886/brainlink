// MCP tool surface profile routes: lets the user switch between the slim 8-tool Core
// profile (default) and Full mode or opt-in tool groups.
import { MCP_TOOL_PROFILES, MCP_TOOL_GROUPS } from '../../config.mjs';
import { CORE_MCP_TOOLS, MCP_TOOL_GROUP_MAP } from '../../server.mjs';

export function createMcpRoutes({ file, loadConfig, saveConfig, normalize, withConfigMutation }) {
  const describeProfile = (cfg) => ({
    tool_profile: cfg.mcp?.tool_profile === 'full' ? 'full' : 'core',
    enabled_groups: Array.isArray(cfg.mcp?.enabled_groups) ? [...cfg.mcp.enabled_groups] : [],
    core_tools: [...CORE_MCP_TOOLS],
    available_profiles: [...MCP_TOOL_PROFILES],
    available_groups: Object.entries(MCP_TOOL_GROUP_MAP).map(([id, tools]) => ({ id, tools })),
  });

  return {
    'GET /api/mcp/profile': async () => {
      const cfg = normalize(await loadConfig(file));
      return describeProfile(cfg);
    },
    'POST /api/mcp/profile': async (b) => withConfigMutation(async () => {
      const cfg = normalize(await loadConfig(file));
      const profile = b?.tool_profile === undefined ? cfg.mcp.tool_profile : String(b.tool_profile).trim().toLowerCase();
      if (!MCP_TOOL_PROFILES.includes(profile)) {
        throw new Error(`Unsupported MCP tool profile. Choose ${MCP_TOOL_PROFILES.join(' or ')}.`);
      }
      const rawGroups = b?.enabled_groups === undefined ? cfg.mcp.enabled_groups : b.enabled_groups;
      if (!Array.isArray(rawGroups)) throw new Error('enabled_groups must be an array of tool group names.');
      const invalid = rawGroups.filter((group) => !MCP_TOOL_GROUPS.includes(group));
      if (invalid.length) throw new Error(`Unsupported MCP tool group(s): ${invalid.join(', ')}.`);
      const next = {
        ...cfg,
        mcp: {
          tool_profile: profile,
          enabled_groups: [...new Set(rawGroups)],
        },
      };
      await saveConfig(next, file);
      return { ok: true, ...describeProfile(next) };
    }),
  };
}
