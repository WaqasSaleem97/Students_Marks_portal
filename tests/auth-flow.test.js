import test from "node:test";
import assert from "node:assert/strict";
import { canonicalAuthUrl } from "../public/auth-flow.js";

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
