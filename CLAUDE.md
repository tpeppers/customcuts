# CustomCuts - Claude Code Notes

## Environment
- **Platform**: Windows (PowerShell)
- **Path separators**: Use backslashes (`\`) or forward slashes (`/`) in paths
- **Shell**: Commands run via PowerShell/cmd, NOT bash
- **Anaconda**: Installed at `C:\Users\taimp\anaconda3`

## Conda Environment
- **Environment name**: `customcuts`
- **Python version**: 3.12
- **CUDA**: 12.8 (via PyTorch nightly - required for Blackwell GPU)
- **Key packages**: torch (nightly), faster-whisper

## When running commands
- Use `cmd /c "command"` for Windows-native commands if path issues occur
- Conda executable: `C:\Users\taimp\anaconda3\Scripts\conda.exe`
- Run in conda env: `"C:/Users/taimp/anaconda3/Scripts/conda.exe" run -n customcuts <command>`

## BrightScript / Roku channel (`customcuts-roku/`)
- **Do not use `box` as an identifier in BrightScript** (`.brs` / `.xml`). It's a
  reserved word in `brs-engine` (the BrightScript Simulator we test with under
  `test_env/brs-desktop`), even though real Roku firmware accepts it. The
  parser rejects it as a local variable name *and* as a dot-accessor field
  name (`obj.box`). Real Roku tolerates it, so existing channels can compile
  there but fail to load in the simulator.
- If a JSON payload from the host uses `"box"` as a field, access it with
  bracket notation (`ann["box"]`) and assign it to a non-reserved local like
  `rect`. Do not rename the wire field — `native_host` and the manager UI
  already speak `box`.
- Same caution applies to other BrightScript reserved/keyword-ish names; when
  in doubt, prefer descriptive locals (`rect`, `nodeRef`, `entry`) over
  one-word names that could collide with intrinsics.
- Test loop: `python customcuts-roku/build.py` writes `customcuts-roku.zip`,
  then drag-drop into the BrightScript Simulator (`test_env/brs-desktop/`)
  *before* sideloading to a real Roku — the simulator surfaces parser errors
  the device silently masks.

---

## TODO: Re-evaluate NVIDIA Parakeet TDT (preferred architecture)

**Issue**: NeMo/Parakeet is the architecturally correct choice for streaming ASR, but has
compatibility issues as of 2026-01-13:

1. **Blackwell GPU (RTX 5060 Ti, sm_120)** requires PyTorch nightly with CUDA 12.8+
2. **NeMo 2.6.1 + lhotse 1.31.1** has `TypeError: object.__init__()` bug with PyTorch nightly
3. Currently using **Faster-Whisper** as workaround

**To test if resolved**, run:
```bash
"C:/Users/taimp/anaconda3/Scripts/conda.exe" run -n customcuts python -c "
import nemo.collections.asr as asr
model = asr.models.ASRModel.from_pretrained('nvidia/parakeet-tdt-0.6b-v3')
print(model.transcribe(['test.wav']))
"
```

**Watch for**:
- NeMo releases > 2.6.1 with lhotse compatibility fixes
- PyTorch stable release with Blackwell (sm_120) support
- lhotse releases fixing `DynamicCutSampler` inheritance issue

**Why Parakeet is preferred**:
- Designed for streaming/real-time transcription
- Faster inference than Whisper
- Better word-level timestamp support
- NVIDIA-optimized for CUDA
