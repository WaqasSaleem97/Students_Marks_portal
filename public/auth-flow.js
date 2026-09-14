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

export const GITHUB_PROFILE_CACHE_KEY = "githubProfile";
export const MOBILE_GITHUB_CALLBACK_PATH = "/__/auth/handler";
export const MOBILE_GITHUB_RESULT_PATH = "/mobile-auth-callback.html";
export const MOBILE_GITHUB_SESSION_KEY = "studentMarksGithubMobileAuth";
export const MOBILE_GITHUB_SERVICE_WORKER_PATH = "/mobile-auth-service-worker.js";
const MOBILE_GITHUB_SESSION_TTL = 15 * 60 * 1000;
const IDENTITY_TOOLKIT_ORIGIN = "https://identitytoolkit.googleapis.com";

export function shouldUseMobileGithubSignIn(navigatorLike = {}) {
  if (navigatorLike.userAgentData?.mobile === true) return true;
  const userAgent = String(navigatorLike.userAgent || "");
  const touchIpad = navigatorLike.platform === "MacIntel" && Number(navigatorLike.maxTouchPoints) > 1;
  return touchIpad || /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(userAgent);
}

function sessionCookie(documentLike) {
  const prefix = `${MOBILE_GITHUB_SESSION_KEY}=`;
  return String(documentLike?.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) || "";
}

function saveMobileGithubSession(browser, session) {
  const serialized = JSON.stringify(session);
  let saved = false;
  try {
    browser.localStorage.setItem(MOBILE_GITHUB_SESSION_KEY, serialized);
    saved = browser.localStorage.getItem(MOBILE_GITHUB_SESSION_KEY) === serialized;
  } catch { /* A same-origin cookie is the fallback when localStorage is unavailable. */ }

  try {
    browser.document.cookie = `${MOBILE_GITHUB_SESSION_KEY}=${encodeURIComponent(serialized)}; Max-Age=${MOBILE_GITHUB_SESSION_TTL / 1000}; Path=/; Secure; SameSite=Lax`;
    saved = saved || Boolean(sessionCookie(browser.document));
  } catch { /* The localStorage copy may still be available. */ }

  if (!saved) throw new Error("This browser is blocking the storage needed for GitHub sign-in. Enable cookies and site storage, then try again.");
}

export function readMobileGithubSession(browser, now = Date.now()) {
  let serialized = "";
  try { serialized = browser.localStorage.getItem(MOBILE_GITHUB_SESSION_KEY) || ""; }
  catch { /* Try the same-origin cookie below. */ }
  if (!serialized) {
    try { serialized = decodeURIComponent(sessionCookie(browser.document)); }
    catch { serialized = ""; }
  }

  try {
    const session = JSON.parse(serialized);
    const age = now - Number(session.createdAt);
    if (!session.sessionId || !session.callbackUrl || age < 0 || age > MOBILE_GITHUB_SESSION_TTL) return null;
    return session;
  } catch { return null; }
}

export function clearMobileGithubSession(browser) {
  try { browser.localStorage.removeItem(MOBILE_GITHUB_SESSION_KEY); }
  catch { /* Nothing to clear when localStorage is unavailable. */ }
  try { browser.document.cookie = `${MOBILE_GITHUB_SESSION_KEY}=; Max-Age=0; Path=/; Secure; SameSite=Lax`; }
  catch { /* Nothing to clear when cookies are unavailable. */ }
}

function authErrorMessage(payload, fallback) {
  const code = String(payload?.error?.message || "").split(" : ")[0];
  if (code === "OPERATION_NOT_ALLOWED") return "GitHub sign-in is not enabled for this portal.";
  if (["INVALID_IDP_RESPONSE", "INVALID_CREDENTIAL_OR_PROVIDER_ID", "INVALID_OAUTH_CLIENT_ID"].includes(code)) return "GitHub sign-in expired or was rejected. Return to the portal and try again.";
  return fallback;
}

async function identityToolkitRequest(path, config, body, fetchImpl) {
  if (!config?.apiKey) throw new Error("Firebase authentication is not configured.");
  const response = await fetchImpl(`${IDENTITY_TOOLKIT_ORIGIN}/v1/${path}?key=${encodeURIComponent(config.apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(authErrorMessage(payload, "GitHub sign-in could not be completed. Return to the portal and try again."));
  return payload;
}

async function prepareMobileAuthHandler(browser) {
  const serviceWorker = browser.navigator?.serviceWorker;
  if (!serviceWorker?.register) throw new Error("This browser does not support the secure mobile GitHub sign-in flow.");
  const registration = await serviceWorker.register(MOBILE_GITHUB_SERVICE_WORKER_PATH, { scope: "/", updateViaCache: "none" });
  const ready = await serviceWorker.ready;
  if (!registration?.active && !ready?.active) throw new Error("The secure mobile GitHub sign-in flow could not start. Refresh the page and try again.");
}

export async function beginMobileGithubSignIn(config, browser = globalThis, now = Date.now()) {
  const fetchImpl = browser.fetch?.bind(browser);
  if (!fetchImpl || !browser.location?.href) throw new Error("GitHub sign-in is not available in this browser.");
  await prepareMobileAuthHandler(browser);
  const callbackUrl = new URL(MOBILE_GITHUB_CALLBACK_PATH, browser.location.href).href;
  const payload = await identityToolkitRequest("accounts:createAuthUri", config, {
    continueUri: callbackUrl,
    providerId: "github.com",
    oauthScope: "read:user user:email",
    context: "student-marks-mobile-login"
  }, fetchImpl);
  const authUrl = new URL(String(payload.authUri || ""));
  if (authUrl.protocol !== "https:" || authUrl.hostname !== "github.com" || !payload.sessionId) throw new Error("GitHub returned an invalid sign-in request. Please try again.");
  saveMobileGithubSession(browser, { sessionId: payload.sessionId, callbackUrl, createdAt: now });
  browser.location.assign(authUrl.href);
  return authUrl.href;
}

export async function completeMobileGithubSignIn(config, callbackUrl, browser = globalThis, now = Date.now()) {
  const url = new URL(callbackUrl);
  const providerError = url.searchParams.get("error");
  if (providerError) {
    clearMobileGithubSession(browser);
    throw new Error(providerError === "access_denied" ? "GitHub sign-in was cancelled." : "GitHub could not complete sign-in. Return to the portal and try again.");
  }
  if (!url.searchParams.get("code") || !url.searchParams.get("state")) throw new Error("This GitHub sign-in return is incomplete. Return to the portal and try again.");

  const session = readMobileGithubSession(browser, now);
  if (!session) throw new Error("This GitHub sign-in could not be matched to your browser. Return to the portal and try again.");
  const expectedCallback = new URL(session.callbackUrl);
  if (url.origin !== expectedCallback.origin || url.pathname !== expectedCallback.pathname) {
    clearMobileGithubSession(browser);
    throw new Error("This GitHub sign-in return is invalid. Return to the portal and try again.");
  }

  const fetchImpl = browser.fetch?.bind(browser);
  if (!fetchImpl) throw new Error("GitHub sign-in is not available in this browser.");
  const payload = await identityToolkitRequest("accounts:signInWithIdp", config, {
    requestUri: url.href,
    sessionId: session.sessionId,
    returnSecureToken: true,
    returnIdpCredential: true
  }, fetchImpl);
  clearMobileGithubSession(browser);
  return payload;
}
