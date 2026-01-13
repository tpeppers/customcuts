"""
Faster-Whisper Speech-to-Text Engine

Uses CTranslate2 for faster inference than OpenAI's Whisper.
"""

import numpy as np
import base64
from typing import Optional


class FasterWhisperEngine:
    """Wrapper for faster-whisper model."""

    def __init__(self, model_name: str = 'large-v3', device: str = 'cuda'):
        """
        Initialize the Faster-Whisper engine.

        Args:
            model_name: Whisper model size ('tiny', 'base', 'small', 'medium', 'large-v3', 'distil-large-v3')
            device: Device to run on ('cuda' or 'cpu')
        """
        from faster_whisper import WhisperModel

        self.device = device
        self.model_name = model_name
        self.sample_rate = 16000

        # Map device to compute_type
        if device == 'cuda':
            compute_type = 'float16'
        else:
            compute_type = 'int8'

        # Load model
        print(f"Loading Faster-Whisper model: {model_name} on {device}", flush=True)
        self.model = WhisperModel(model_name, device=device, compute_type=compute_type)
        print(f"Faster-Whisper model loaded", flush=True)

    def decode_audio(self, audio_base64: str) -> np.ndarray:
        """
        Decode base64 PCM16 audio to float32 numpy array.

        Args:
            audio_base64: Base64-encoded PCM16 audio at 16kHz

        Returns:
            Float32 numpy array normalized to [-1, 1]
        """
        audio_bytes = base64.b64decode(audio_base64)
        audio_int16 = np.frombuffer(audio_bytes, dtype=np.int16)
        audio_float32 = audio_int16.astype(np.float32) / 32768.0
        return audio_float32

    def transcribe_chunk(self, audio_base64: str, language: str = 'en') -> dict:
        """
        Transcribe a base64-encoded audio chunk.

        Args:
            audio_base64: Base64-encoded PCM16 audio at 16kHz
            language: Language code or 'auto' for detection

        Returns:
            Dict with 'text' and 'language' keys
        """
        audio = self.decode_audio(audio_base64)

        segments, info = self.model.transcribe(
            audio,
            language=None if language == 'auto' else language,
            beam_size=5,
            vad_filter=True
        )

        text = ' '.join(seg.text for seg in segments)

        return {
            'text': text.strip(),
            'language': info.language
        }

    def transcribe_with_segments(self, audio_base64: str, language: Optional[str] = 'en') -> dict:
        """
        Full transcription with segment-level timestamps.

        Args:
            audio_base64: Base64-encoded PCM16 audio at 16kHz
            language: Language code, 'auto' for detection, or None

        Returns:
            Dict with 'text', 'segments', and 'language' keys
        """
        audio = self.decode_audio(audio_base64)

        segments_gen, info = self.model.transcribe(
            audio,
            language=None if language == 'auto' else language,
            beam_size=5,
            vad_filter=True,
            word_timestamps=False
        )

        # Collect segments
        segments = []
        full_text = []
        for seg in segments_gen:
            segments.append({
                'start': seg.start,
                'end': seg.end,
                'text': seg.text.strip()
            })
            full_text.append(seg.text)

        return {
            'text': ' '.join(full_text).strip(),
            'segments': segments,
            'language': info.language
        }


class StreamingFasterWhisper:
    """Streaming wrapper that handles overlapping audio chunks for continuity."""

    def __init__(self, engine: FasterWhisperEngine, overlap_seconds: float = 2.0):
        """
        Initialize streaming Faster-Whisper.

        Args:
            engine: FasterWhisperEngine instance
            overlap_seconds: Seconds of overlap between chunks
        """
        self.engine = engine
        self.overlap_seconds = overlap_seconds
        self.sample_rate = 16000
        self.last_end_time = 0.0
        self.last_text = ""  # Track last text to avoid duplicates

    def process_chunk(self, audio_base64: str, chunk_start_time: float, language: str = 'en') -> list:
        """
        Process an audio chunk with overlap handling.

        Args:
            audio_base64: Base64-encoded PCM16 audio at 16kHz
            chunk_start_time: Video timestamp when this chunk started
            language: Language code or 'auto'

        Returns:
            List of segments with adjusted timestamps
        """
        # Transcribe the chunk directly (overlap is already included from offscreen.js)
        result = self.engine.transcribe_with_segments(audio_base64, language)

        # Adjust segment timestamps to video time
        # The chunk_start_time accounts for when the audio was captured
        adjusted_segments = []
        for seg in result['segments']:
            adjusted_start = chunk_start_time + seg['start']
            adjusted_end = chunk_start_time + seg['end']

            # Skip segments that are entirely within already-processed time
            # Use a small tolerance (0.5s) to handle overlap boundaries
            if adjusted_end > self.last_end_time + 0.3:
                # Check for duplicate text from overlap
                seg_text = seg['text'].strip()
                if seg_text and not self._is_duplicate(seg_text):
                    # Clamp start time to avoid going backwards
                    if adjusted_start < self.last_end_time:
                        adjusted_start = self.last_end_time

                    adjusted_segments.append({
                        'start': adjusted_start,
                        'end': adjusted_end,
                        'text': seg_text
                    })
                    self.last_end_time = adjusted_end
                    self.last_text = seg_text

        return adjusted_segments

    def _is_duplicate(self, text: str) -> bool:
        """Check if text is a duplicate of recent text (from overlap)."""
        if not self.last_text:
            return False

        # Check if the new text starts with the end of the last text
        # or if the last text ends with the start of the new text
        text_lower = text.lower().strip()
        last_lower = self.last_text.lower().strip()

        # If texts are very similar, it's likely a duplicate from overlap
        if text_lower == last_lower:
            return True

        # Check if there's significant overlap in the text content
        # Split into words and check for overlap
        text_words = text_lower.split()
        last_words = last_lower.split()

        if len(text_words) < 2 or len(last_words) < 2:
            return False

        # Check if the first few words of new text match the last few words of previous
        check_words = min(3, len(text_words), len(last_words))
        if text_words[:check_words] == last_words[-check_words:]:
            return True

        return False

    def reset(self):
        """Reset streaming state (e.g., on video seek)."""
        self.last_end_time = 0.0
        self.last_text = ""
