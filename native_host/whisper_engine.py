"""
Whisper Speech-to-Text Engine with GPU Optimization
"""

import whisper
import torch
import numpy as np
import base64
from typing import Optional


class WhisperEngine:
    """Wrapper for Whisper model with GPU optimization."""

    def __init__(self, model_name: str = 'large-v3', device: str = 'cuda'):
        """
        Initialize the Whisper engine.

        Args:
            model_name: Whisper model size ('tiny', 'base', 'small', 'medium', 'large', 'large-v3')
            device: Device to run on ('cuda' or 'cpu')
        """
        self.device = device
        self.model_name = model_name

        # Check CUDA availability
        if device == 'cuda' and not torch.cuda.is_available():
            import sys
            print("CUDA not available, falling back to CPU", file=sys.stderr, flush=True)
            self.device = 'cpu'

        # Load model
        self.model = whisper.load_model(model_name, device=self.device)

        # Enable FP16 for faster inference on GPU
        if self.device == 'cuda':
            self.model = self.model.half()

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

        # Pad or trim to 30 seconds (Whisper's expected input)
        audio = whisper.pad_or_trim(audio)

        # Create mel spectrogram
        mel = whisper.log_mel_spectrogram(audio).to(self.device)
        if self.device == 'cuda':
            mel = mel.half()

        # Detect language if needed
        if language == 'auto':
            _, probs = self.model.detect_language(mel)
            language = max(probs, key=probs.get)

        # Decode
        options = whisper.DecodingOptions(
            language=language,
            fp16=(self.device == 'cuda'),
            without_timestamps=False
        )
        result = whisper.decode(self.model, mel, options)

        return {
            'text': result.text,
            'language': language
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

        result = self.model.transcribe(
            audio,
            language=None if language == 'auto' else language,
            fp16=(self.device == 'cuda'),
            word_timestamps=False,  # Segment-level is faster
            verbose=False
        )

        # Format segments
        segments = []
        for seg in result.get('segments', []):
            segments.append({
                'start': seg['start'],
                'end': seg['end'],
                'text': seg['text'].strip()
            })

        return {
            'text': result['text'].strip(),
            'segments': segments,
            'language': result.get('language', language)
        }


class StreamingWhisper:
    """Streaming wrapper that handles overlapping audio chunks for continuity."""

    def __init__(self, engine: WhisperEngine, overlap_seconds: float = 2.0):
        """
        Initialize streaming Whisper.

        Args:
            engine: WhisperEngine instance
            overlap_seconds: Seconds of overlap between chunks
        """
        self.engine = engine
        self.overlap_seconds = overlap_seconds
        self.sample_rate = 16000
        self.pending_audio = np.array([], dtype=np.float32)
        self.last_end_time = 0.0

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
        # Decode new audio
        new_audio = self.engine.decode_audio(audio_base64)

        # Calculate overlap samples
        overlap_samples = int(self.sample_rate * self.overlap_seconds)

        # Combine with pending audio (keep overlap from previous chunk)
        if len(self.pending_audio) > 0:
            combined_audio = np.concatenate([
                self.pending_audio[-overlap_samples:] if len(self.pending_audio) >= overlap_samples else self.pending_audio,
                new_audio
            ])
            # Adjust start time for overlap
            effective_start_time = chunk_start_time - self.overlap_seconds
        else:
            combined_audio = new_audio
            effective_start_time = chunk_start_time

        # Store for next chunk's overlap
        self.pending_audio = new_audio

        # Encode combined audio
        audio_int16 = (combined_audio * 32767).astype(np.int16)
        audio_base64_combined = base64.b64encode(audio_int16.tobytes()).decode('utf-8')

        # Transcribe
        result = self.engine.transcribe_with_segments(audio_base64_combined, language)

        # Adjust segment timestamps to video time
        adjusted_segments = []
        for seg in result['segments']:
            adjusted_start = effective_start_time + seg['start']
            adjusted_end = effective_start_time + seg['end']

            # Skip segments that overlap with previously returned segments
            if adjusted_start >= self.last_end_time:
                adjusted_segments.append({
                    'start': adjusted_start,
                    'end': adjusted_end,
                    'text': seg['text']
                })
                self.last_end_time = adjusted_end

        return adjusted_segments

    def reset(self):
        """Reset streaming state (e.g., on video seek)."""
        self.pending_audio = np.array([], dtype=np.float32)
        self.last_end_time = 0.0
