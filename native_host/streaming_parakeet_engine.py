"""
NVIDIA Parakeet Streaming Engine with Cache-Aware API

True streaming transcription with ~500ms latency using NeMo's conformer_stream_step() API.
"""

import numpy as np
import base64
import torch
from typing import Optional, List, Dict, Tuple

# NeMo imports (lazy loaded)
nemo_asr = None


class StreamingParakeetEngine:
    """
    Streaming transcription engine using NeMo's cache-aware conformer API.

    Supports three latency modes:
    - 'low': ~80ms latency, less accurate
    - 'medium': ~560ms latency, balanced (DEFAULT)
    - 'high': ~1.12s latency, most accurate
    """

    # Latency mode configurations (att_context_size: [left_context, right_context])
    LATENCY_CONFIGS = {
        'low': [70, 0],      # ~80ms latency
        'medium': [70, 6],   # ~560ms latency (DEFAULT)
        'high': [70, 13],    # ~1.12s latency
    }

    # Chunk size in samples (at 16kHz) for processing
    CHUNK_SAMPLES = 8000  # 500ms chunks

    def __init__(
        self,
        model_name: str = 'nvidia/parakeet-tdt-0.6b-v3',
        device: str = 'cuda',
        latency_mode: str = 'medium'
    ):
        """
        Initialize the streaming Parakeet engine.

        Args:
            model_name: Parakeet model to use
            device: Device to run on ('cuda' or 'cpu')
            latency_mode: 'low', 'medium', or 'high' for latency/accuracy trade-off
        """
        global nemo_asr

        self.device = device
        self.model_name = model_name
        self.sample_rate = 16000
        self.latency_mode = latency_mode

        # Import NeMo
        import nemo.collections.asr as nemo_asr_module
        nemo_asr = nemo_asr_module

        # Load model
        print(f"Loading streaming Parakeet model: {model_name}", flush=True)
        self.model = nemo_asr.models.ASRModel.from_pretrained(model_name=model_name)

        # Move to device
        if device == 'cuda':
            self.model = self.model.cuda()

        # Set to eval mode
        self.model.eval()

        # Configure streaming parameters
        att_context_size = self.LATENCY_CONFIGS.get(latency_mode, self.LATENCY_CONFIGS['medium'])
        self.att_context_size = att_context_size

        # Initialize cache state
        self._reset_cache_state()

        # Buffer for incomplete frames
        self.audio_buffer = np.array([], dtype=np.float32)

        # Sequence tracking
        self.sequence_id = 0
        self.last_finalized_time = 0.0

        # Partial/interim result tracking
        self.interim_text = ""
        self.finalized_text = ""

        print(f"Streaming Parakeet ready (latency_mode={latency_mode}, att_context={att_context_size})", flush=True)

    def _reset_cache_state(self):
        """Reset the encoder cache state for a new streaming session."""
        # Cache state for transformer layers
        self.cache_state = None
        self.cache_last_channel = None
        self.cache_last_time = None

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

    def process_streaming_chunk(
        self,
        audio_base64: str,
        timestamp: float,
        sequence_id: int
    ) -> Dict:
        """
        Process a streaming audio chunk and return interim/final results.

        Args:
            audio_base64: Base64-encoded PCM16 audio at 16kHz
            timestamp: Video timestamp for this chunk
            sequence_id: Sequence number for ordering

        Returns:
            Dict with:
            - 'interim_text': Partial transcription (may change)
            - 'final_text': Finalized transcription (won't change)
            - 'final_segments': List of finalized segments with timestamps
            - 'is_final': Whether this chunk produced final output
        """
        # Decode audio
        new_audio = self.decode_audio(audio_base64)

        # Add to buffer
        self.audio_buffer = np.concatenate([self.audio_buffer, new_audio])

        # Process complete chunks
        results = {
            'interim_text': '',
            'final_text': '',
            'final_segments': [],
            'is_final': False
        }

        # Process in CHUNK_SAMPLES increments
        while len(self.audio_buffer) >= self.CHUNK_SAMPLES:
            chunk = self.audio_buffer[:self.CHUNK_SAMPLES]
            self.audio_buffer = self.audio_buffer[self.CHUNK_SAMPLES:]

            # Process this chunk through the model
            chunk_result = self._process_chunk_internal(chunk, timestamp)

            # Accumulate results
            if chunk_result.get('interim_text'):
                results['interim_text'] = chunk_result['interim_text']
            if chunk_result.get('final_text'):
                results['final_text'] += chunk_result['final_text'] + ' '
                results['is_final'] = True
            if chunk_result.get('final_segments'):
                results['final_segments'].extend(chunk_result['final_segments'])

            # Advance timestamp
            timestamp += self.CHUNK_SAMPLES / self.sample_rate

        results['final_text'] = results['final_text'].strip()
        return results

    def _process_chunk_internal(self, audio_chunk: np.ndarray, timestamp: float) -> Dict:
        """
        Internal method to process a single audio chunk through the streaming model.

        Uses the cache-aware streaming API for low-latency processing.
        """
        try:
            # Convert to tensor
            audio_tensor = torch.from_numpy(audio_chunk).unsqueeze(0)
            if self.device == 'cuda':
                audio_tensor = audio_tensor.cuda()

            # Length tensor
            audio_len = torch.tensor([len(audio_chunk)], dtype=torch.long)
            if self.device == 'cuda':
                audio_len = audio_len.cuda()

            with torch.no_grad():
                # Check if model supports streaming
                if hasattr(self.model, 'conformer_stream_step'):
                    # Use cache-aware streaming API
                    output, self.cache_state = self.model.conformer_stream_step(
                        audio_tensor,
                        audio_len,
                        cache_state=self.cache_state,
                        att_context_size=self.att_context_size
                    )

                    # Decode output
                    if hasattr(self.model, 'decoding') and hasattr(self.model.decoding, 'ctc_decoder_predictions_tensor'):
                        hypotheses = self.model.decoding.ctc_decoder_predictions_tensor(
                            output,
                            decoder_lengths=None,
                            return_hypotheses=False
                        )
                        text = hypotheses[0] if hypotheses else ""
                    else:
                        # Fallback: use greedy decoding on logits
                        log_probs = output.log_softmax(dim=-1)
                        pred_ids = log_probs.argmax(dim=-1)
                        text = self._decode_ids(pred_ids[0])
                else:
                    # Model doesn't support streaming - fall back to batch mode
                    # This gives us partial results but with higher latency
                    output = self.model.transcribe_audio(audio_tensor, audio_len)
                    text = output[0] if output else ""

            # Determine if this is interim or final
            # For now, treat everything as interim until we have silence detection
            # or a finalization signal
            chunk_duration = len(audio_chunk) / self.sample_rate

            return {
                'interim_text': text.strip() if text else '',
                'final_text': '',
                'final_segments': []
            }

        except Exception as e:
            print(f"Streaming chunk error: {e}", flush=True)
            import traceback
            traceback.print_exc()
            return {'interim_text': '', 'final_text': '', 'final_segments': []}

    def _decode_ids(self, ids: torch.Tensor) -> str:
        """Decode token IDs to text using the model's tokenizer."""
        try:
            if hasattr(self.model, 'tokenizer'):
                # Filter out blank tokens (usually index 0 or a special value)
                ids_list = ids.cpu().tolist()
                # Remove consecutive duplicates (CTC collapse)
                collapsed = []
                prev = None
                for id in ids_list:
                    if id != prev and id != 0:  # Assuming 0 is blank
                        collapsed.append(id)
                    prev = id
                return self.model.tokenizer.ids_to_text(collapsed)
            return ""
        except:
            return ""

    def finalize_stream(self, timestamp: float) -> Dict:
        """
        Finalize the current streaming session.

        Called when the user stops transcription or seeks.
        Returns any remaining buffered audio as final output.

        Args:
            timestamp: Current video timestamp

        Returns:
            Dict with final_text and final_segments
        """
        results = {
            'final_text': '',
            'final_segments': []
        }

        # Process any remaining buffered audio
        if len(self.audio_buffer) > 0:
            # Pad to minimum chunk size if needed
            if len(self.audio_buffer) < self.CHUNK_SAMPLES:
                padding = np.zeros(self.CHUNK_SAMPLES - len(self.audio_buffer), dtype=np.float32)
                chunk = np.concatenate([self.audio_buffer, padding])
            else:
                chunk = self.audio_buffer

            chunk_result = self._process_chunk_internal(chunk[:self.CHUNK_SAMPLES], timestamp)

            if chunk_result.get('interim_text'):
                # Convert interim to final
                results['final_text'] = chunk_result['interim_text']
                results['final_segments'] = [{
                    'start': timestamp,
                    'end': timestamp + len(self.audio_buffer) / self.sample_rate,
                    'text': chunk_result['interim_text']
                }]

        # Clear buffer
        self.audio_buffer = np.array([], dtype=np.float32)

        return results

    def reset_cache(self):
        """Reset encoder cache state on video seek or session reset."""
        self._reset_cache_state()
        self.audio_buffer = np.array([], dtype=np.float32)
        self.interim_text = ""
        self.finalized_text = ""
        self.last_finalized_time = 0.0
        print("Streaming cache reset", flush=True)

    def get_status(self) -> Dict:
        """Get current streaming engine status."""
        return {
            'model': self.model_name,
            'device': self.device,
            'latency_mode': self.latency_mode,
            'buffer_samples': len(self.audio_buffer),
            'buffer_duration_ms': int(len(self.audio_buffer) / self.sample_rate * 1000),
            'has_cache': self.cache_state is not None
        }


class FallbackStreamingEngine:
    """
    Fallback streaming engine for when NeMo streaming isn't available.

    Uses batch processing with small chunks to approximate streaming behavior.
    """

    def __init__(self, batch_engine):
        """
        Initialize with a batch engine (ParakeetEngine or FasterWhisperEngine).

        Args:
            batch_engine: Batch transcription engine with transcribe_with_segments method
        """
        self.engine = batch_engine
        self.sample_rate = 16000
        self.audio_buffer = np.array([], dtype=np.float32)
        self.last_text = ""
        self.min_chunk_duration = 2.0  # Minimum seconds before processing

    def process_streaming_chunk(
        self,
        audio_base64: str,
        timestamp: float,
        sequence_id: int
    ) -> Dict:
        """Process chunk using batch engine with accumulated buffer."""
        # Decode and accumulate
        new_audio = self.engine.decode_audio(audio_base64)
        self.audio_buffer = np.concatenate([self.audio_buffer, new_audio])

        buffer_duration = len(self.audio_buffer) / self.sample_rate

        results = {
            'interim_text': '',
            'final_text': '',
            'final_segments': [],
            'is_final': False
        }

        # Process when we have enough audio
        if buffer_duration >= self.min_chunk_duration:
            # Encode buffer for batch processing
            audio_int16 = (self.audio_buffer * 32767).astype(np.int16)
            audio_b64 = base64.b64encode(audio_int16.tobytes()).decode('utf-8')

            # Transcribe
            result = self.engine.transcribe_with_segments(audio_b64)

            if result.get('text'):
                text = result['text'].strip()

                # Check if this is new content
                if text != self.last_text:
                    results['final_text'] = text
                    results['is_final'] = True
                    self.last_text = text

                    # Adjust segment timestamps
                    for seg in result.get('segments', []):
                        results['final_segments'].append({
                            'start': timestamp + seg['start'],
                            'end': timestamp + seg['end'],
                            'text': seg['text']
                        })

            # Keep a small overlap for continuity
            overlap_samples = int(0.5 * self.sample_rate)
            self.audio_buffer = self.audio_buffer[-overlap_samples:]

        return results

    def reset_cache(self):
        """Reset state."""
        self.audio_buffer = np.array([], dtype=np.float32)
        self.last_text = ""

    def finalize_stream(self, timestamp: float) -> Dict:
        """Finalize any remaining audio."""
        results = {'final_text': '', 'final_segments': []}

        if len(self.audio_buffer) > self.sample_rate * 0.5:  # At least 0.5s
            audio_int16 = (self.audio_buffer * 32767).astype(np.int16)
            audio_b64 = base64.b64encode(audio_int16.tobytes()).decode('utf-8')

            result = self.engine.transcribe_with_segments(audio_b64)

            if result.get('text'):
                results['final_text'] = result['text'].strip()
                for seg in result.get('segments', []):
                    results['final_segments'].append({
                        'start': timestamp + seg['start'],
                        'end': timestamp + seg['end'],
                        'text': seg['text']
                    })

        self.audio_buffer = np.array([], dtype=np.float32)
        return results
