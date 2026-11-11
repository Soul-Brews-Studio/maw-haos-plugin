# maw-haos-plugin

`maw haos` is a **read-only** view of Home Assistant OS instances: versions and updates, host, add-ons and their logs, backups and entity states. It keeps named profiles so you can check several instances.

## Install

```
maw plugin install Soul-Brews-Studio/maw-haos-plugin
maw haos --help
```

Update: `maw plugin update haos`

## Quick start

Save each instance once as a profile (stored in `~/.config/maw-haos/config.json`, mode 0600). Passwords and tokens are never saved: point `pass_entry` (or `token_entry`) at your `pass` store instead.

```
maw haos config set host=http://<ha-host>:8123 user=<admin-user> pass_entry=<pass/entry>
maw haos config set --profile lab host=http://10.0.0.7 token_entry=<pass/entry-with-token>
maw haos status
maw haos addons --profile lab
maw haos entities sensor --search temperature
```

A login-flow access token is cached until it expires (about 30 minutes, `~/.cache/maw-haos/<profile>.json`, 0600), so `pass`/gpg is not asked again on every command. `maw haos logout` forgets it. Environment variables always override the saved profile.

```
maw haos status                           core / supervisor / os versions, updates, host, /api/config
maw haos addons                           installed add-ons: slug name state version latest update
maw haos addon <slug> [--lines N]         one add-on: info + last N log lines (default 50)
maw haos backups                          backups: name date type size protected
maw haos entities [domain] [--search T]   /api/states: entity_id state unit last_changed

maw haos config [--profile NAME]          show the saved profile (and the file path)
maw haos config set k=v [k=v ...]         save: host user pass_entry token_entry insecure
maw haos config unset <key>               remove one saved setting
maw haos logout                           forget the cached access token of the profile

--profile NAME  saved profile (default "default", or $HA_PROFILE)    --json  JSON output
--insecure  accept a self-signed https cert    --debug  auth diagnostics (lengths/booleans only)
```

## Configuration

Nothing about any instance is stored in this repo. Each setting comes from the environment or the saved profile:

| Variable | Profile key | Meaning |
|---|---|---|
| `HA_HOST` | `host` | **required.** `http://host`, `host:8123` or `https://host`. The port is kept as given: HA answers on `:8123` by default, but a HAOS box can also answer on `:80` |
| `HA_TOKEN` | (never saved) | long-lived access token. Used first when set |
| `HA_TOKEN_ENTRY` | `token_entry` | `pass` entry whose first line is a long-lived token |
| `HA_USER` | `user` | user for the login flow |
| `HA_PASSWORD` | (never saved) | password for the login flow |
| `HA_PASS_ENTRY` | `pass_entry` | `pass` entry whose first line is the password. A `user:` / `login:` line in the entry fills in the user when none is set |
| `HA_INSECURE=1` | `insecure` | accept a self-signed https certificate (same as `--insecure`) |
| `HA_PROFILE` | | profile to use when `--profile` is not given |

Order: `HA_TOKEN`, then `token_entry`, then a cached login token, then user + password through HA's login flow (`/auth/login_flow` then `/auth/token`). With none of them the command stops with a message listing these options and sends no request. `--debug` prints only lengths and booleans.

The user must be an **administrator**: Home Assistant only gives Supervisor data (add-ons, backups, OS) to admins.

## Read-only, on purpose

v1 sends only `GET` requests, plus the three login-flow `POST`s. Over the websocket it sends only the auth message and `supervisor/api` calls with `method: "get"`; the method is fixed in the code. Nothing here installs, updates, restarts, changes add-on options or writes a config flow, and a test fails if any of that appears.

Secrets are kept out of the output too: `addon` shows the names of an add-on's options but never their values, and `entities` never passes attributes through (some, like a camera's `entity_picture`, carry access tokens). The login flow is tried once per command; a wrong password is reported and not retried, because Home Assistant can ban an IP after repeated failed logins.

## Notes

- Supervisor data goes through the HA Core websocket (`{"type":"supervisor/api","endpoint":"/addons","method":"get"}`), the same way the HA frontend does it. A direct `GET /api/hassio/addons` answers 401 with an empty body even for the owner; that is a closed proxy, not a bad token.
- Add-on logs are the exception: they are text, and come from `GET /api/hassio/addons/<slug>/logs` over REST. A slug that is only in the store (not installed) shows `not installed` and no logs.
- On plain Home Assistant without a Supervisor (Container or Core install), `status` still shows the core config and lists the Supervisor parts as not available.
- Every login creates a refresh token on the HA user. The plugin stores only the short-lived access token, so a long-lived token (`token_entry`) is the cleaner choice for frequent use. Accounts with MFA need a long-lived token.
- Times are shown in the local time zone (`TZ`).

## Development

```
ghq get https://github.com/Soul-Brews-Studio/maw-haos-plugin
cd ~/Code/github.com/Soul-Brews-Studio/maw-haos-plugin
bun test
bun src/index.ts status --profile <name>
```
