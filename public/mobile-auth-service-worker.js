const GITHUB_CALLBACK_PATH = "/__/auth/handler";
const CALLBACK_PAGE_PATH = "/mobile-auth-callback.html";

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isGithubReturn = event.request.method === "GET"
    && event.request.mode === "navigate"
    && url.origin === self.location.origin
    && url.pathname === GITHUB_CALLBACK_PATH
    && url.searchParams.has("state")
    && (url.searchParams.has("code") || url.searchParams.has("error"));
  if (!isGithubReturn) return;

  event.respondWith(fetch(CALLBACK_PAGE_PATH, { cache: "no-store", credentials: "same-origin" }).then(async (page) => {
    const headers = new Headers(page.headers);
    headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
    return new Response(await page.text(), { status: page.status, statusText: page.statusText, headers });
  }));
});
