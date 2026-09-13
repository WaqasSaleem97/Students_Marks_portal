import test from "node:test";
import assert from "node:assert/strict";
import { canonicalAuthUrl, shouldUseRedirectSignIn } from "../public/auth-flow.js";

const config = {
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

test("desktop browsers use a popup while mobile browsers use a redirect", () => {
  assert.equal(shouldUseRedirectSignIn({userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36 Edg/140"}), false);
  assert.equal(shouldUseRedirectSignIn({userAgent: "Mozilla/5.0 (Android 16; Mobile) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36"}), true);
  assert.equal(shouldUseRedirectSignIn({userAgentData: {mobile: true}, userAgent: "Chromium"}), true);
  assert.equal(shouldUseRedirectSignIn({platform: "MacIntel", maxTouchPoints: 5, userAgent: "Mozilla/5.0 (Macintosh)"}), true);
});
