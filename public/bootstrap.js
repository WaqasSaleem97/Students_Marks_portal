import { firebaseConfig } from "./firebase-config.js";
import { canonicalAuthUrl } from "./auth-flow.js";

const authUrl = canonicalAuthUrl(window.location.href, firebaseConfig);

if (authUrl) window.location.replace(authUrl);
else import("./app.js");
