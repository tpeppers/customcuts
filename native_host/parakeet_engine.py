"""
NVIDIA Parakeet TDT Speech-to-Text Engine

Faster and more accurate than Whisper, designed for streaming/real-time use.
"""

import numpy as np
import base64
import tempfile
import os
import wave
from typing import Optional

# NeMo imports (lazy loaded)
nemo_asr = None
asr_model = None


class ParakeetEngine:
    """Wrapper for NVIDIA Parakeet TDT model."""

    def __init__(self, model_name: str = 'nvidia/parakeet-tdt-0.6b-v3', device: str = 'cuda'):
        """
        Initialize the Parakeet engine.

        Args:
            model_name: Parakeet model to use
            device: Device to run on ('cuda' or 'cpu')
        """
        global nemo_asr, asr_model

        self.device = device
        self.model_name = model_name
        self.sample_rate = 16000

        # Import NeMo
        import nemo.collections.asr as nemo_asr_module
        nemo_asr = nemo_asr_module

        # Load model
        print(f"Loading Parakeet model: {model_name}", flush=True)
        asr_model = nemo_asr.models.ASRModel.from_pretrained(model_name=model_name)

        # Move to device
        if device == 'cuda':
            asr_model = asr_model.cuda()

        # Set to eval mode
        asr_model.eval()

        self.model = asr_model
        print(f"Parakeet model loaded on {device}", flush=True)

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
            language: Language code (Parakeet auto-detects, so this is ignored)

        Returns:
            Dict with 'text' and 'language' keys
        """
        audio = self.decode_audio(audio_base64)

        # Parakeet needs audio as a file, so write to temp file
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
            temp_path = f.name
            # Write WAV file
            with wave.open(f, 'wb') as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)  # 16-bit
                wav.setframerate(self.sample_rate)
                wav.writeframes((audio * 32767).astype(np.int16).tobytes())

        try:
            # Transcribe
            output = self.model.transcribe([temp_path])
            text = output[0].text if hasattr(output[0], 'text') else str(output[0])

            return {
                'text': text.strip(),
                'language': 'auto'  # Parakeet auto-detects
            }
        finally:
            # Clean up temp file
            os.unlink(temp_path)

    def transcribe_with_segments(self, audio_base64: str, language: Optional[str] = 'en') -> dict:
        """
        Full transcription with segment-level timestamps.

        Args:
            audio_base64: Base64-encoded PCM16 audio at 16kHz
            language: Language code (ignored - Parakeet auto-detects)

        Returns:
            Dict with 'text', 'segments', and 'language' keys
        """
        audio = self.decode_audio(audio_base64)

        # Write to temp file
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
            temp_path = f.name
            with wave.open(f, 'wb') as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(self.sample_rate)
                wav.writeframes((audio * 32767).astype(np.int16).tobytes())

        try:
            # Transcribe with timestamps
            output = self.model.transcribe([temp_path], timestamps=True)

            result = output[0]
            text = result.text if hasattr(result, 'text') else str(result)

            # Extract segments from timestamps
            segments = []
            if hasattr(result, 'timestamp') and result.timestamp:
                # Use word-level timestamps grouped into segments
                if 'segment' in result.timestamp:
                    for seg in result.timestamp['segment']:
                        segments.append({
                            'start': seg['start'],
                            'end': seg['end'],
                            'text': seg['segment'].strip()
                        })
                elif 'word' in result.timestamp:
                    # Fall back to word timestamps, group into ~5 second segments
                    words = result.timestamp['word']
                    if words:
                        current_segment = {'start': words[0]['start'], 'words': [], 'end': 0}
                        for word in words:
                            current_segment['words'].append(word['word'])
                            current_segment['end'] = word['end']
                            # Start new segment every ~5 seconds
                            if word['end'] - current_segment['start'] >= 5.0:
                                segments.append({
                                    'start': current_segment['start'],
                                    'end': current_segment['end'],
                                    'text': ' '.join(current_segment['words']).strip()
                                })
                                if words.index(word) < len(words) - 1:
                                    next_word = words[words.index(word) + 1]
                                    current_segment = {'start': next_word['start'], 'words': [], 'end': 0}
                        # Add remaining words
                        if current_segment['words']:
                            segments.append({
                                'start': current_segment['start'],
                                'end': current_segment['end'],
                                'text': ' '.join(current_segment['words']).strip()
                            })

            # If no segments extracted, create one from full text
            if not segments and text.strip():
                duration = len(audio) / self.sample_rate
                segments.append({
                    'start': 0,
                    'end': duration,
                    'text': text.strip()
                })

            return {
                'text': text.strip(),
                'segments': segments,
                'language': 'auto'
            }
        finally:
            os.unlink(temp_path)


class StreamingParakeet:
    """Streaming wrapper that handles overlapping audio chunks for continuity."""

    def __init__(self, engine: ParakeetEngine, overlap_seconds: float = 1.0):
        """
        Initialize streaming Parakeet.

        Args:
            engine: ParakeetEngine instance
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
            language: Language code (ignored by Parakeet)

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
