# Paseo Deck

Paseo Deck is a fast, keyboard-first terminal client for managing several Paseo sessions at once. It presents projects, workspaces, and agents as a navigable tree beside the selected agent's live timeline, with prompt composition, permissions, agent creation, and lifecycle controls in one terminal screen.

![Paseo Deck showing a synthetic multi-agent session](docs/images/ui-report/session-tree.svg)

## Requirements

- Node.js 22.19 or newer
- npm
- A compatible Paseo daemon and `paseo` executable (tested with 0.8.0)

## Install and run

```sh
git clone git@github.com:Julesseg/paseo-deck.git
cd paseo-deck
npm ci
npm run build
npm link
paseo-deck
```

`pdeck` is an equivalent shorter executable name. For development, use `npm run dev -- [options]`.

Paseo Deck connects to the desktop-managed or standalone local daemon by default:

```sh
paseo-deck
paseo-deck --home /path/to/paseo-home
paseo-deck --host localhost:6767
paseo-deck --host tcp://devbox.example:6767
```

Set `PASEO_PASSWORD` in the environment when the target daemon requires a password.

## Development

```sh
npm run dev        # run from TypeScript
npm run build      # build dist/
npm test           # run Vitest
npm run typecheck  # check strict TypeScript
npm run lint       # run Biome lint rules
npm run format     # format the project
npm run check      # formatting, lint, types, tests, and build
```

CI runs `npm ci` and `npm run check` on Node.js 22.

## Keymap

| Key | Action |
| --- | --- |
| `j` / `k` | Move through the active list or timeline |
| `h` / `l` | Collapse or expand a tree node or timeline block |
| `Enter` | Select, open, expand, or confirm |
| `Tab` / `Shift+Tab` | Move focus between tree, timeline, and composer |
| `i` | Focus the prompt composer |
| `n` | Create an agent in the selected workspace |
| `/` | Filter sessions |
| `p` | Review pending permissions |
| `a` / `d` | Allow or deny inside the permission dialog |
| `x` | Stop the selected agent after confirmation |
| `A` | Archive the selected agent after confirmation |
| `d` | Detach the selected agent after confirmation |
| `e` | Rename the selected agent |
| `m` | Choose an available mode |
| `t` | Choose an available thinking level |
| `r` | Refresh and reconnect |
| `E` | Expand the current error details |
| `?` | Show help |
| `Esc` | Close a dialog or cancel editing |
| `q` | Quit when no text field is active |

## Supported in v0.1

- Project, workspace, and agent discovery with filtering and attention markers
- Existing history plus live user, assistant, reasoning, tool, error, permission, and turn events
- Follow-up prompts and provider/model-aware agent creation
- Permission allow and deny responses
- Stop, archive, detach, and rename with confirmation for destructive actions
- Mode and thinking changes when advertised by the provider
- Cursor-aware timeline recovery, replacement handling, and clean observation release
- Default local, `--home`, and direct TCP daemon targets
- Responsive narrow-terminal layout and terminal restoration on exit

## Known limitations

- v0.1 does not include embedded PTYs, diffs, browser panes, schedules, mobile relay pairing, SSH transport, or live model switching.
- Stop, rename, thinking, and mode changes use documented `paseo --json` commands because the public SDK does not expose them. All other operations use the public SDK.
- The stable 0.8.0 client reports a directory subscription ID but does not expose a public per-observation release handle or connection-state stream. Paseo Deck releases all local listeners immediately and releases server demand when the client closes; refresh provides explicit reconnection.
- Markdown rendering and fenced-code highlighting are intentionally compact for terminal use.

## Security

Connect only to a Paseo daemon you trust. The daemon can expose agent history and can execute agent actions. Keep passwords out of shell arguments and command history: use `PASEO_PASSWORD`, preferably injected by a local secret manager. Paseo Deck never includes the password in errors or subprocess arguments.

## Design and attribution

The implementation uses only public Paseo packages and keeps SDK, CLI fallback, state, and terminal concerns behind separate module boundaries. See [the architecture note](docs/architecture.md) for the lifecycle design.

[huanghaiyangyy/paseo-tui](https://github.com/huanghaiyangyy/paseo-tui) (MIT) informed the investigation of timeline projection, permission presentation, and pi-tui terminal patterns. Paseo Deck's multi-session store and implementation were written independently; no source code was copied.

## License

MIT. See [LICENSE](LICENSE).
