# Thread Radio – setup (about 10 minutes, no coding, no Reddit keys)

Everything here works in Chrome on your phone. There is no captcha and no
approval step, so it won't hit the wall the Reddit key page did.

## 1. Put the code on GitHub
1. Make a free account at https://github.com (tap Sign up).
2. Tap the + (top right) → New repository.
3. Name it `thread-radio`, leave everything else as is, tap Create repository.
4. Tap "uploading an existing file" (a link in the middle of the page).
5. Unzip `thread-radio.zip`, then upload everything inside the folder:
   the `api` folder, the `public` folder, `package.json`, `vercel.json`,
   and `SETUP.md`. (On a phone, your Files app can unzip it; then pick the
   files. If it won't let you pick a whole folder, this last step is the one
   bit that's easier on a computer — but it does work on mobile.)
6. Tap Commit changes.

## 2. Put it online with Vercel
1. Go to https://vercel.com and tap Sign up → Continue with GitHub, and allow it.
2. Tap Add New → Project.
3. Find `thread-radio` in the list and tap Import.
4. Tap Deploy. (You do NOT need to add any keys or environment variables.)
5. Wait about a minute. You'll get a link like `thread-radio-xyz.vercel.app`.

## 3. Install on your phone
1. Open that link in Chrome.
2. Tap ⋮ → Add to Home screen (or Install app) → Install.
3. Open it from your home screen and pick a subreddit.

## How to use it
- Type a subreddit (or tap one of the chips) and it loads the posts.
- "Play all titles" reads every title. Tap a post to hear it and its comments.
- The bottom bar has play/pause, skip, and previous. It works with the screen
  off and from your lock screen.
- Settings (top right): pick a voice, change speed, choose how many comments,
  and whether to roll on to the next post automatically.

## Good to know
- It uses Reddit's free public feeds, so no keys and no login.
- It shows no point counts (the free feed doesn't include them).
- The bottom label says "AI voice" or "Backup voice". Backup means the free
  AI voice didn't answer and your phone's own voice took over. Settings →
  "Try the AI voice again" switches back.
- For a better backup voice: install/update "Speech Services by Google" from
  the Play Store and pick a high-quality English voice in Android's
  text-to-speech settings.
- If Reddit ever rate-limits the feed, the app shows a message; wait a minute.
