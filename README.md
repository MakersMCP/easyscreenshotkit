# easyscreenshotkit

Give it a website. It picks the pages worth showing, hides the cookie banners and chat bubbles, and saves desktop, phone and full-page screenshots your coding agent can use. It can also [record a demo](#record-a-demo) of the site.

```bash
npx easyscreenshotkit@latest linear.app
```

![The pages easyscreenshotkit picked on linear.app](.github/assets/linear-sheet.jpg)

A launch video, a Product Hunt gallery, a pitch deck or a README needs the product's real screens. Taking them by hand means opening each page, closing the cookie banner, waiting for the pictures, scrolling down and doing it all again on a phone, and an agent asked to do it either guesses the pages or draws the interface itself. easyscreenshotkit reads the site's own menu, picks the pages a visitor would look at first (pricing, features, how it works), and saves each one clean, with a manifest that tells your agent what is in every file.

## Requirements

- Node.js 22 or newer.
- Google Chrome, Chromium, Edge or Brave, which opens the site, takes the screenshots and records a demo; `--pwa-check` starts none. It has been tested with Chrome 155 on Ubuntu 26.04, Chrome 157 on Ubuntu 22.04 and the Google Chrome that GitHub's Ubuntu runners come with, and not with Chromium, Edge or Brave. easyscreenshotkit looks for it on your PATH on Linux and where macOS and Windows install it; on Windows it finds Chrome and Edge only. Set `CHROME_PATH` to use another build, as a path or a name on PATH. The browser takes its pipe to easyscreenshotkit on its file descriptors 3 and 4, so a program that `CHROME_PATH` names and that starts the browser has to hand those on. Chrome runs in its sandbox unless easyscreenshotkit runs as root, where the sandbox does not start: on Linux, Google Chrome's own package sets the sandbox up, and a container has to let it start, as Docker does with `--security-opt seccomp=unconfined`. A browser that is not there or cannot be started, as a folder, a file without the permission to run it, an empty or a text file, one that needs a library the machine lacks or one made for another system, stops a run before it opens the site, with its path, what is wrong with it and how to get one that runs; behind a launcher script, as `google-chrome` is on Linux, the run says what the loader or the shell printed of a program the script starts that needs a library the machine lacks or is made for another system, and what to do. Of a program whose loader the machine lacks, as one built for another libc, bash 5.2 and later print "cannot execute: required file not found", which the run quotes, while an older bash, as Ubuntu 22.04's, and dash print only that the file is not there, and the run then says only that the browser did not start. One that ends as it starts and prints that it was not handed the pipe, that its sandbox could not start, that it could not make the lock of its profile, that it had too many files open or that it could start no more threads stops the run too, quoting that line and saying what to do. When the system will not start the browser, or ffmpeg as a demo asks its version, for want of open files, processes or memory, the run says so and what to do; a browser that starts and then ends for want of memory says nothing of it, and the run says only that it did not start.
- ffmpeg 4.4 or newer for a demo, Ubuntu 22.04's 4.4.2 included, with an H.264 encoder: libx264, the one every test has used and the one Ubuntu's ffmpeg has, or VideoToolbox, OpenH264 or Media Foundation, which no test has run with. The screenshots need no ffmpeg, and a demo needs no ffprobe. The filters it uses are ffmpeg's own. `brew install ffmpeg` and `winget install ffmpeg` give a new enough one, and so does `sudo apt install ffmpeg` on Ubuntu 22.04, Debian 12 or newer. Set `FFMPEG_PATH` to use another build, as a path or a name on PATH. A demo asks ffmpeg for its version before it opens the site, and holds it to no version: one that is not there, cannot be started, is no ffmpeg or has no H.264 encoder stops the demo then, with what is wrong with it. One that gives no answer in two minutes when asked its version or its encoders, as even one that works can on a machine too busy or short of memory, stops the demo too, and the message says to run it again. Those waits are part of the time `--timeout` gives the demo: when that time runs out first, the demo stops with "time ran out while ffmpeg was asked its version" (or its encoders) and asks for more.
- Linux, where it is tested: on Ubuntu 22.04 with its ffmpeg 4.4.2, on Ubuntu 24.04 with its ffmpeg 6.1 and on GitHub's ubuntu-latest runner, on every push and before every release. This release has also run on Ubuntu 26.04 with ffmpeg 8.0. It is written for macOS and Windows as well, but this release has not been run on either.
- Room on the disk for the files of a run and those of the run before it, as the earlier files stay until the new ones are in place, and in the temp folder for the browser's profile. A demo keeps the frames it records in the folder it saves in until it ends, about 2 MB for each second of the video: a 13 s tour of four pages took 28 MB at most.
- On Linux and macOS, a temp folder on a disk that takes symbolic links, as the browser's profile there needs them, with a path that leaves the browser room for the socket it opens there, about 60 characters at most, and on Linux no `:` in it. `TMPDIR=/tmp` in front of the command fixes the path; for the links, point `TMPDIR` at a folder on another disk.
- Network access to the site, and a lookup of its host's name on your machine: a host whose name does not resolve there is not opened, also behind a proxy that would look it up for the browser. Installing it needs the network, and `npx easyscreenshotkit@latest` asks npm for the newest version each time it runs. No account, no API key and no npm dependencies.

## What you get

```
easyscreenshotkit-linear.app/
  SCREENSHOTS.md          every page: why it was picked, its files, the headings on its first screen
  manifest.json           the same, for scripts
  sheet.png               all pages on one picture, like the one above
  01-home-desktop.png     the first screen at 2x, 3200x1800
  01-home-mobile.png      the first screen on a phone, 1080x1920
  01-home-full.png        the whole page, 1600 wide
  02-pricing-desktop.png  and the same for every other page it picked
```

- Pages are picked from the home page's own menu, its big buttons and its footer, with the sitemap as a fallback. Each one says why it was picked, for example `menu link "Pricing"`.
- Sign-in pages, the site's app and account pages (/app/, /dashboard/, /account/), legal pages, careers, single blog posts and pages in another language are left out, and so is anything the site's robots.txt asks crawlers to stay out of. A page that only redirects to a sign-in page or to the home page, a bot check, and a second address for a page already taken are dropped too. The pages it left out are listed with the reason.
- Cookie and consent banners, chat bubbles, promo boxes and modal backdrops are hidden, never clicked: pressing "Accept" would give consent for you.
- Pictures that load late, sections that fade in on scroll, counters that count up and videos are there in full, on the first screen and on the whole page.
- Every heading on a first screen comes with its box in the image's own pixels, and every section of a whole page with where it starts and ends, so a crop or a zoom does not have to guess.
- Each PNG carries the address it came from, when it was taken and by what, in its own metadata.
- A view of a web app, such as `/app/#/plants`, is taken when you give its `#/` or `#!` route, once its data has come, and its files are named after it: see [Views of a web app](#views-of-a-web-app).

## Views of a web app

A view of a single page app is taken when you give its `#/` or `#!` route as the address, `easyscreenshotkit 'yourapp.com/app/#/plants'`, or with `--page '/app/#/plants'`. A `--page` that is only a route, such as `--page '#/plants'`, is that view of the address given, with its query, and a `--page` with a query and a route keeps both. Any other fragment, such as `#pricing`, is a place on the page: it is left out, with a note.

The page opens on that view and waits in each window it is taken in until the view's data has come and it shows no loading sign: 10 s at most in the first window, and 2 s in each other one when it was not ready in the first. Its windows are taken one after another, with no other page loading meanwhile. A loading sign is something marked `aria-busy`, a progress bar with no value, or a heading or a line of its own that says Loading, such as `Loading…` or `Loading your plants...`. `Loading states` is not one, and neither is the word alone in a link, in a heading made of such a link, or in one column of a table.

When a view was not ready by the end of its wait, or the run's time cut the wait short, a note on the page says so, with the size when it was not the first window, and `--pwa` leaves that window's capture out.

A view with a request still out counts as not ready too when it looks empty: when the wait for a page's content took it for a loading screen (no link, no picture, nothing below the first screen), or when, outside its menus and bars, it has no heading, no picture 100 px wide and high or more, and fewer than 20 characters other than spaces (a Chinese, Japanese or Korean character counts as two), as a spinner beside a link has. A view that looks drawn with a request still open, as a long poll keeps one, is kept, and its note says the request was still open.

Its files are named after the view: `02-app-plants-desktop.png` for `/app/#/plants`. A file name keeps the letters a to z and the digits. An accented letter loses its accent, so `#/café` gives `app-cafe`, and a route with letters a file name cannot keep that way, such as Cyrillic or ß, gets `view-` and six characters of its own, the same on every run: `app-view-805ad3` for `#/растения`, `app-plant-view-b9f99e` for `#/plant/Фикус`.

The tour follows paths only: a link to `/docs/#/install` offers it `/docs/`. The `#/` and `#!` links on the home page, on the address given and on each `--page`, and the `#/` and `#!` addresses the site's sitemap lists, are listed with the pages it left out, so you can give them with `--page`.

## Record a demo

`easyscreenshotkit demo` records a short video of the site instead: a tour of the pages worth showing, or the steps you write down.

```bash
npx easyscreenshotkit@latest demo cal.com
```

![A demo easyscreenshotkit recorded of cal.com](.github/assets/cal-demo.gif)

The page plays in a browser window on a backdrop, with a pointer that moves the way a hand would, smooth scrolling and a zoom on every click. Cookie banners and chat bubbles are hidden as they are for the screenshots, never clicked away.

```
easyscreenshotkit-demo-cal.com/
  demo.mp4     1920x1080, H.264, 30 frames a second
  demo.gif     the same, made smaller for a README
  poster.png   the first page at rest, for the video's cover
  steps.json   every step with where it starts and ends, in seconds and in frames
  demo.yaml    the tour as steps, to edit and record again
```

The GIF is made smaller, down to 480 px wide at 8 frames a second, until it is 8 MB at most. A long or busy demo's GIF can be larger even then, and the notes in steps.json say so.

A demo saves in its folder the same way as the screenshots: an earlier demo there stays as it was until a new one has ended well, and a demo that fails or is stopped adds nothing. A demo that loses its browser or its tab while it records fails too, as does one whose browser stops answering, and so does one whose video or GIF comes out cut short, as on a full disk: some versions of ffmpeg report success for a file they could not finish, so each file is read back before it replaces the earlier one.

`steps.json` is there for what goes on top of the video later, such as narration, music, captions or a click sound: each step has its label and its start and end, and a click also has the frame it lands on and the point in the video where it lands. Its `pages` list every page the video shows with its start and end; a view of a web app reached by its `#/` or `#!` route, by a visit or a click, is a page of its own there. The page shown last stays on camera for a second at least, as a tour's pages do, also when the last step opened it.

To record a flow of your own, write it down and pass it with `--steps`:

```yaml
url: https://acme.com
steps:
  - visit: /pricing
  - wait: 1
  - scroll: { to: "text=Compare plans" }
  - click: "text=Start free"
  - type: ada@example.com
    into: "input[name=email]"
  - key: Enter
  - wait: "text=Check your inbox"
```

```bash
npx easyscreenshotkit@latest demo --steps demo.yaml
```

| Step | What it does |
| --- | --- |
| `visit: /pricing` | opens a page of the site, or another web address on the public internet (see [Use it from the command line](#use-it-from-the-command-line)); `visit: /app/#/plants` opens that view of a web app |
| `scroll: 800` | scrolls down 800 px, or up with a negative number; also `top`, `bottom`, a target, or `{ to: <target>, duration: 2 }` |
| `click: <target>` | moves the pointer there and clicks, zoomed in; add `zoom: false` or `zoom: 2` to the step to change that |
| `type: <text>` | types into the field in focus, or clicks `into: <target>` first |
| `key: Enter` | presses a key or a combination such as `Meta+K`, and shows it on screen |
| `hover: <target>` | moves the pointer there and rests |
| `wait: 1.5` | holds for that many seconds; `wait: <target>` waits until it shows up |

A target is a CSS selector such as `"#signup"`, or the words on it such as `"text=Start free"`. Put a selector that starts with `#` in quotes, or YAML reads it as a comment. A step can also carry a `label`, which steps.json uses, and a `note` for whoever writes the narration. A JSON file of the same shape works too.

Some versions of Chrome, 155 among them, take no more clicks or keys in a tab once a page of it has tried to open `tel:` or `news:`, as a click on such a link does. A demo then stops at the next step that clicks, types, presses a key or hovers, and says so: make such a click the last click or key of the steps, or leave it out.

The demo needs ffmpeg, the one on your machine (`brew install ffmpeg`, `sudo apt install ffmpeg` or `winget install ffmpeg`). `npx easyscreenshotkit@latest demo --help` lists every option; these are the main ones:

```
  --steps <file>      follow the steps in this YAML or JSON file instead of a tour
  --pages <n>         pages in the tour, the home page included (default: 4, at most 8)
  --page <path>       take this page in the tour, e.g. --page /pricing, or a
                      view of an app such as '/app/#/plants'
  --zoom <n>          how far a click zooms in, 1 to 2.5 (default: 1.5); --no-zoom for none
  --background <bg>   behind the window: a colour, two colours for a gradient, or a picture
  --no-frame          the page alone, filling the video
  --fps <n>           frames a second, 24 to 60 (default: 30)
  --no-gif            skip demo.gif
```

`--out`, `--lang`, `--hide`, `--reduced-motion`, `--no-clean` and `--json` work as they do for screenshots. A demo's `--theme` takes light or dark, and `--timeout` gives a demo 900 seconds by default.

A `--background` colour is one the browser knows: a name such as `slategray`, or a `#hex`, `rgb()` or `hsl()` value. A word it does not read as a colour, as `charcoal` or `inherit`, a file that is no picture it can draw, and a picture cut short are refused before anything is recorded, and an earlier demo in the folder stays as it was.

How a demo is made:

1. A tour picks its pages as the screenshots do: the home page, then features, pricing and the like, each opened first to check it. It checks a page by the address it loaded at, so one that moves on by itself to a sign-in page stays in the tour and the video shows the sign-in page, where the screenshots leave it out, and one that moves on in its first seconds to a page the tour already has, such as the home page, is left out as that page. On each page it rests on the first screen, scrolls down to a section or two, and goes on to the next page through the link in the site's own menu, or with a crossfade when the menu has none. Pricing comes last. It follows paths only: the notes in steps.json name the `#/` and `#!` links it finds on the home page, on the address given and on each `--page`, and the `#/` and `#!` addresses the site's sitemap lists, which `--page` can add.
2. Every page loads off camera. The recording pauses while the page opens, scrolls through it once so lazy pictures load, hides what floats over it and waits for its fonts and pictures. Then it comes in with a crossfade.
3. Chrome draws the page at 1.5 pixels per CSS pixel, so a zoomed-in view stays sharp, and streams its screen. A scroll is taken a frame at a time, the page moved to exactly where each frame of the video needs it, so it is even however slowly the machine draws. A page that draws slowly is recorded in slow motion and played back at speed.
4. The pointer, the zoom, the rings around clicks and the window are not drawn into the page. They are added afterwards from what was recorded, every frame drawn in a second browser window, and ffmpeg encodes the result.

A tour fits the time `--timeout` gives it. It looks for pages of its own only while more than four minutes of the run are left, so a shorter one takes the home page, the address given and each `--page`, and a note in steps.json says it looked for no more.

As it records, it keeps the last minute of the run, or a quarter of a run under four minutes, as a demo from a steps file does before each step, and goes on to a page only while the time left over would take a page as long as the longest one so far. Short of time, it leaves out the scrolls, then the pages it picked itself, so that the address given and each `--page` are shown, and steps.json names every page it left out. A tour that has no time to show the address given fails, and so does one that has none of the pages you asked for, the address given and each `--page`, to show, as when the address answers an error: it does not take the place of an earlier demo with the home page and the pages it picked itself.

## Use it with your agent

easyscreenshotkit ships as an [Agent Skill](https://agentskills.io). Install it once and your agent runs it by itself when it needs a product's real screens:

```bash
npx skills add EminBudak/easyscreenshotkit
```

That covers Claude Code, Codex, Cursor and the other agents the [`skills`](https://github.com/vercel-labs/skills) CLI supports. In Claude Code you can add it as a plugin instead:

```
/plugin marketplace add EminBudak/easyscreenshotkit
/plugin install easyscreenshotkit@easyscreenshotkit
```

In GitHub Copilot CLI it takes the same two steps:

```bash
copilot plugin marketplace add EminBudak/easyscreenshotkit
copilot plugin install easyscreenshotkit@easyscreenshotkit
```

Then ask as usual:

> Make Product Hunt gallery images for cal.com

> Record a short demo of cal.com for the README

The skill carries its own script, so it installs nothing else and needs no API key.

## Use it from the command line

```
npx easyscreenshotkit@latest <url> [options]

  --out <dir>       where to save (default: ./easyscreenshotkit-<host>)
  --pages <n>       how many pages, the home page included (default: 5, at
                    most 12); each --page is taken even past it
  --page <path>     take this page too, e.g. --page /pricing, or a view of an
                    app such as '/app/#/plants' (repeat for more)
  --sizes <list>    desktop, mobile, iphone, full, mobile-full or WxH, each with
                    an optional @scale (default: desktop,mobile,full)
  --theme <name>    light, dark or both (default: light)
  --lang <code>     the site's version in this language, when it has one
  --hide <css>      hide one more element (repeat for more)
  --reduced-motion  ask the site for its reduced-motion version
  --no-clean        take the pages as they come, banners and bubbles included;
                    --hide still hides what it names
  --pwa             also save screenshots for a web app manifest, in pwa/
  --pwa-check <m>   check the screenshots of a web app manifest instead: give
                    the manifest's file or address, or the site's address
  --json            print manifest.json instead of a summary
  --timeout <s>     give up after this many seconds (default: 300)
```

| Size | Window | Image | For |
| --- | --- | --- | --- |
| `desktop` | 1600x900 at 2x | 3200x1800 | slides, videos, README images; 16:9 |
| `mobile` | 360x640 at 3x | 1080x1920 | vertical video, Google Play; 9:16 |
| `iphone` | 440x956 at 3x | 1320x2868 | App Store frames (6.9") |
| `full` | the desktop's width at 1x | 1600 wide | the whole page, top to bottom |
| `mobile-full` | 360 wide at 2x | 720 wide | the whole phone page |
| `WxH@scale` | your own | | e.g. `1270x760@2` for a Product Hunt gallery, `1920x1080@1` for directory listings |

The phone sizes open the page as that phone's browser would, so a site that picks its mobile layout by the browser sends it. A whole page stops at 15,000 CSS pixels.

With `--lang tr` every window asks the site for Turkish, and above one page, when the home page names its Turkish version (`<link rel="alternate" hreflang="tr" href="/tr/">`), the run starts at that version. One that answers an error or a bot check, or cannot be opened, as a link left to a version that is gone, is left out with a note, and the home page is taken as it came, in the language asked for. A demo's tour does the same.

Some runs:

```bash
npx easyscreenshotkit@latest stripe.com --pages 3 --sizes desktop
npx easyscreenshotkit@latest cal.com --page /pricing --sizes 1270x760@2 --out gallery
npx easyscreenshotkit@latest yourapp.com --sizes iphone,mobile --theme both --out store
npx easyscreenshotkit@latest 'yourapp.com/app/#/today' --pages 1 --page '/app/#/plants' --page '/app/#/settings' --sizes iphone,mobile --no-clean --out store
```

The last one takes three views of a web app and nothing else: with `--pages 1` there is no tour, only the address and the `--page` ones. `--no-clean` keeps the app's own tab bar at the bottom of a phone's screen, which the clean-up would hide: it hides everything fixed to the screen but a bar along the top or down one side. With `--no-clean`, `--hide` still hides what it names, and SCREENSHOTS.md says the pages are as they came.

The folder a run saves in has to be new, empty or hold an earlier run; the `.DS_Store`, `Thumbs.db` or `desktop.ini` a file browser leaves there does not count. It is looked at again when the run ends: if the folder by then holds something else and no earlier run of this kind, such as another tool's manifest or a demo where screenshots were going, the run fails and adds nothing. Two runs that end at the same moment in one folder take turns, and the files of the one that ends later replace the other's.

A run builds its files in a folder whose name starts with `.easyscreenshotkit-part-`, inside the folder it saves in, and moves them into place only once it has ended well, replacing the earlier run's files. A run that fails, or is stopped with Ctrl-C or a TERM signal, leaves the earlier run's files as they were and adds nothing. So does a run whose browser ends or stops answering in the middle of it, or with a picture that cannot be saved or comes out cut short, as on a full disk: each picture is read back before it takes the place of an earlier one. So does a run that takes none of the pages you asked for, the address you gave and each `--page`, as when the address answers an error: it does not put the home page and the pages it picked itself in the place of an earlier run.

A run keeps part of its time for each page you asked for and for each window it opens: 45 s and 30 s of a run given 135 s or more, and less in a shorter one, in step with its `--timeout`, as 10 s and 7 s of a run given 30 s. So a short run takes the address given first, then each `--page` while that share of its time is left, and names in its notes each one it had no time for. A run with no time left for the address given fails, as a demo's tour does.

A run killed outright, with `kill -9` or with `taskkill /F` on Windows, cannot clean up after itself. It leaves its part folder, which the next run to end well in that folder removes once it is half an hour old, and its browser's profile in the temp folder. Its browser, and a demo's ffmpeg, end by themselves once the kill has closed the pipes the run drives them through, as they did within a second on Linux.

On Linux the browser keeps its lock in its profile; on macOS, and on Linux when the temp folder's path is over 30 characters, the lock folder of a browser killed that way is left in the temp folder too (`com.google.Chrome.XXXXXX` and the like). Where the lock is not in the profile, and on Windows, so can a folder the browser makes there in its first seconds for what it downloads for itself, with `chrome_url_fetcher_` in its name. A run that fails or is stopped in those seconds removes that folder itself, with what the browser had put in it.

Installed globally (`npm install -g easyscreenshotkit`), the command is `easyscreenshotkit`. npx keeps the copy an earlier run fetched, so `npx easyscreenshotkit@latest` is how you get a newer version.

easyscreenshotkit drives the browser you already have over the Chrome DevTools Protocol, with a throwaway profile, and downloads nothing (see [Requirements](#requirements)). It talks to the browser over a pipe, so the browser opens no port on your machine that another program could use to read or drive its pages. On Linux the browser keeps its crash reports in that profile too, not in the folder of your own browser of its kind.

On Linux, no page makes that browser start a program of your machine. There the browser asks `xdg-settings` which program opens an address of another kind, such as `mailto:`, then hands the address without asking to your desktop's portal over the session bus, or with no portal to `xdg-email` or `xdg-open`, and it starts each of those programs through PATH. That would open your mail program with what the site wrote in the address. So the run starts the browser with no display, X11's or Wayland's, for itself or for what it starts, and with a session bus where nothing listens, and puts programs of those names first on its PATH, in its profile: links to `true`, which start nothing, and for `xdg-settings` and `xdg-mime` links to `false`, which find no program. A browser that cannot be kept from them, as in a temp folder whose path has a `:` in it, is not started. On macOS and Windows the browser hands `mailto:`, `news:` and `snews:` to the system, and the kit has no way to stop that there: a page that goes to one can open your mail program, and its note says the browser may have handed the address to a program of the machine. This release has not been run on either.

An address of another kind, such as `mailto:` or `news:`, is no page to open: a page that goes to one, by itself, by a redirect or by a demo's click, stays where it is, and its notes or steps.json name the address. A redirect to one is not followed, on any system. One that goes to one before anything of it is drawn, as one whose head sends the browser on, is refused as one that goes to a file then is: a `--page`, a page of the tour and, above one page, the address given are left out, the address given with `--pages 1` stops the run, and a demo's visit or click to it stops the demo. So is an address that redirects to one, except that a demo's click on a link to it leaves the page where it is, with a note.

That browser refuses every download a page starts, such as a link or a redirect to a file, so a site cannot save a file on your machine. On Linux, Chrome still writes what such an address sends to a temporary file in your Downloads folder, or in the temp folder when there is none, and removes it within a fraction of a second as it refuses the download. A browser killed in that moment, as `kill -9` kills it, can leave that file there, and now and then Chrome leaves one there empty; its name is `.com.google.Chrome.` and six characters.

An address that answers with a file, at once or after a redirect, is refused as well and named in the report: a `--page`, a page of the tour and, above one page, the address given are left out and the run goes on, as long as it has taken the address given or a `--page`. So is a page that moves on to a file by itself before anything of it is drawn, as one whose head sends the browser on does. One drawn before it moves on to a file, as a page that thanks you for a download and sends the browser to the file as its body is read, is taken as it is drawn by then, and so is one that starts a download through a link with a `download` attribute, or once it has loaded; its notes say the browser refused the download and saved nothing. With `--pages 1` the address given is opened first and the run stops over it, whatever `--page` asks for, as it does over an address given that is the home page. A demo's `visit` step to an address that answers with a file stops the demo, and so do a visit and a click to a page that moves on to a file before anything of it is drawn. A click on a link that answers with a file leaves the page where it is, and a visit or a click to a page drawn before it moves on to one shows it as it is drawn, each with a note in steps.json.

A run opens the address you give it, and from there only web addresses on the public internet. A steps file's `url` is the address given when the command line gives none. It is opened whatever host it is on, as the one on the command line is, and a fragment that is not a #route is left out of it, with a note. The rule holds for every page the run's browser loads from there: the pages of its tour, each `--page`, a page's version in another language, a demo's `visit` steps and the links it clicks, every redirect, a page or a frame in it that moves on, a frame of another site included, and a window a page opens. It holds too for what the kit reads itself: robots.txt and the sitemaps it names, and for `--pwa` and `--pwa-check` the manifest a page links and its screenshots. So no page, link, redirect or manifest of a site, and no step of a steps file, takes the run to your machine or your network: `localhost`, `127.0.0.1`, `192.168.1.1` and any other address that is not on the public internet, a host name that leads to one included. Nor does it open an address that is no web address, such as a page's version in another language at `file://localhost/...`.

When the address you give is itself one of those, as a site you run on your machine is, the run opens that host and port too, and no other such address: `localhost:3000` and `localhost:3001`, or `localhost` and `127.0.0.1`, are not one site to it.

What it does not open is named with the reason, "not on the public internet": a page left out is listed in the report, a sitemap not read and a page's version in another language not taken are in its notes, the manifest not read is in the summary, and a demo's `visit` step to one stops the demo. A page that moves on to one before it has loaded, as a local app sends a visitor who has not signed in to its sign-in server, is refused as a redirect to it is, and a demo's click on a link to such a page stops the demo, as a `visit` step to it does. A page that tries to once it has loaded, by a click or by itself, stays where it is, with a note, and a frame or a window it tries to open there is not loaded, with a note too; a frame inside a frame of another site is not loaded either, but it can go without a note. From a manifest file `--pwa-check` reads no screenshot at such an address.

The rule is for the pages the run opens and the files the kit reads itself. What a page asks for itself, its pictures, styles, scripts and the data it fetches, and the manifest the browser reads for itself, are left to the browser's own rules: on a site you run on your machine, they can come from other ports of it. A host name is judged by what it resolves to on your machine as the run looks it up, and the files the kit reads go to that address; the browser looks the name up again as it opens a page, and an answer that differs by then is the browser's. A name that does not resolve on your machine, or gives no answer in 10 s, is not opened either, with the reason "on a host whose name could not be looked up", and an address you give on such a host stops the run before it starts: left to the browser's own lookup, a DNS server that failed the run's question could answer the browser's with your machine.

On Linux and macOS the browser opens a socket in the temp folder and does not start when the temp folder's path is too long for one, over about 60 characters; the run says so, and `TMPDIR=/tmp` fixes it.

On a busy machine the browser can be slow: it gets up to a minute to answer once it has started, to open each window, with the order that holds its pages to the addresses the run opens, and for each page to answer, as far as `--timeout` leaves time. When one of them runs out, a run that cannot go on says which and what to do, and a page or window it leaves out over it is named in the report with the reason; the next window asks the browser again. When a call to the browser, the opening of a window included, has kept the run waiting 15 s, the browser is asked for its version, which a running browser answers at once. One that gives no answer to that in 10 s has stopped answering, as one that hangs does: the run ends it and fails, leaving the earlier run's files as they were. A demo whose browser still answers but takes over 30 s to draw one of the video's frames fails too, and says the machine may be too busy.

## Screenshots for a web app manifest

A PWA whose manifest has no screenshots gets Chrome's plain install dialog, and DevTools warns "Richer PWA Install UI won't be available on desktop". `--pwa` takes the screenshots that dialog shows:

```bash
npx easyscreenshotkit@latest yourapp.com --pwa
```

Next to the usual files you get:

```
pwa/
  manifest-screenshots.json   the "screenshots" for your manifest, with src, sizes, type, form_factor and label
  screenshots/wide-01.png     a page's first screen on a desktop, 1920x1080
  screenshots/narrow-01.png   the same page on a phone, 1080x1920
```

Put the `screenshots` folder next to your manifest and add the entries from `manifest-screenshots.json` to it. Each label is the main heading on that screen, so read them and change any that does not say what the screen shows. A capture of a web app's #route view that still showed a loading sign when its wait ran out or the run's time ran short, or that looked empty or like a bare loading screen with a request still out, is left out, with the reason; one that looks drawn with a request still open is kept, and any other page keeps its captures. The run also reads the manifest your home page links and tells you what it is missing.

Every screenshot is checked against Chrome's rules before it goes in:

- JPEG or PNG, each side between 320 and 3840 pixels, the long side at most 2.3 times the short one. A whole page is too long for that.
- Desktops show the screenshots whose `form_factor` is `wide`, phones show the rest. A side with none gets the plain dialog.
- Screenshots for the same side share one aspect ratio. Chrome leaves out the ones that do not match the first.
- Chrome looks at the first 8 entries of the list and no further, wide and narrow together, and DevTools warns past 5 on a phone. So `--pwa` keeps at most 8, 4 wide and 4 narrow when there are enough pages.
- `sizes` has to be the file's own size. Without it, Chrome shows a copy scaled down to 320 pixels high.
- A `description` in the manifest is optional. Chrome shows about 300 characters of it above the screenshots.

To check a manifest you already have, give `--pwa-check` its file or address, or your site's address:

```bash
npx easyscreenshotkit@latest --pwa-check public/manifest.json
npx easyscreenshotkit@latest --pwa-check yourapp.com
```

It tells you which screenshots a desktop and a phone would show and what to fix. It needs no browser and exits with 1 when something needs fixing, so it can run in CI.

`--pwa` covers the pages anyone can open. Screens behind a sign-in are not reached yet: take those yourself at 1920x1080 and 1080x1920, then run `--pwa-check` on the manifest.

## How it works

1. Opens the home page in a headless browser on a 1600x900 desktop screen, scrolls to the bottom and back so lazy parts render, and reads its links: the menu (closed dropdowns too), the big buttons on the first screen, the body and the footer. It reads robots.txt and up to 500 addresses from the sitemap at the same time. When you gave another page or a `#/` route, and the home page answers an error or a bot check or cannot be opened, as the root of a project site often does, the home page is left out with a note and the run starts at your address. An address that is itself the home page still fails.
2. Gives each link a kind from its address and its words, in English, Turkish, German, French, Spanish and Portuguese: pricing first, then product and feature pages, how it works, enterprise, integrations and templates, the changelog, downloads, about, docs, customers and the blog. A link in the menu counts more than one in the footer, and an address only the sitemap knows counts less. The best page of each kind goes first.
3. Opens the candidates in that order and keeps a page only when it is a page of its own: not a redirect to a sign-in page or to the home page, not a bot check, not an error, and not the same page under another address (the same final address, canonical link or text). A page that moves on by itself to another page once it has loaded, as one that sends the visitor on to a welcome page a second later, is waited for again and taken as the page it moved to, by that page's address, title and file names, and judged as a redirect is; its notes say where it was opened.
4. On each page, hides what floats over it: everything fixed to the screen except the page's own top bar and sidebar, plus the consent and chat tools seen most (OneTrust, Cookiebot, Didomi, Usercentrics, Intercom, Crisp, Drift, HubSpot, Zendesk and more). When a consent dialog had stopped the page from scrolling, it lets the page scroll again. A JavaScript dialog a page opens (`alert`, `confirm`, `prompt`) is answered with OK, as it would otherwise hold the page for good.
5. Takes the first screen once its pictures, videos and fade-ins are done, and the whole page a screen at a time, each screen as the browser shows it, joined into one image with sticky headers and fixed bars shown once.
6. Opens every page again as a phone (or an iPhone, or in the dark theme) in windows of its own while it looks for the next pages. A view of a web app gets one such window at a time, and no other page loads while it does: the browser sends a second request for the same data, from another window or from another view of the app, only once the answer to the first has begun to come.
7. Writes `manifest.json`, `SCREENSHOTS.md` and `sheet.png`.

## Limits

- The page a run starts at gives no screenshots when it answers with a bot check: easyscreenshotkit stops and says so, and does not try to get past it. A `--page`, or a deeper address given above one page, that answers with one is left out with a note, and the run goes on while it has taken the address given or a `--page`.
- Pages behind a login are not reached.
- A view of a web app is reached by its address, a `#/` or `#!` route such as `/app/#/plants`. Any other fragment, such as `#pricing`, is a place on the page: it is left out, with a note, and the page is taken from its top. So a view whose fragment starts with neither `#/` nor `#!`, such as `#inbox`, or that only a click opens, is not reached; a demo with `--steps` can visit it or click its way there.
- A menu that only exists while the mouse is over it, and links made of buttons with no address, are not seen; the sitemap and `--page` fill in.
- A consent wall that blurs the page or loads nothing until you agree can not be hidden away.
- Dark captures use the site's own dark theme. A site without one looks the same in both.
- A demo takes real time to record: a 30 second tour takes two to four minutes. It has no sound of its own; steps.json gives the times to lay narration or music on.
- In a demo recorded in slow motion, the page's own animations keep their speed, but ones a script drives may run fast.

## See also

- [easybrandkit](https://github.com/EminBudak/easybrandkit) saves a site's real logo files, colors and fonts as a brand kit.
- [launch-film](https://github.com/EminBudak/launch-film) turns a site into a short launch film, rendered on your machine.

## License

MIT
