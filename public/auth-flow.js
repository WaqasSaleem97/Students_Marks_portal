export function canonicalAuthUrl(currentUrl, config = {}) {
  const url = new URL(currentUrl);
  const projectId = String(config.projectId || "").trim();
  const authDomain = String(config.authDomain || "").trim().toLowerCase();
  const webAppDomain = projectId ? `${projectId}.web.app`.toLowerCase() : "";

  if (!authDomain || !webAppDomain || url.hostname.toLowerCase() !== webAppDomain) return "";

  url.protocol = "https:";
  url.hostname = authDomain;
  url.port = "";
  return url.href;
}
