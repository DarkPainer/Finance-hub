# Finance Hub: setup

You do this once on a computer (about 30 minutes). After that, everything happens on your phone.

## 1. Database (Supabase, free)
1. Sign up at https://supabase.com and create a new project. Pick region **Central EU (Frankfurt)** and save the database password somewhere safe.
2. Open **SQL Editor** → New query. Paste the whole of `schema.sql` and click **Run**.
3. Go to **Authentication → Sign In / Providers → Email** and turn **off** "Confirm email".
4. Open the **Connect** button at the top of the project, or **Project Settings → API Keys**. Copy the **Project URL** and the **publishable key** (the legacy *anon* key also works). Both are safe to put in the app. Never use the *secret* / *service_role* key.

## 2. Hosting (GitHub Pages, free)
In the repository, go to Settings → Pages → Build and deployment. Set Source to **Deploy from a branch**, choose branch **main** and folder **/ (root)**, then click Save. The app is at `https://<your-github-name>.github.io/<repository>/`.

## 3. On your OnePlus
1. Open `https://<your-github-name>.github.io/<repository>/` in **Chrome**.
2. Paste the Project URL and key, then tap **Create account** and choose an email and password.
3. In Chrome's ⋮ menu, tap **Add to Home screen → Install**. Finance Hub now opens full-screen from its own icon.

## 4. Lock it down
In Supabase, go to **Authentication → Sign In / Providers** and turn **off** "Allow new users to sign up". Your account keeps working, and nobody else can create one.

## Updating the app later
Push to `main`. GitHub Pages republishes within about a minute, and the phone picks up the new version the next time the app is opened with internet.

## Files
- `index.html`: the app
- `sw.js`, `manifest.webmanifest`, `icons/`: make it installable and usable offline
- `supabase.js`: database client (v2.118, stored locally so the app also loads offline)
- `investing.html`, `invest-core.js`, `hub-store.js`, `chart.umd.js`: the investing screen (moved from the old Investing Dashboard). Holdings, trades and API keys are stored in your Supabase `hub` table, never in this repository.
- `schema.sql`: the database tables. Row-level security means only your account can read or change your data.
