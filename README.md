# CustomCuts

A Chrome/Edge extension for video tagging, real-time transcription, and playback control. Tag time ranges in any web video, generate live subtitles with local speech recognition, and manage your tagged video library.

## Features

- **Video Tagging** — Tag time ranges with custom labels, intensity levels, and clusters. Use tags to skip, loop, or filter sections during playback.
- **Real-Time Subtitles** — Live speech-to-text transcription powered by local AI models (Faster-Whisper, OpenAI Whisper, or NVIDIA Parakeet). Runs on your GPU — no cloud API needed.
- **Playback Control** — Fast forward, rewind, skip tagged sections, or play only tagged sections. Configurable keyboard shortcuts.
- **Video Manager** — Browse, search, filter, and rate all your tagged videos. Create static or auto-generated playlists.
- **Pattern Detection** — Learn audio patterns from time ranges and automatically detect or skip them in future playback.
- **Pop Tags** — Display text overlays at specific timestamps.
- **Bookmarks Integration** — Tag browser bookmarks with the same tagging system.

## Architecture

```
Chrome Extension (Manifest V3)
├── Content Script    → Detects videos, renders subtitle overlays
├── Popup             → Quick tagging, transcription controls
├── Background Worker → Coordinates native messaging, audio capture
├── Offscreen Doc     → Captures tab audio via tabCapture API
├── Options Page      → Settings (tags, display, playback, data)
└── Video Manager     → Full library management UI

Native Host (Python)
├── whisper_host.py          → Native messaging server (stdio)
├── faster_whisper_engine.py → Faster-Whisper (default engine)
├── whisper_engine.py        → OpenAI Whisper engine
├── parakeet_engine.py       → NVIDIA Parakeet engine
└── pattern_engine.py        → Audio pattern learning/detection
```

## Requirements

- **Browser**: Chrome or Microsoft Edge
- **OS**: Windows (native host uses Windows registry for registration)
- **Python**: 3.12+ (via Anaconda recommended)
- **GPU**: NVIDIA GPU with CUDA support (CPU fallback available)

### Python Dependencies

- `faster-whisper` — Default speech engine (CTranslate2 backend)
- `torch` — PyTorch (nightly build required for Blackwell GPUs)
- `numpy` — Audio processing

Optional:
- `openai-whisper` — Alternative speech engine
- `nemo-toolkit` + `lhotse` — NVIDIA Parakeet engine

## Installation

### 1. Load the Extension

1. Open `chrome://extensions/` (or `edge://extensions/`)
2. Enable **Developer mode**
3. Click **Load unpacked** and select this project's root directory
4. Note the **Extension ID** shown under the extension name

### 2. Set Up the Native Host

```bash
# Create and activate a conda environment
conda create -n customcuts python=3.12
conda activate customcuts

# Install dependencies
pip install faster-whisper numpy

# For GPU support (NVIDIA)
pip install torch --index-url https://download.pytorch.org/whl/cu128

# Register the native host with your browser
cd native_host
python install.py --extension-id <YOUR_EXTENSION_ID>
```

To register with only one browser:
```bash
python install.py --extension-id <ID> --chrome-only
python install.py --extension-id <ID> --edge-only
```

### 3. Restart Your Browser

Close and reopen Chrome/Edge for the native host registration to take effect.

## Usage

1. Navigate to any page with a video
2. Click the CustomCuts extension icon to open the popup
3. **Tagging**: Set start/end times and add tags to mark sections
4. **Subtitles**: Click the subtitles toggle to start real-time transcription
5. **Playback**: Use keyboard shortcuts or popup controls to navigate

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Alt+Shift+Right` | Fast forward (small) |
| `Alt+Shift+L` | Fast forward (large) |
| `Alt+Shift+Left` | Rewind |
| `Alt+Shift+C` | Close current tab |

Shortcuts can be customized at `chrome://extensions/shortcuts`.

## Settings

Access via the extension's **Options** page:

- **General** — Fast forward/rewind durations
- **Tags** — Define tag clusters for filtering
- **Display** — Subtitle appearance (font, color, position, opacity)
- **Popup** — Configure which panels appear in the popup
- **Data** — Export, import, or clear all extension data

## Uninstalling the Native Host

```bash
cd native_host
python install.py --uninstall
```
