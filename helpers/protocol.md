# Glossly helper protocol (v1)

The native helper (`helpers/windows`, later `helpers/macos`) is a long-running child process of the app. It speaks JSON lines: one JSON object per line, UTF-8, `\n`-terminated.

- **stdin**: requests from the app, handled one at a time, in order.
- **stdout**: exactly one response line per request, plus unsolicited event lines.
- **stderr**: diagnostics only. Never contains selection, context, or clipboard text.
- The helper exits when stdin closes.

The Zod schemas in `packages/core/src/helper/protocol.ts` are the machine-readable version of this document. The fixtures in `helpers/fixtures/*.json` are checked against those schemas by `pnpm test`, and any helper (Windows or macOS) must produce responses that pass them.

## Coordinates

All coordinates and bounds are **physical screen pixels** (the Windows helper is PerMonitorV2 DPI aware). The app converts them with `screen.screenToDipRect` / `screenToDipPoint`. Rects are `{x, y, w, h}`.

## Requests and responses

```json
{"id": 42, "cmd": "selection"}
{"id": 42, "ok": true, "result": { ... }}
{"id": 42, "ok": false, "error": {"code": "no_selection", "message": "No UI Automation selection found"}}
```

- `id` is any JSON number or string chosen by the app; it is echoed back. If the request could not be parsed, `id` is `null`.
- Arguments are top-level fields next to `cmd`. Optional arguments have defaults and are clamped to the ranges shown.

### Error codes

| Code | Meaning |
| --- | --- |
| `bad_request` | Not JSON, not an object, missing `cmd`, missing or mistyped argument |
| `unknown_command` | `cmd` is not one of the commands below |
| `no_selection` | No accessible selection was found (context commands) |
| `password_field` | The focused element or selection is a password field; nothing was read |
| `no_foreground` | There is no foreground window |
| `window_gone` | `restore_focus`: the handle is not a window anymore |
| `focus_failed` | `restore_focus`: every method was tried and the window is still not in front |
| `clipboard_busy` | Another process held the clipboard for more than 200 ms |
| `hook_failed` | The mouse hook could not be installed |
| `internal` | Unexpected exception; `message` is the exception type only |

## Commands

### `ping`

Result: `{"pong": true, "version": "0.1.0", "protocol": 1}`

### `selection`

Reads the current selection through UI Automation (Accessibility on macOS). Never simulates a copy, so it is safe on the auto-pill path.

| Arg | Default | Range |
| --- | --- | --- |
| `max_chars` | 20000 | 1 to 200000 |

Result:

| Field | Type | Notes |
| --- | --- | --- |
| `text` | string | `""` when nothing is selected, or when `is_password` |
| `method` | `"uia"` or `"ax"` | |
| `bounds` | rect or `null` | Union of the selection's line rectangles. `null` if the provider does not report them; the app falls back to the cursor position |
| `is_editable` | bool | Edit control, or a value that is not read-only |
| `is_password` | bool | If true, `text` is always empty |
| `control_type` | string | Lower-case control type of the text provider (`edit`, `document`, ...), for the debug view |
| `truncated` | bool | `text` was cut at `max_chars` |

Windows notes: walks up from the focused element to the nearest TextPattern provider, then tries the element under the cursor. For Chromium and Electron windows (`Chrome_WidgetWin_*`) it first sends `WM_GETOBJECT` once per window to switch on their accessibility tree and retries once after 150 ms if that was the first contact.

### `context`

Tier-1 context: text immediately around the current selection.

| Arg | Default | Range |
| --- | --- | --- |
| `before` | 500 | 0 to 5000 |
| `after` | 500 | 0 to 5000 |

Result: `{"before": string, "after": string}`. Errors: `no_selection`, `password_field`.

### `context_container`

Tier-2 context: the text of the enclosing container (message list, email body, article), centered on the selection.

| Arg | Default | Range |
| --- | --- | --- |
| `max_chars` | 8000 | 100 to 50000 |

Result:

| Field | Type | Notes |
| --- | --- | --- |
| `text` | string | At most `max_chars` (plus up to 1000 in the `tier1` fallback) |
| `selection_start` | int | Offset of the selection inside `text` |
| `selection_length` | int | |
| `source` | `"container"` or `"tier1"` | `tier1` means no container was found and the result is the selection plus 500 characters on each side |
| `container_type` | string | `document`, `list`, `pane`, or `none` |

Errors: `no_selection`, `password_field`.

### `foreground`

Result: `{"handle": int, "pid": int, "process_name": "slack.exe", "title": string, "class_name": string}`. `process_name` is lower-case with `.exe` (on macOS: the bundle executable name). `handle` is an opaque integer to pass back to `restore_focus`.

### `popups_near`

Lists popup windows and toolbar or menu elements near a selection, so the pill can avoid them. Budget: about 80 ms.

| Arg | Notes |
| --- | --- |
| `bounds` | Required rect: the selection bounds |
| `exclude_pids` | Optional int array: the app's own processes |

Result: `{"popups": [{"source": "window" | "uia", "kind": string, "bounds": rect}]}`. `kind` is `popup_window`, `tool_window`, `toolbar`, `menu`, or `tooltip`. The app decides which side of the selection each popup is on.

### `copy_fallback`

Hotkey path only. Snapshots every clipboard format, sends `Ctrl+C` (after waiting for or releasing the hotkey's modifier keys), waits for the clipboard sequence number to change, reads the text, and restores the snapshot in a `finally` block.

| Arg | Default | Range |
| --- | --- | --- |
| `timeout_ms` | 120 | 10 to 2000 |

Result: `{"text": string, "method": "copy", "clipboard_restored": bool}`. `text` is `""` if the app did not copy anything in time. Errors: `password_field` (checked before copying), `clipboard_busy`.

### `restore_focus`

| Arg | Notes |
| --- | --- |
| `handle` | Required, from `foreground` |

Restores the window if minimized, then tries `SetForegroundWindow`, then a dummy key press, then `AttachThreadInput`. Each attempt is verified.

Result: `{"restored": true, "method": "already" | "direct" | "dummy_key" | "attach_thread_input"}`. Errors: `window_gone`, `focus_failed`.

### `paste`

| Arg | Default | Notes |
| --- | --- | --- |
| `text` | | Required |
| `settle_ms` | 250 | 0 to 2000. Wait after `Ctrl+V` before restoring the clipboard |

Snapshots the clipboard, sets `text` (marked to stay out of clipboard history and cloud sync), sends `Ctrl+V`, waits `settle_ms`, restores. Result: `{"pasted": true}`. Call `restore_focus` first.

### `mouse_hook`

| Arg | Notes |
| --- | --- |
| `enabled` | Required bool |

Turns `mouse_down`, `mouse_up`, and `wheel` events on or off. Result: `{"enabled": bool}`.

### `input_watch`

| Arg | Notes |
| --- | --- |
| `enabled` | Required bool |

While on, the helper emits `keyboard_activity` when the system's last-input time moves without a matching mouse event. There is no keyboard hook: the helper never sees which keys were pressed. The app turns this on only while the pill is visible. Result: `{"enabled": bool}`.

## Events

Event lines have an `event` field and no `id`.

| Event | Fields | When |
| --- | --- | --- |
| `ready` | `version`, `protocol`, `pid` | Once at startup, before any response |
| `mouse_down` | `x`, `y`, `button` (`left`, `right`, `other`) | Any button press, while `mouse_hook` is on |
| `mouse_up` | `x`, `y`, `drag`, `double` | Left button release. `drag`: moved more than 4 px since the press. `double`: a second click within the system double-click time and 4 px |
| `wheel` | | Vertical or horizontal wheel, at most every 100 ms |
| `keyboard_activity` | | Non-mouse input, while `input_watch` is on. Reported 50 to 100 ms after it happens |

The helper's own injected input (copy, paste, focus tricks) never produces events.

## Fixtures

`helpers/fixtures/<command>.json` holds `{"cmd", "cases": [{"name", "request", "response"}]}` and `events.json` holds `{"events": [...]}`. Text in committed fixtures is made up. `pnpm helper:record` runs the read-only commands against whatever app is in front after a 3-second delay and writes `helpers/fixtures/recorded/local-<timestamp>.json`; those files are git-ignored because they contain real screen text.
