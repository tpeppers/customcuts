"""
Audio Pattern Detection Engine

Provides fingerprinting (Chromaprint) and embedding (PANNs) for audio pattern detection.
Designed to run alongside Faster-Whisper transcription.
"""

import base64
import struct
import numpy as np
from typing import List, Dict, Optional, Tuple
import sys


class PatternEngine:
    """
    Main pattern detection engine with lazy-loaded models.
    Supports both exact matching (Chromaprint) and semantic matching (PANNs).
    """

    def __init__(self, device: str = 'cuda'):
        self.device = device
        self._chromaprint = None
        self._panns_model = None
        self._panns_loaded = False

    def _load_chromaprint(self):
        """Lazy load Chromaprint for exact fingerprinting."""
        if self._chromaprint is not None:
            return

        try:
            import acoustid
            import chromaprint
            self._chromaprint = chromaprint
            self._acoustid = acoustid
            print("[Pattern] Chromaprint loaded", file=sys.stderr)
        except ImportError as e:
            print(f"[Pattern] Chromaprint not available: {e}", file=sys.stderr)
            self._chromaprint = False  # Mark as unavailable

    def _load_panns(self):
        """Lazy load PANNs model for semantic embeddings."""
        if self._panns_loaded:
            return

        try:
            from panns_inference import AudioTagging
            self._panns_model = AudioTagging(
                checkpoint_path=None,  # Use default checkpoint
                device=self.device
            )
            self._panns_loaded = True
            print(f"[Pattern] PANNs loaded on {self.device}", file=sys.stderr)
        except ImportError as e:
            print(f"[Pattern] PANNs not available: {e}", file=sys.stderr)
            self._panns_model = None
            self._panns_loaded = True  # Mark as attempted
        except Exception as e:
            print(f"[Pattern] PANNs load error: {e}", file=sys.stderr)
            self._panns_model = None
            self._panns_loaded = True

    def decode_audio(self, audio_base64: str) -> np.ndarray:
        """
        Decode base64 PCM16 audio to float32 array.
        Input: base64 encoded PCM16 at 16kHz
        Output: float32 array in range [-1, 1]
        """
        audio_bytes = base64.b64decode(audio_base64)
        pcm16 = np.frombuffer(audio_bytes, dtype=np.int16)
        audio_float = pcm16.astype(np.float32) / 32768.0
        return audio_float

    def fingerprint(self, audio: np.ndarray, sample_rate: int = 16000) -> Optional[List[int]]:
        """
        Generate Chromaprint fingerprint from audio.

        Args:
            audio: Float32 audio array
            sample_rate: Sample rate (default 16kHz)

        Returns:
            List of int32 fingerprint values, or None if unavailable
        """
        self._load_chromaprint()

        if self._chromaprint is False or self._chromaprint is None:
            return None

        try:
            # Convert to int16 for chromaprint
            audio_int16 = (audio * 32767).astype(np.int16)

            # Generate fingerprint
            # chromaprint expects raw bytes
            fp_raw = self._chromaprint.decode_fingerprint(
                self._chromaprint.encode_fingerprint(
                    self._chromaprint.calc_fingerprint(
                        audio_int16.tobytes(),
                        sample_rate,
                        1  # mono
                    ),
                    1  # algorithm version
                ),
                1
            )

            if fp_raw:
                return list(fp_raw[0])
            return None

        except Exception as e:
            print(f"[Pattern] Fingerprint error: {e}", file=sys.stderr)
            return None

    def fingerprint_raw(self, audio: np.ndarray, sample_rate: int = 16000) -> Optional[bytes]:
        """
        Generate raw fingerprint bytes for direct comparison.
        Alternative method using fpcalc if available.
        """
        self._load_chromaprint()

        if self._chromaprint is False:
            return None

        try:
            # Convert to int16
            audio_int16 = (audio * 32767).astype(np.int16)

            # Get raw fingerprint
            fp = self._chromaprint.calc_fingerprint(
                audio_int16.tobytes(),
                sample_rate,
                1  # mono
            )
            return fp

        except Exception as e:
            print(f"[Pattern] Raw fingerprint error: {e}", file=sys.stderr)
            return None

    def embed(self, audio: np.ndarray, sample_rate: int = 16000) -> Optional[np.ndarray]:
        """
        Generate PANNs embedding from audio.

        Args:
            audio: Float32 audio array at any sample rate
            sample_rate: Input sample rate

        Returns:
            2048-dim float32 embedding array, or None if unavailable
        """
        self._load_panns()

        if self._panns_model is None:
            return None

        try:
            # PANNs expects 32kHz audio
            if sample_rate != 32000:
                # Simple resampling via interpolation
                target_length = int(len(audio) * 32000 / sample_rate)
                audio_32k = np.interp(
                    np.linspace(0, len(audio), target_length),
                    np.arange(len(audio)),
                    audio
                ).astype(np.float32)
            else:
                audio_32k = audio

            # PANNs expects (batch, samples) shape
            audio_batch = audio_32k[np.newaxis, :]

            # Get embedding (clipwise_output and embedding)
            _, embedding = self._panns_model.inference(audio_batch)

            # Return first (and only) embedding
            return embedding[0]

        except Exception as e:
            print(f"[Pattern] Embedding error: {e}", file=sys.stderr)
            return None

    def quantize_embedding(self, embedding: np.ndarray) -> List[int]:
        """
        Quantize float32 embedding to int8 for storage.
        Reduces storage from 8KB to 2KB per embedding.
        """
        # Normalize to [-1, 1] range
        max_val = np.abs(embedding).max()
        if max_val > 0:
            normalized = embedding / max_val
        else:
            normalized = embedding

        # Quantize to int8 range [-127, 127]
        quantized = (normalized * 127).astype(np.int8)
        return quantized.tolist()

    def dequantize_embedding(self, quantized: List[int]) -> np.ndarray:
        """
        Restore float32 from quantized int8 embedding.
        """
        return np.array(quantized, dtype=np.float32) / 127.0

    def match_fingerprint(
        self,
        fp1: List[int],
        fp2: List[int],
        max_offset: int = 50
    ) -> Tuple[float, int]:
        """
        Compare two fingerprints and return similarity score and offset.

        Args:
            fp1: First fingerprint
            fp2: Second fingerprint (reference pattern)
            max_offset: Maximum offset to search (in fingerprint frames)

        Returns:
            Tuple of (similarity score 0-1, best offset in frames)
        """
        if not fp1 or not fp2:
            return 0.0, 0

        fp1_arr = np.array(fp1, dtype=np.int32)
        fp2_arr = np.array(fp2, dtype=np.int32)

        best_score = 0.0
        best_offset = 0

        # Try different offsets
        for offset in range(-max_offset, max_offset + 1):
            if offset < 0:
                f1 = fp1_arr[-offset:]
                f2 = fp2_arr[:len(f1)]
            else:
                f1 = fp1_arr[:len(fp1_arr) - offset] if offset > 0 else fp1_arr
                f2 = fp2_arr[offset:offset + len(f1)]

            # Ensure same length
            min_len = min(len(f1), len(f2))
            if min_len == 0:
                continue

            f1 = f1[:min_len]
            f2 = f2[:min_len]

            # Calculate bit similarity using XOR and popcount
            xor = np.bitwise_xor(f1, f2)

            # Count matching bits
            # Each int32 has 32 bits, count differing bits
            diff_bits = 0
            for x in xor:
                diff_bits += bin(x).count('1')

            total_bits = min_len * 32
            similarity = 1.0 - (diff_bits / total_bits)

            if similarity > best_score:
                best_score = similarity
                best_offset = offset

        return best_score, best_offset

    def cosine_similarity(self, emb1: np.ndarray, emb2: np.ndarray) -> float:
        """
        Calculate cosine similarity between two embeddings.
        """
        norm1 = np.linalg.norm(emb1)
        norm2 = np.linalg.norm(emb2)

        if norm1 == 0 or norm2 == 0:
            return 0.0

        return float(np.dot(emb1, emb2) / (norm1 * norm2))


class PatternDetector:
    """
    Real-time pattern detection during playback.
    Tracks consecutive matches for minimum duration requirements.
    """

    def __init__(self, engine: PatternEngine, patterns: List[Dict]):
        self.engine = engine
        self.patterns = patterns
        self.consecutive_matches: Dict[str, Dict] = {}  # pattern_id -> match state
        self.min_match_duration = 2.0  # Minimum seconds of consecutive matches

    def set_patterns(self, patterns: List[Dict]):
        """Update the list of patterns to detect."""
        self.patterns = patterns
        self.consecutive_matches.clear()

    def process_chunk(
        self,
        audio_base64: str,
        timestamp: float
    ) -> List[Dict]:
        """
        Process audio chunk and return detections.

        Args:
            audio_base64: Base64 encoded PCM16 audio
            timestamp: Video timestamp for this chunk

        Returns:
            List of detection results with pattern info and confidence
        """
        if not self.patterns:
            return []

        audio = self.engine.decode_audio(audio_base64)
        detections = []

        # Phase 1: Exact fingerprint matching (fast path)
        exact_patterns = [p for p in self.patterns if p.get('type') == 'exact']
        if exact_patterns:
            chunk_fp = self.engine.fingerprint(audio)
            if chunk_fp:
                for pattern in exact_patterns:
                    pattern_fp = pattern.get('fingerprint')
                    if pattern_fp:
                        score, offset = self.engine.match_fingerprint(chunk_fp, pattern_fp)
                        if score > 0.8:  # High threshold for exact match
                            detections.append({
                                'pattern_id': pattern['id'],
                                'pattern_name': pattern.get('name', 'Unknown'),
                                'pattern_duration': pattern.get('duration', 0),
                                'confidence': score,
                                'offset': offset,
                                'method': 'fingerprint',
                                'timestamp': timestamp
                            })

        # Phase 2: Semantic embedding matching
        semantic_patterns = [p for p in self.patterns if p.get('type') == 'semantic']
        if semantic_patterns:
            chunk_emb = self.engine.embed(audio)
            if chunk_emb is not None:
                for pattern in semantic_patterns:
                    pattern_emb = pattern.get('embedding')
                    if pattern_emb:
                        # Dequantize if stored as int8
                        if isinstance(pattern_emb[0], int):
                            pattern_emb = self.engine.dequantize_embedding(pattern_emb)
                        else:
                            pattern_emb = np.array(pattern_emb)

                        similarity = self.engine.cosine_similarity(chunk_emb, pattern_emb)
                        threshold = pattern.get('threshold', 0.85)

                        if similarity > threshold:
                            detections.append({
                                'pattern_id': pattern['id'],
                                'pattern_name': pattern.get('name', 'Unknown'),
                                'pattern_duration': pattern.get('duration', 0),
                                'confidence': similarity,
                                'offset': 0,
                                'method': 'embedding',
                                'timestamp': timestamp
                            })

        # Update consecutive match tracking
        self._update_consecutive_matches(detections, timestamp)

        return detections

    def _update_consecutive_matches(self, detections: List[Dict], timestamp: float):
        """Track consecutive detections for minimum duration requirement."""
        detected_ids = {d['pattern_id'] for d in detections}

        for pattern_id in list(self.consecutive_matches.keys()):
            if pattern_id not in detected_ids:
                # Pattern no longer detected, clear tracking
                del self.consecutive_matches[pattern_id]

        for detection in detections:
            pattern_id = detection['pattern_id']
            if pattern_id not in self.consecutive_matches:
                self.consecutive_matches[pattern_id] = {
                    'start_time': timestamp,
                    'last_time': timestamp,
                    'detection': detection
                }
            else:
                self.consecutive_matches[pattern_id]['last_time'] = timestamp
                self.consecutive_matches[pattern_id]['detection'] = detection

    def get_confirmed_detections(self, timestamp: float) -> List[Dict]:
        """
        Get patterns that have been detected for minimum duration.
        """
        confirmed = []

        for pattern_id, match_state in self.consecutive_matches.items():
            duration = match_state['last_time'] - match_state['start_time']
            if duration >= self.min_match_duration:
                detection = match_state['detection'].copy()
                detection['confirmed'] = True
                detection['match_duration'] = duration
                detection['match_start'] = match_state['start_time']
                confirmed.append(detection)

        return confirmed

    def reset(self):
        """Reset detection state (e.g., on video seek)."""
        self.consecutive_matches.clear()
