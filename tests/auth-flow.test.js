import test from "node:test";
import assert from "node:assert/strict";
import { beginMobileGithubSignIn, canonicalAuthUrl, completeMobileGithubSignIn, githubAccountId, githubProfileFromFirebaseUser, MOBILE_GITHUB_SESSION_KEY, resolveGithubProfile, shouldUseMobileGithubSignIn } from "../public/auth-flow.js";

const config = {
  apiKey: "test-api-key",
  projectId: "studentsreportcard-809ae",
  authDomain: "studentsreportcard-809ae.firebaseapp.com"
};

test("the web.app alias redirects to the same-origin Firebase Auth domain", () => {
  assert.equal(
    canonicalAuthUrl("https://studentsreportcard-809ae.web.app/register?course=cloud#student", config),
    "https://studentsreportcard-809ae.firebaseapp.com/register?course=cloud#student"
  );
});

test("the Firebase Auth domain and development hosts are not redirected", () => {
  assert.equal(canonicalAuthUrl("https://studentsreportcard-809ae.firebaseapp.com/", config), "");
  assert.equal(canonicalAuthUrl("http://localhost:5000/", config), "");
  assert.equal(canonicalAuthUrl("https://portal.example.edu/", config), "");
});

test("desktop browsers use a popup while mobile browsers use the mobile flow", () => {
  assert.equal(shouldUseMobileGithubSignIn({userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36 Edg/140"}), false);
  assert.equal(shouldUseMobileGithubSignIn({userAgent: "Mozilla/5.0 (Android 16; Mobile) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36"}), true);
  assert.equal(shouldUseMobileGithubSignIn({userAgentData: {mobile: true}, userAgent: "Chromium"}), true);
  assert.equal(shouldUseMobileGithubSignIn({platform: "MacIntel", maxTouchPoints: 5, userAgent: "Mozilla/5.0 (Macintosh)"}), true);
});

test("Firebase GitHub provider data supplies the numeric account ID", () => {
  const user = {uid: "firebase-user", displayName: "Iraj Taimur Malik", email: "irajtaimur@gmail.com", photoURL: "https://avatars.githubusercontent.com/u/327825772?v=4", providerData: [{providerId: "github.com", uid: "327825772"}]};
  const profile = githubProfileFromFirebaseUser(user);
  assert.equal(profile.firebase_uid, "firebase-user");
  assert.equal(profile.id, "327825772");
  assert.equal(githubAccountId({photo_url: user.photoURL}), "327825772");
});

test("a restored Firebase session recovers a missing GitHub username by account ID", async () => {
  const calls = [];
  const user = {uid: "firebase-user", displayName: "Iraj Taimur Malik", email: "irajtaimur@gmail.com", photoURL: "https://avatars.githubusercontent.com/u/327825772?v=4", providerData: [{providerId: "github.com", uid: "327825772"}]};
  const profile = await resolveGithubProfile(user, {}, async (url, options) => {
    calls.push({url, options});
    return {ok: true, json: async () => ({id: 327825772, login: "iraj-github", name: "Iraj Taimur Malik", avatar_url: user.photoURL})};
  });
  assert.equal(calls[0].url, "https://api.github.com/user/327825772");
  assert.equal(profile.id, "327825772");
  assert.equal(profile.login, "iraj-github");
  assert.equal(profile.email, "irajtaimur@gmail.com");
});

test("a cached GitHub profile cannot leak into a different Firebase account", async () => {
  const user = {uid: "new-user", providerData: [{providerId: "github.com", uid: "22"}]};
  const profile = await resolveGithubProfile(user, {firebase_uid: "old-user", id: "11", login: "wrong-user"}, async () => ({ok: true, json: async () => ({id: 22, login: "correct-user"})}));
  assert.equal(profile.id, "22");
  assert.equal(profile.login, "correct-user");
});

function memoryStorage() {
  const values = new Map();
  return {getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
}

test("mobile GitHub sign-in survives returning in a different browser tab", async () => {
  const sharedStorage = memoryStorage();
  const startCalls = [];
  const startBrowser = {
    localStorage: sharedStorage,
    document: {cookie: ""},
    navigator: {serviceWorker: {register: async () => ({active: {}}), ready: Promise.resolve({active: {}})}},
    location: {href: "https://studentsreportcard-809ae.firebaseapp.com/", assigned: "", assign(url) {this.assigned = url;}},
    fetch: async (url, options) => {
      startCalls.push({url, options});
      return {ok: true, json: async () => ({authUri: "https://github.com/login/oauth/authorize?client_id=public", sessionId: "session-123"})};
    }
  };
  await beginMobileGithubSignIn(config, startBrowser, 1_000);
  assert.match(startCalls[0].url, /accounts:createAuthUri/);
  assert.equal(JSON.parse(startCalls[0].options.body).continueUri, "https://studentsreportcard-809ae.firebaseapp.com/__/auth/handler");
  assert.equal(startBrowser.location.assigned, "https://github.com/login/oauth/authorize?client_id=public");
  assert.ok(sharedStorage.getItem(MOBILE_GITHUB_SESSION_KEY));

  const finishCalls = [];
  const callbackBrowser = {
    localStorage: sharedStorage,
    document: {cookie: startBrowser.document.cookie},
    fetch: async (url, options) => {
      finishCalls.push({url, options});
      return {ok: true, json: async () => ({oauthAccessToken: "temporary-token", screenName: "student"})};
    }
  };
  const callbackUrl = "https://studentsreportcard-809ae.firebaseapp.com/__/auth/handler?code=one-time-code&state=verified-state";
  const result = await completeMobileGithubSignIn(config, callbackUrl, callbackBrowser, 1_500);
  const exchangeBody = JSON.parse(finishCalls[0].options.body);
  assert.match(finishCalls[0].url, /accounts:signInWithIdp/);
  assert.equal(exchangeBody.requestUri, callbackUrl);
  assert.equal(exchangeBody.sessionId, "session-123");
  assert.equal(result.screenName, "student");
  assert.equal(sharedStorage.getItem(MOBILE_GITHUB_SESSION_KEY), null);
});

test("mobile callback refuses a return without its origin-wide session", async () => {
  const browser = {localStorage: memoryStorage(), document: {cookie: ""}, fetch: async () => {throw new Error("must not fetch");}};
  await assert.rejects(
    completeMobileGithubSignIn(config, "https://studentsreportcard-809ae.firebaseapp.com/__/auth/handler?code=code&state=state", browser),
    /could not be matched/
  );
});
