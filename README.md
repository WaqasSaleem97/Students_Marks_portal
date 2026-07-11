# Firebase GitHub Login App

This static web app allows signup/sign-in only through GitHub. On the first successful login it creates `users/{firebaseUid}` in Cloud Firestore and stores `first_name`, `last_name`, `user_name`, `email`, `photo_url`, `github_id`, and `created_at`.

## Files

- `public/index.html` — page structure
- `public/styles.css` — page design
- `public/app.js` — GitHub authentication and Firestore logic
- `public/firebase-config.js` — your Firebase Web App configuration
- `firestore.rules` — user-profile database security
- `firebase.json` — Hosting and Firestore deployment configuration
- `.firebaserc.example` — Firebase project-ID template

## Firebase setup

1. Create a Firebase project and add a Web App.
2. Create a Cloud Firestore database.
3. Open **Authentication > Sign-in method**, enable **GitHub**, and copy the Firebase authorization callback URL shown there.
4. In GitHub, open **Settings > Developer settings > OAuth Apps > New OAuth App**. Use your Firebase Hosting URL as the homepage and paste Firebase's callback URL into **Authorization callback URL**.
5. Copy the GitHub OAuth App Client ID and Client Secret into the GitHub provider settings in Firebase Authentication.
6. Copy the Firebase Web App configuration into `public/firebase-config.js`.
7. Copy `.firebaserc.example` to `.firebaserc` and replace `YOUR_PROJECT_ID`.
8. In Firebase Authentication **Settings > Authorized domains**, confirm your `PROJECT_ID.web.app` domain is present. Add your custom domain if you use one.

## Deploy

Install the Firebase CLI and log in:

```bash
npm install -g firebase-tools
firebase login
```

From this project directory, deploy Hosting and the Firestore rules:

```bash
firebase deploy --only hosting,firestore:rules
```

If uploading files through a web interface instead of the CLI, upload the contents of the `public` directory as the website files. You must still publish `firestore.rules` separately in **Firestore Database > Rules**.

## Important name behavior

GitHub supplies one optional full-name string. This app treats the first word as `first_name` and all remaining words as `last_name`. A user who has not provided a public GitHub name will have empty name fields. The profile is created only once and is not overwritten on later sign-ins.
