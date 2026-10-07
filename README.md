# Sidebar Organizer for herdr

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![herdr plugin](https://img.shields.io/badge/herdr-plugin-8ec07c.svg)](https://herdr.dev/plugins/)

A [herdr](https://herdr.dev) plugin for people who run a lot of AI coding agents at once.
When the Spaces sidebar grows to twenty-plus workspaces, it gives the list some order and
gives you a few fast ways to get where you need to be:

- **Categories** — group workspaces under titled sections (`━━ CLIENT WORK ━━`). Drag a project in
  the herdr sidebar and it joins the category it was dropped into.
- **Colour stars** — four kinds of stars (say: your own project and three jobs). `F1`…`F4` puts a
  star on the open project, `Alt+1`…`Alt+4` cycles through the projects with that star.
- **Jump hotkeys** — bind `Alt+5`, `F7` or any free combination to a project, or to one tab inside it.
  Hotkeys survive renames and herdr restarts.
- **Worktree detach** — pull a git worktree out of its project's group into a category of its own,
  without stopping the agents running in it; put it back later.
- **Duty agents** — an agent that works around the clock (ads watch, monitoring, a nightly loop)
  checks in with `herdr-duty`. If it stops waking up, gets stuck on a question or its pane disappears,
  the sidebar turns it red, herdr shows a notice, and (optionally) Telegram pings you.

```
━━ CLIENT WORK ━━
● ★1 · acme-api · Alt+5
  main
● ★2 · acme-web
  feature/login
━━ AUTOMATIONS ━━
○ ads-watch · F7
  ◆ on duty 1d9h · every 30m
○ nightly-report
  ▲ no wake-up for 46m
━━ NO CATEGORY ━━
○ scratch
```

Everything is managed from one popup window (`prefix`, then `Shift+S`) that works with the
keyboard and the mouse.

## Install

Needs herdr 0.9.1 or newer and Node.js 20 or newer.

```sh
herdr plugin install patraianton/herdr-sidebar
herdr plugin action invoke setup --plugin anton.sidebar
```

`setup` adds the plugin's sidebar rows and key bindings to herdr's `config.toml` (between
`# >>> anton.sidebar` marker comments, with a dated backup next to the file), reloads herdr and puts the
`herdr-duty` command into `~/.local/bin`. A notice tells you when it is done.

Then open the window: `prefix` (`Ctrl+B` by default), then `Shift+S` — or right-click a workspace
and pick **Sidebar Organizer**. Press `?` in the window for every key.

**Update:** run `herdr plugin install patraianton/herdr-sidebar` again, then the same `setup`
action: it brings the config rows and bindings up to date and restarts the plugin's helper.

**Uninstall:** press `U` in the window (type `yes`). The sidebar order, `config.toml` and the
`herdr-duty` command go back to how they were. Then `herdr plugin uninstall anton.sidebar`.

## The window

| Key | What it does |
|---|---|
| `↑` `↓`, `PgUp` `PgDn`, `Home` `End` | select a row |
| `Shift+↑` `Shift+↓` or `J` `K` | move a project or a whole category |
| mouse | click to select, drag a row to move it |
| `m` | move the project to another category |
| `n` `r` `x` | new category, rename, delete |
| `→` `←` | show or hide a project's worktree copies |
| `w` | detach a worktree copy from its project / put it back |
| `t` | duty: start, change the interval, reset an alarm, end |
| `k` | jump hotkey for the project or one of its tabs |
| `s` | star: pick a kind, take it off, or rename the kinds |
| `Enter` | menu of everything above for the selected row |
| `U` | switch the plugin off and put everything back |
| `q` / `Esc` | close |

Workspaces you never put into a category stay at the bottom, under `NO CATEGORY`, in herdr's own order.

## Stars

| Kind | Go round them | Put on / take off | Colour |
|---|---|---|---|
| ★1 | `Alt+1` | `F1` | yellow |
| ★2 | `Alt+2` | `F2` | teal |
| ★3 | `Alt+3` | `F3` | pink |
| ★4 | `Alt+4` | `F4` | orange |

- `F1`…`F4` works on the project that is open right now; the same key again takes the star off,
  another F-key changes the kind.
- `Alt+N` inside a project of kind N goes to the next one down the sidebar (and round to the first);
  from anywhere else it goes back to the one of kind N you visited last.
- `Alt+0` takes every star off at once. Pressed again while there are no stars, it brings back what
  it took off.
- The kinds are called Main, Second, Third and Fourth until you name them: in the window press `s`,
  then **Rename the kinds of stars…**.

## Jump hotkeys

Select a project, press `k` and pick a key. The window only offers keys that are free — not taken
by herdr, by another plugin or by the stars. A project with several tabs asks whether the key
should open the project or one particular tab. The key shows next to the project's name in the
sidebar. Under the hood the binding is a `[[keys.command]]` entry in `config.toml` that runs the
plugin action `jump-N`; if herdr refuses a new binding, the file goes back as it was.

## Duty agents

Tell a long-running agent to check in from its own pane:

```sh
herdr-duty start --every 30m --note "watching the ads account"
herdr-duty ok                      # optional "I am alive" after each round
herdr-duty fail "no access to the ads account"
herdr-duty stop
herdr-duty status
```

The plugin raises one alarm per incident when the agent:

- has not woken up for the interval plus half of it (at least 10 minutes more),
- has been waiting for an answer for more than 10 minutes,
- lost its pane for more than 3 minutes,
- or reported trouble itself with `herdr-duty fail`.

When it works again, you get one "working again" message. A short grace period after herdr or the
computer wakes up keeps restarts from looking like failures. You can also put an agent on duty by
hand: select its workspace in the window and press `t`.

A line like this in your agents' instructions (`CLAUDE.md`, `AGENTS.md`) is enough:

> When you are asked to watch something around the clock and you work in rounds, run
> `herdr-duty start --every <your interval> --note "<what you watch>"` once, `herdr-duty ok` after
> every round, `herdr-duty fail "<reason>"` when you are stuck and need a human, and
> `herdr-duty stop` when the job is over.

### Telegram alerts (optional)

Put a `.env` file into the plugin's config folder (`herdr plugin config-dir anton.sidebar` prints it):

```sh
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=123456789
```

The bot key is read at every send and never copied or logged. If your bot key already lives in
another `.env`, point at it with `telegram.json` in the same folder:

```json
{ "chatId": 123456789, "envFile": "/path/to/.env", "envKey": "MY_BOT_TOKEN" }
```

`{ "enabled": false }` switches Telegram off.

## Settings

`settings.json` in the plugin's config folder (all fields optional):

```json
{
  "starNames": ["My project", "Job 1", "Job 2", "Job 3"],
  "tickSec": 30,
  "blockedMin": 10,
  "missingMin": 3,
  "graceMin": 10,
  "silenceMarginMin": 10
}
```

`starNames` is easiest to set from the window (`s` → **Rename the kinds of stars…**). The duty
thresholds are read when the helper starts — run the `setup` action again to restart it.

## How it works

- A small background helper (one per herdr session) watches workspace events, keeps the order of the
  sidebar, and publishes custom tokens — `$section`, `$star`, `$key`, `$project`, `$duty` — that the
  plugin's sidebar rows display. herdr has no title rows of its own, so a category title is a line
  drawn on top of the category's first project.
- Plugin state lives in herdr's plugin state folder (one folder per session); your settings live
  in the plugin config folder. Nothing is written into the plugin checkout.
- The window, the hotkeys and `herdr-duty` talk to the helper over a local pipe; if the helper is
  not running, they start it.

## Development

```sh
git clone https://github.com/patraianton/herdr-sidebar
herdr plugin link ./herdr-sidebar
herdr plugin action invoke setup --plugin anton.sidebar

npm test                         # unit tests, no herdr needed
node test/integration/run.js     # Windows: end-to-end run in throwaway herdr sessions
```

The end-to-end run starts two isolated herdr sessions (`sbplug` and `sbview`), presses real keys in
them and never touches your own session.

## License

[MIT](LICENSE) © Anton Patrai
