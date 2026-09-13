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

export function shouldUseRedirectSignIn(navigatorLike = {}) {
  if (navigatorLike.userAgentData?.mobile === true) return true;
  const userAgent = String(navigatorLike.userAgent || "");
  const touchIpad = navigatorLike.platform === "MacIntel" && Number(navigatorLike.maxTouchPoints) > 1;
  return touchIpad || /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(userAgent);
}
