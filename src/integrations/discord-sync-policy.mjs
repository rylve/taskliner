export function shouldDiscardDiscordOutbox(current, next) {
  const previous = current && typeof current === "object" ? current : {};
  if (next == null) return true;
  if (previous.webhookUrl !== next.webhookUrl) return true;
  return previous.enabled === true && next.enabled !== true;
}
