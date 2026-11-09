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
- A view of a web app with a `#/` or `#!` route is a page of its own: give it as the address or as `--page '/app/#/plants'` (`--page '#/plants'` is that view of the address given). Its files are named after it (`02-app-plants-desktop.png`). With `--pages 1` the run takes the address and the `--page` ones and nothing else, for example three views of an app for store screenshots; add `--no-clean` for an app's screens, since the clean-up hides an app's own fixed tab bar as it hides a chat bubble. Any other fragment, such as `#pricing` or `#inbox`, is left out with a note; a demo whose steps visit such an address reaches that view.
- By default each page comes as the desktop's first screen at 3200x1800, the phone's at 1080x1920 and the whole desktop page. `--sizes iphone` gives 1320x2868 for App Store frames, `--sizes 1270x760@2` a Product Hunt gallery image, and `mobile-full` the whole phone page.
- `--theme dark` (or `both`) takes the site's own dark theme, `--lang tr` its version in another language.
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

It needs ffmpeg on the machine as well. Without steps it takes a tour of the pages the screenshots would take, clicking through the site's own menu; `--pages 3` makes it shorter. A run takes two to four minutes.

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

1. `demo.mp4` (1920x1080, H.264), `demo.gif` (8 MB at most) and `poster.png`. Show the user the poster or the GIF before you build on the video.
2. `steps.json`: every step's start and end in seconds and in frames, and for a click the frame and the pixel where it lands. Time narration, captions, music cuts and click sounds from it instead of guessing.
3. After a tour, `demo.yaml` holds the steps it took. To change the tour (other pages, a longer pause, one more click), edit that file and record again with `--steps`.

## When it goes wrong

- A site that answers with a bot check gives no screenshots: easyscreenshotkit stops and says so. Ask the user for screenshots instead.
- Screens behind a login are not reached. Ask the user for them, or for a public page that shows the same thing.
- If something still covers a page, run again with `--hide '<css selector>'`. Slow sites can take `--timeout 600`.
- A run that fails or is stopped leaves the screenshots or the demo an earlier run saved in that folder as they were, and adds nothing: a new run replaces them only once it has ended well. A run whose browser is lost in the middle of it, or with a file that cannot be saved or comes out cut short on a full disk, counts as one that failed.
- An address that answers with a file to download, at once or after a redirect, is refused and nothing is saved. A `--page`, and above one page the address given, is left out with that reason in `skipped` and named in `notes`, and a page the tour found is in `skipped`; a demo's tour says so in the notes of `steps.json`. With `--pages 1` the address given stops a screenshot run whatever `--page` asks for, as a home page that is a file always does. A demo's `visit` step to one stops the demo.
- A demo step that points at nothing stops the run and names the step. Check the selector or the words against the page, or put a `wait` for it before the step.
- When the demo says ffmpeg is missing, ask the user to install it.
- When it says the browser did not start because the temp folder's path is too long, run it again with `TMPDIR=/tmp` in front: an agent's sandbox can set a long one.
- Never present a screenshot as the product's own when it did not come from easyscreenshotkit or from the user.
