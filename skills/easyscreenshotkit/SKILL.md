---
name: easyscreenshotkit
description: Take real screenshots of a product's website before you make anything that shows it, such as a launch video, store or Product Hunt images, a deck, a README, a landing page, a social post or the screenshots of a web app manifest. Picks the pages worth showing (home, pricing, features and the like), hides cookie banners and chat bubbles, and saves desktop, phone and whole-page PNGs with a manifest. Also records a short demo video of the site (MP4 and GIF, with a pointer, smooth scrolling and a zoom on clicks), as a tour or from steps you write. Use it whenever the user asks for screenshots or a demo video of a site, or for work that needs the product's real screens, and you know its address.
---

# easyscreenshotkit

Screens an agent draws itself look fake at first glance: a menu the site does not have, a pricing table with made-up plans. easyscreenshotkit opens the real site in a headless browser, picks the pages worth showing, and saves them without the cookie banners and chat bubbles that float over them.

## Take them

```bash
node <skill>/scripts/easyscreenshotkit.js <url> --out screenshots/<name>
```

`<skill>` is this skill's folder. The script needs Node 22 or newer and Chrome, Chromium, Edge or Brave on the machine; it installs nothing and needs no API key. A run takes two or three minutes, up to five on a site with very long pages.

- It takes five pages by default, the home page first. Use `--pages 3` for fewer, and `--page /pricing` (once per page) for pages that must be there.
- A view of a web app with a `#/` or `#!` route is a page of its own: give it as the address or as `--page '/app/#/plants'` (`--page '#/plants'` is that view of the address given, with its query). Its files are named after it (`02-app-plants-desktop.png`). With `--pages 1` the run takes the address and the `--page` ones and nothing else, for example three views of an app for store screenshots; add `--no-clean` for an app's screens, since the clean-up hides an app's own fixed tab bar as it hides a chat bubble. Any other fragment, such as `#pricing` or `#inbox`, is left out with a note; a demo whose steps visit such an address reaches that view.
- By default each page comes as the desktop's first screen at 3200x1800, the phone's at 1080x1920 and the whole desktop page. `--sizes iphone` gives 1320x2868 for App Store frames, `--sizes 1270x760@2` a Product Hunt gallery image, and `mobile-full` the whole phone page.
- `--theme dark` (or `both`) takes the site's own dark theme, `--lang tr` its version in another language; a version the home page names that answers an error or cannot be opened is left out with a note, and the home page is taken in that language.
- `--pwa` also saves screenshots for a web app manifest in `pwa/`: first screens at 1920x1080 and 1080x1920, checked against Chrome's rules for its richer install dialog, with `pwa/manifest-screenshots.json` listing them. `--pwa-check <manifest file, its address or the site's>` checks the screenshots a manifest already has, with no browser.

## Use them

1. Read `screenshots/<name>/SCREENSHOTS.md` before anything else. It lists every page with why it was picked, its files and sizes, and the headings on its first screen.
2. Show `sheet.png` to the user before you build on the screenshots. It has every page on one picture, so they can see at once that the right pages were taken.
3. Use the files as they are. Do not redraw, retype or tidy up the interface, and never invent a screen the site does not have.
4. Headings and sections come with boxes in each image's own pixels (in `manifest.json` and `SCREENSHOTS.md`). Use them to crop or zoom into one part of a page instead of guessing where it is.
5. Whole-page images are long. To show one part, cut the section you need from it; its `sections` say where each one starts and ends.
6. When a page you need is missing, run again with `--page <path>`, or `--page '/app/#/plants'` for a view of an app. `manifest.json` lists the other pages it could have taken (`candidates`) and the ones it left out, with the reason (`skipped`). The tour follows paths only: an app's `#/` and `#!` links on the home page, the address given and each `--page`, and such addresses in the site's sitemap, are in `skipped`, and a `--page` it did not take is named in `notes`, with the reason.
7. For a web app manifest, put `pwa/screenshots` next to the app's manifest and add the entries of `pwa/manifest-screenshots.json` to its `screenshots`. Each label is the main heading on that screen: read them, and change any that does not say what the screen shows. Then run `--pwa-check` on the manifest.

## Record a demo

When the user wants a demo video of the product, a GIF for a README, or footage of the real site for a launch video, record one:

```bash
node <skill>/scripts/easyscreenshotkit.js demo <url> --out demo/<name>
```

It needs ffmpeg on the machine as well. Without steps it takes a tour of the pages worth showing, clicking through the site's own menu; `--pages 3` makes it shorter. A run takes two to four minutes. A tour given less than four minutes with `--timeout` looks for no pages of its own and takes the home page, the address given and each `--page`; short of time as it records, it leaves out what it has no time for, the pages it picked itself first, names each in the notes of `steps.json`, and fails when it cannot show the address given, or has none of the pages asked for to show.

For a flow the user describes (signing up, a search, a feature in use), write the steps to a file and pass `--steps demo.yaml`:

```yaml
url: https://acme.com
steps:
  - visit: /
  - click: "text=Pricing"
  - scroll: { to: "text=Compare plans" }
  - type: ada@example.com
    into: "input[name=email]"
  - key: Enter
  - wait: 1.5
```

The actions are visit, scroll, click, type, key, hover and wait. A target is a CSS selector or `text=` with the words on it; quote a selector that starts with `#`. Use only what is on the public site: a step behind a login fails. A visit opens a view of a web app by its route (`- visit: /app/#/plants`), the address given to the demo keeps its route too, and `steps.json` counts every view shown as a page of its own.

What comes back:

1. `demo.mp4` (1920x1080, H.264), `demo.gif` (made smaller, down to 480 px wide, until it is 8 MB at most; a long or busy demo's can be larger, and the notes say so) and `poster.png`. Show the user the poster or the GIF before you build on the video.
2. `steps.json`: every step's start and end in seconds and in frames, and for a click the frame and the pixel where it lands. Time narration, captions, music cuts and click sounds from it instead of guessing.
3. After a tour, `demo.yaml` holds the steps it took. To change the tour (other pages, a longer pause, one more click), edit that file and record again with `--steps`.

## When it goes wrong

- The page a run starts at gives no screenshots when it answers with a bot check: easyscreenshotkit stops and says so. Ask the user for screenshots instead. A `--page`, or a deeper address given above one page, that answers with one is left out with a note, and the run goes on while it has one of the pages you asked for; when it has none of them, it fails. When you gave another page or a `#/` route and only the home page fails that way, or answers an error or cannot be opened, the home page is left out with a note and the run starts at your address.
- Screens behind a login are not reached. Ask the user for them, or for a public page that shows the same thing.
- If something still covers a page, run again with `--hide '<css selector>'`, which hides what it names with `--no-clean` too. Slow sites can take `--timeout 600`.
- A run that fails or is stopped leaves the screenshots or the demo an earlier run saved in that folder as they were, and adds nothing: a new run replaces them only once it has ended well. A run whose browser is lost or stops answering in the middle of it, or with a file that cannot be saved or comes out cut short on a full disk, counts as one that failed, and so does one that took none of the pages asked for, the address given and each `--page`, as when the address answers an error: check the address, and run again. A run keeps less time for each page asked for when `--timeout` is short, so a short `--timeout` still takes the address given and the pages it has time for, and names the rest in `notes`; give a longer `--timeout` for several pages. One with no time left for the address given fails, and needs a longer `--timeout`.
- An address that answers with a file to download, at once or after a redirect, is refused and nothing is saved, and so is a page that moves on to a file by itself before anything of it is drawn. A page drawn before it does, as one that thanks for a download, is taken as it is drawn, and its notes say the download was refused. A `--page`, and above one page the address given, is left out with that reason in `skipped` and named in `notes`, and a page the tour found is in `skipped`; a demo's tour says so in the notes of `steps.json`. With `--pages 1` the address given stops a screenshot run whatever `--page` asks for, as an address given that is the home page does. A demo's `visit` step to one stops the demo, and so does a click on a link to a page that moves on to a file before anything of it is drawn.
- A run opens the address it is given, and from there only web addresses on the public internet, or that host and port when the address given is on this machine or its network, as a site the user runs locally is; a steps file's `url` is the address given when the command line gives none. A host whose name does not resolve on the machine, or gives no answer in 10 s, is not opened, with the reason "on a host whose name could not be looked up", and an address given on one stops the run before it starts: check the address and the machine's network. A page, a redirect, a sitemap, a step's `visit`, or a manifest and its screenshots at `localhost`, `127.0.0.1`, a private network or another such address is not opened, with the reason "not on the public internet" in `skipped`, the notes or the check's report, and neither is a frame or a window a page opens there. A page that moves on to one before it has loaded, as a local app sends a visitor who has not signed in to its sign-in server, is refused as a redirect there is, and a demo's click on a link to such a page stops the demo, as a `visit` step to one does. The rule is for the pages a run opens and the files it reads itself: a page's own pictures, styles, scripts and the data it fetches are left to the browser's own rules, and on a site the user runs locally they can come from other ports of it. To take a page of a site on the user's machine, give its address itself, not as a page of another site.
- A page that goes to an address of another kind, such as `mailto:`, by itself, by a redirect or by a demo's click, stays where it is, and the notes name the address; one that does so before anything of it is drawn is refused, as one that goes to a file then is: left out as a `--page`, a page of the tour or, above one page, the address given, and with `--pages 1` the address given stops the run, as a demo's visit or click to it stops the demo. A redirect to such an address is never followed. On Linux the browser hands it to no program, as it runs with no display and no session bus to reach; on macOS and Windows it can open the user's mail program, so record such a click there only when the user wants it.
- In the screenshots, a page that moves on by itself to another page once it has loaded, as one that sends the visitor on to a welcome page, is taken as the page it moved to: its address, title and file names are that page's, and its notes name the address it was opened at. A demo's tour checks a page by the address it loaded at: one that moves on by itself to a sign-in page stays in the tour and the video shows the sign-in page, and one that moves on in its first seconds to a page the tour already has, such as the home page, is left out as that page.
- With some versions of Chrome, 155 among them, a click on a `tel:` or `news:` link leaves the tab taking no more clicks or keys: a demo then stops at the next step that clicks, types, presses a key or hovers, and says so. Make such a click the last click or key of the steps, or leave it out.
- A demo step that points at nothing stops the run and names the step. Check the selector or the words against the page, or put a `wait` for it before the step.
- When the demo says ffmpeg is missing, ask the user to install it. When a run says the browser or ffmpeg it found cannot be started, it names the file and what is wrong with it: ask the user to install one that runs, or to point CHROME_PATH or FFMPEG_PATH at one. When it quotes the browser's own words on the kit's pipe, its sandbox, the lock of its profile, its open files or its threads, or what the loader or the shell printed of a browser behind a launcher script, tell the user what the message says to do. When it says ffmpeg gave no answer in two minutes when asked its version or its encoders, as even one that works can on a machine too busy or short of memory, run the demo again, and do not ask the user to install another; when it says time ran out while ffmpeg was asked its version or its encoders, run it again with a longer `--timeout`.
- When it says the browser did not start because the temp folder's path is too long, or was not started because that path has a `:` in it or the temp folder is on a disk that takes no symbolic links, run it again with `TMPDIR=/tmp` in front: an agent's sandbox can set such a temp folder.
- When it says the browser started but did not answer, did not open a window, did not take the order that holds its pages to the run's addresses, stopped answering or took too long to draw the demo's frames, or that a page gave no answer in time, the machine or the site was too slow: run it again, with a longer `--timeout` when the message asks for one.
- Never present a screenshot as the product's own when it did not come from easyscreenshotkit or from the user.
