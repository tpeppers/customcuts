"""HUD-style timestamped annotation overlays for the Kodi player.

The extension stores annotations under each video record and the streaming
host echoes them on `/queue.json` as `entry.annotations`. We render them
with a non-modal `xbmcgui.WindowDialog` whose controls are pre-allocated
into a pool — the controller calls `update(t)` per playback tick to swap
in/out the annotations whose [startTime, endTime] window covers `t`.

We deliberately keep the rendering simple: a colored background panel
(ControlImage tinted via colorDiffuse over a 1×1 white PNG written once
to the addon's profile dir) plus a ControlLabel on top. Shapes
(dot/circle/arrow) from the Chrome editor are dropped on this side —
Kodi has no general-purpose 2D primitive API and a good shape renderer
needs per-shape PNG assets we don't ship.
"""
import base64
import os

import xbmc
import xbmcaddon
import xbmcgui

try:
    import xbmcvfs
    _translate = xbmcvfs.translatePath
except (ImportError, AttributeError):
    _translate = getattr(xbmc, 'translatePath', lambda p: p)


# 1×1 fully-opaque white PNG. ControlImage colorDiffuse multiplies into
# the source pixel, so tinting white yields the exact target color and
# any (color · alpha) combination just by varying the diffuse string.
_WHITE_PNG_B64 = (
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmM'
    'IQAAAABJRU5ErkJggg=='
)


def _profile_dir():
    return _translate(xbmcaddon.Addon().getAddonInfo('profile'))


def _ensure_white_png():
    """Write the 1×1 tint texture to the addon's profile dir on first call."""
    pdir = _profile_dir()
    try:
        os.makedirs(pdir, exist_ok=True)
    except Exception:
        pass
    path = os.path.join(pdir, 'cc_white.png')
    if not os.path.isfile(path):
        try:
            with open(path, 'wb') as f:
                f.write(base64.b64decode(_WHITE_PNG_B64))
        except Exception:
            return ''
    return path


def _hex_to_argb(hex_color, opacity_pct):
    """Convert '#rrggbb' + 0..100 opacity to Kodi 'AARRGGBB' diffuse string."""
    if not hex_color or not hex_color.startswith('#') or len(hex_color) < 7:
        rgb = '000000'
    else:
        rgb = hex_color[1:7].upper()
    a = max(0, min(100, int(opacity_pct or 0)))
    a_byte = int(round(a * 255 / 100))
    return f'{a_byte:02X}{rgb}'


def _font_for_size(px):
    """Map a fontSize (CSS pixels in the Chrome editor) to a Kodi font name.
    Kodi font names depend on the active skin; these four are present in
    Estuary, the default skin since Kodi 17, and degrade gracefully if
    missing (Kodi falls back to its default font)."""
    px = int(px or 16)
    if px >= 28:
        return 'font40'
    if px >= 22:
        return 'font30'
    if px >= 16:
        return 'font13'
    return 'font12'


class AnnotationOverlay:
    MAX_SLOTS = 16

    def __init__(self):
        self._dialog = None
        self._slots = []   # list of {bg: ControlImage, label: ControlLabel}
        self._loaded = []  # currently loaded annotations for this video
        self._screen_w = 1920
        self._screen_h = 1080
        self._tex = ''

    # --- lifecycle ----------------------------------------------------
    def open(self):
        """Create the dialog + slot controls. Idempotent."""
        if self._dialog is not None:
            return
        self._tex = _ensure_white_png()
        try:
            self._screen_w = xbmcgui.getScreenWidth()
            self._screen_h = xbmcgui.getScreenHeight()
        except Exception:
            pass
        self._dialog = xbmcgui.WindowDialog()
        for _ in range(self.MAX_SLOTS):
            bg = xbmcgui.ControlImage(
                0, 0, 1, 1, self._tex, colorDiffuse='00000000',
            )
            label = xbmcgui.ControlLabel(
                0, 0, 1, 1, '',
                font=_font_for_size(16),
                textColor='FFFFFFFF',
            )
            self._dialog.addControls([bg, label])
            bg.setVisible(False)
            label.setVisible(False)
            self._slots.append({'bg': bg, 'label': label})
        self._dialog.show()

    def close(self):
        if self._dialog is None:
            return
        try:
            self._dialog.close()
        except Exception:
            pass
        self._dialog = None
        self._slots = []
        self._loaded = []

    # --- per-video state ----------------------------------------------
    def set_annotations(self, anns):
        """Replace the current annotation list (called on each new item)."""
        self._loaded = list(anns or [])
        # Hide everything immediately so a stale annotation from the
        # previous item never flashes onto the new one.
        for s in self._slots:
            s['bg'].setVisible(False)
            s['label'].setVisible(False)

    # --- per-tick render ----------------------------------------------
    def update(self, t):
        """Render the annotations whose [startTime, endTime] covers `t`.

        Designed to be called at the controller's monitor cadence
        (~4 Hz). With at most MAX_SLOTS visible controls and only field
        assignments per call, this stays well under 1 ms."""
        if not self._dialog:
            return
        if not self._loaded:
            return

        slot_idx = 0
        for ann in self._loaded:
            if slot_idx >= self.MAX_SLOTS:
                break
            try:
                start = float(ann.get('startTime') or 0)
                end = float(ann.get('endTime') or 0)
            except Exception:
                continue
            if not (start <= t <= end):
                continue
            self._apply_to_slot(self._slots[slot_idx], ann)
            slot_idx += 1

        # Hide unused slots
        for i in range(slot_idx, self.MAX_SLOTS):
            self._slots[i]['bg'].setVisible(False)
            self._slots[i]['label'].setVisible(False)

    # ------------------------------------------------------------------
    def _apply_to_slot(self, s, ann):
        box = ann.get('box') or {}
        bx = max(0.0, min(1.0, float(box.get('x', 0.35))))
        by = max(0.0, min(1.0, float(box.get('y', 0.4))))
        bw = max(0.04, min(1.0, float(box.get('w', 0.3))))
        bh = max(0.03, min(1.0, float(box.get('h', 0.12))))

        px = int(bx * self._screen_w)
        py = int(by * self._screen_h)
        pw = int(bw * self._screen_w)
        ph = int(bh * self._screen_h)

        style = ann.get('style') or {}
        bg_hex = style.get('bgColor') or '#000000'
        bg_op = style.get('bgOpacity', 80)
        fg_hex = style.get('textColor') or '#ffffff'
        font_size = style.get('fontSize') or 16

        s['bg'].setPosition(px, py)
        s['bg'].setWidth(pw)
        s['bg'].setHeight(ph)
        s['bg'].setColorDiffuse(_hex_to_argb(bg_hex, bg_op))
        s['bg'].setVisible(bool(self._tex))

        # Inset the label so text doesn't kiss the background border.
        pad = 10
        s['label'].setPosition(px + pad, py + pad)
        s['label'].setWidth(max(1, pw - 2 * pad))
        s['label'].setHeight(max(1, ph - 2 * pad))
        try:
            s['label'].setLabel(
                str(ann.get('text') or ''),
                font=_font_for_size(font_size),
                textColor=_hex_to_argb(fg_hex, 100),
            )
        except Exception:
            # Older Kodi labels don't accept font/textColor keyword args
            # on setLabel; fall back to plain text.
            s['label'].setLabel(str(ann.get('text') or ''))
        s['label'].setVisible(True)
