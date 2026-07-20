export const DEFAULT_DISCORD_SETTINGS = Object.freeze({
  enabled: false,
  webhookUrl: "",
  visibility: "hidden",
  automaticPost: false,
  displayName: "",
});

const VISIBILITIES = new Set(["hidden", "category", "title"]);

export function normalizeDiscordSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: source.enabled === true,
    webhookUrl: typeof source.webhookUrl === "string" ? source.webhookUrl.trim() : "",
    visibility: VISIBILITIES.has(source.visibility) ? source.visibility : "hidden",
    automaticPost: source.automaticPost === true,
    displayName: typeof source.displayName === "string" ? source.displayName.trim().slice(0, 40) : "",
  };
}

export function createIntegrationSettingsStore({ storage }) {
  let cached = null;

  return {
    async readDiscord({ fresh = false } = {}) {
      if (cached && !fresh) return { ...cached };
      const stored = await storage.readIntegrationSettings("discord");
      cached = normalizeDiscordSettings(stored || DEFAULT_DISCORD_SETTINGS);
      return { ...cached };
    },

    async writeDiscord(value) {
      cached = normalizeDiscordSettings(value);
      await storage.writeIntegrationSettings("discord", cached);
      return { ...cached };
    },

    async clearDiscord() {
      cached = { ...DEFAULT_DISCORD_SETTINGS };
      await storage.clearIntegrationSettings("discord");
      return { ...cached };
    },
  };
}

export { VISIBILITIES };
