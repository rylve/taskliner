try {
  const params = new URLSearchParams(location.search);
  if (params.has("tutorial") && !params.has("guided")) {
    location.replace(new URL("./?guided=1&tutorialPath=1", location.href));
  } else {
    const saved = localStorage.getItem("taskliner-locale");
    const locale = saved === "ja" || saved === "en"
      ? saved
      : (navigator.languages || [navigator.language || "en"]).some((value) =>
        String(value || "").toLowerCase().startsWith("ja")
      ) ? "ja" : "en";
    document.documentElement.lang = locale;
  }
} catch {
  document.documentElement.lang = "en";
}
