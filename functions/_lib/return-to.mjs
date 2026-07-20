const RETURN_TO_BASE = "https://taskliner.invalid";

export function safeReturnTo(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const target = new URL(value, RETURN_TO_BASE);
    if (target.origin !== RETURN_TO_BASE) return "/";
    return `${target.pathname}${target.search}` || "/";
  } catch {
    return "/";
  }
}
