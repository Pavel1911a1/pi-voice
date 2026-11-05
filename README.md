# pi-voice

Offline voice input for the [pi](https://pi.dev) coding agent. Press a key, speak Russian or English,
pause — the text appears in pi's editor for you to review and send.

- **Private.** Audio never leaves your machine: it is captured with
  [PvRecorder](https://github.com/Picovoice/pvrecorder) and transcribed locally by
  [whisper.cpp](https://github.com/ggml-org/whisper.cpp) via [whisper.node](https://github.com/mybigday/whisper.node).
  No accounts, API keys or cloud.
- **Russian and English**, detected automatically per recording.
- **No system packages.** No brew, apt, choco or compilers: npm installs prebuilt binaries for your OS and CPU.

## Install

```bash
pi install git:github.com/Pavel1911a1/pi-voice
```

Then restart pi. The first time you start recording, pi-voice downloads the speech model
(`ggml-large-v3-turbo-q5_0.bin`, ~550 MB) into `~/.pi/agent/voice/models/` and shows progress in
the status bar. After that everything works offline.

Update with `pi update --extensions`, remove with `pi remove git:github.com/Pavel1911a1/pi-voice`.

### Supported platforms

| OS | CPU | Notes |
|---|---|---|
| macOS | Apple Silicon, Intel | Apple Silicon uses the GPU (Metal); a 10 s phrase takes ~1.5 s |
| Windows | x64, arm64 | |
| Linux | x64 | arm64 is not supported by the recorder (except Raspberry Pi builds) |

Developed and tested on macOS. Windows and Linux use the upstream prebuilt binaries and are
expected to work; reports welcome.

## Use

| Action | How |
|---|---|
| Talk | press the shortcut (default `alt+m`) or run `/voice`, speak; recording stops after a 1.5 s pause |
| Hold to talk | hold the shortcut while speaking, release to stop (terminals that report key releases, see below) |
| Stop early | press the shortcut again |
| Language for this session | `/voice-lang auto`, `/voice-lang ru`, `/voice-lang en` |
| List microphones | `/voice-devices` |

While recording the status bar shows `● REC 0:05`; while transcribing, `voice: transcribing...`.

### Two modes, picked automatically

- **Hold to talk** works in terminals that support the
  [kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/), because only they
  tell programs when a key is released: Ghostty, kitty, WezTerm (with the setting below),
  Alacritty, foot.
- **Press and pause** everywhere else (macOS Terminal, Windows Terminal, GNOME Terminal, Konsole,
  VS Code / JetBrains terminals...): press once, speak, and recording stops by itself when you pause.

## Setting up the shortcut

The default shortcut is `alt+m`. Terminals deliver Alt (Option on a Mac) differently, so check yours below.

### macOS

On a Mac, `alt` is the **Option (⌥)** key.

- **Terminal.app** — Settings → Profiles → *your profile* → Keyboard → enable
  **Use Option as Meta key**. Without it Option+M still works on the U.S. layout, but on Russian or
  Ukrainian layouts Option+M types `~` and cannot be used as a shortcut.
- **iTerm2** — Settings → Profiles → Keys → General → set **Left Option key** to **Esc+**.
- **Ghostty** (hold to talk) — add `macos-option-as-alt = true` to `~/.config/ghostty/config`.
- **kitty** (hold to talk) — add `macos_option_as_alt yes` to `~/.config/kitty/kitty.conf`.
- **WezTerm** (hold to talk) — add `config.enable_kitty_keyboard = true` to `~/.wezterm.lua`.
- **Alacritty** (hold to talk) — add `option_as_alt = "Both"` under `[window]` in `alacritty.toml`.

Microphone: on the first recording macOS asks to let your **terminal app** use the microphone.
If you missed the prompt, enable it in System Settings → Privacy & Security → Microphone and restart
the terminal.

### Windows

- **Windows Terminal**, PowerShell and cmd send Alt+M as-is; no setup needed.
- Microphone: Settings → Privacy & security → Microphone → turn on **Microphone access** and
  **Let desktop apps access your microphone**.

### Linux

- Most terminals (GNOME Terminal, Konsole, xterm, Alacritty, kitty, foot) send Alt+M as-is.
- GNOME Terminal and some others use Alt+letter for menus: if Alt+M opens a menu, turn off
  *Enable menu access keys* (GNOME Terminal: Preferences → General).
- The recorder uses the default input of PulseAudio / PipeWire / ALSA. Pick another microphone with
  `/voice-devices` and the `device` setting.

### Choosing another shortcut

Set `shortcut` in `~/.pi/agent/voice.json` (see below) and restart pi. Format: modifiers
`ctrl`, `shift`, `alt`, `super` joined with `+` and a key: a letter, digit, `space`, `f1`–`f12`, etc.
Examples: `"alt+v"`, `"ctrl+alt+space"`, `"f8"`.

Pick a combination your terminal can send and pi does not already use. Most `ctrl+letter`
combinations are taken by pi, and classic terminals cannot tell `ctrl+shift+m` from `ctrl+m`
(which is Enter). Alt+letter or a function key is the safest choice.

The shortcut also works on Russian and Ukrainian keyboard layouts: Alt+Ь counts as Alt+M.

## Settings

All optional, in `~/.pi/agent/voice.json`:

```json
{
  "shortcut": "alt+m",
  "language": "auto",
  "vocabulary": ["Neo4j", "Kubernetes", "pull request"],
  "autoStop": true,
  "silenceMs": 1500,
  "device": -1,
  "maxSeconds": 300
}
```

| Setting | Default | Meaning |
|---|---|---|
| `shortcut` | `alt+m` | Key that starts/stops recording |
| `language` | `auto` | `auto`, `ru` or `en`. Fix it if detection guesses wrong |
| `vocabulary` | `[]` | Names and terms whisper tends to mishear; passed to it as a hint |
| `autoStop` | `true` | In press-and-pause mode stop after a pause; `false` means always stop with a second press |
| `silenceMs` | `1500` | Pause length that ends a recording; raise it if you get cut off mid-sentence |
| `device` | `-1` | Microphone index from `/voice-devices`; `-1` is the system default |
| `maxSeconds` | `300` | Hard limit for one recording |
| `model` | `ggml-large-v3-turbo-q5_0.bin` | Any ggml whisper model from [whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp); smaller models are faster but much weaker in Russian |
| `modelUrl` | Hugging Face | Where to download `model` from, e.g. an internal mirror |

Changes apply after `/reload` or restarting pi.

## Troubleshooting

- **Nothing happens on the shortcut** — your terminal does not send Alt: see
  [Setting up the shortcut](#setting-up-the-shortcut), or use `/voice`.
- **"Nothing heard"** — the microphone is muted, not permitted for the terminal, or a different one is
  selected: check `/voice-devices` and the OS microphone permission.
- **Words come out wrong** — add them to `vocabulary`; set `language` if your speech is mostly one language.
- **Cut off mid-sentence** — raise `silenceMs`, or use a terminal with hold-to-talk.
- **Model download fails** behind a proxy or firewall — download the model file yourself into
  `~/.pi/agent/voice/models/`, or point `modelUrl` to a reachable copy.

## How it works

`extensions/voice.ts` handles the shortcut and commands, records 16 kHz mono audio with PvRecorder,
and detects the end of speech by loudness. Transcription runs in a child process
(`extensions/whisper-worker.mjs`) that keeps the model loaded between recordings; running it
separately keeps whisper.cpp's native logs off pi's screen and pi responsive while it works.

## License

MIT. The speech model is distributed by the whisper.cpp project under the MIT license; PvRecorder
is Apache-2.0.
