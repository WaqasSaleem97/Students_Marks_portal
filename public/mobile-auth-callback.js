import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth, GithubAuthProvider, signInWithCredential } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";
import { completeMobileGithubSignIn, githubProfileFromFirebaseUser, GITHUB_PROFILE_CACHE_KEY, mergeGithubProfiles, MOBILE_GITHUB_RESULT_PATH } from "./auth-flow.js";

const title = document.getElementById("mobile-auth-title");
const message = document.getElementById("mobile-auth-message");
const spinner = document.getElementById("mobile-auth-spinner");
const returnLink = document.getElementById("mobile-auth-return");

function cacheGithubProfile(exchange, user) {
  let rawProfile = {};
  try { rawProfile = JSON.parse(exchange.rawUserInfo || "{}"); }
  catch { /* Firebase user data below is enough to continue. */ }
  const profile = mergeGithubProfiles(githubProfileFromFirebaseUser(user), {
    ...rawProfile,
    firebase_uid: user.uid || "",
    login: rawProfile.login || exchange.screenName || ""
  });
  try { sessionStorage.setItem(GITHUB_PROFILE_CACHE_KEY, JSON.stringify(profile)); }
  catch { /* Firebase provider data still permits sign-in. */ }
}

async function finishSignIn() {
  const callbackUrl = window.location.href;
  window.history.replaceState({}, document.title, MOBILE_GITHUB_RESULT_PATH);
  try {
    const exchange = await completeMobileGithubSignIn(firebaseConfig, callbackUrl, window);
    if (!exchange.oauthAccessToken) throw new Error("GitHub did not return the credential needed to sign in. Return to the portal and try again.");
    const auth = getAuth(initializeApp(firebaseConfig));
    const result = await signInWithCredential(auth, GithubAuthProvider.credential(exchange.oauthAccessToken));
    cacheGithubProfile(exchange, result.user);
    window.location.replace("/");
  } catch (error) {
    spinner.hidden = true;
    title.textContent = "GitHub sign-in was not completed";
    message.textContent = error?.message || "Return to the portal and try again.";
    returnLink.hidden = false;
  }
}

finishSignIn();
