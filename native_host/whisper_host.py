#!/usr/bin/env python3
"""
CustomCuts Whisper Native Messaging Host

This script handles communication between the Chrome extension and the Whisper
speech-to-text engine via Chrome's Native Messaging protocol.
"""

# Immediately set up logging before any other imports
import sys
import os

# Windows requires binary mode for stdin/stdout with native messaging
if sys.platform == 'win32':
    import msvcrt
    # Set binary mode for stdin/stdout
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

# Use Python's standard I/O (works on all platforms with binary mode set)
def _native_read(n):
    """Read exactly n bytes from stdin."""
    data = sys.stdin.buffer.read(n)
    return data if data else b''

def _native_write(data):
    """Write data to stdout."""
    try:
        written = sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
        return written == len(data)
    except Exception:
        return False

# Set up logging to file for debugging - use absolute path
_script_dir = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(_script_dir, 'whisper_host.log')

# Log levels: 0=ERROR, 1=WARN, 2=INFO, 3=DEBUG
LOG_LEVEL = 2  # Default to INFO

# Lock for thread-safe stdout writes
import threading
_stdout_lock = threading.Lock()

def log(message, level=2):
    """Log a message if level <= LOG_LEVEL. Levels: 0=ERROR, 1=WARN, 2=INFO, 3=DEBUG"""
    if level > LOG_LEVEL:
        return
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            import datetime
            timestamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            prefix = ['ERROR', 'WARN', 'INFO', 'DEBUG'][level]
            f.write(f"[{timestamp}] [{prefix}] {message}\n")
            f.flush()
    except Exception as e:
        sys.stderr.write(f"Log error: {e}\n")

log("=== Whisper host starting ===")
log(f"Python: {sys.executable}", 3)
log(f"Script dir: {_script_dir}", 3)

# Now import other modules
try:
    import struct
    import json
    import threading
    import queue
    import traceback
    from typing import Optional
    log("Standard imports OK", 3)
except Exception as e:
    log(f"Import error: {e}", 0)
    raise

# Import speech engine (lazy load to speed up startup)
# Supports Whisper, Faster-Whisper, and Parakeet engines
speech_engine = None
streaming_engine = None
_engine_type = 'faster-whisper'  # 'whisper', 'faster-whisper', or 'parakeet'


def read_native_message() -> Optional[dict]:
    """
    Read a message from Chrome extension via stdin.

    Chrome's native messaging protocol:
    - First 4 bytes: message length (little-endian uint32)
    - Remaining bytes: UTF-8 encoded JSON
    """
    try:
        # Read message length (4 bytes, little-endian)
        raw_length = _native_read(4)
        if not raw_length or len(raw_length) < 4:
            log("Connection closed", 3)
            return None

        message_length = struct.unpack('<I', raw_length)[0]

        # Sanity check message length (max 1MB)
        if message_length > 1024 * 1024:
            log(f"Message too large: {message_length}", 1)
            return None

        # Read message content
        message_data = _native_read(message_length)
        if len(message_data) < message_length:
            log(f"Incomplete message data", 1)
            return None

        msg = json.loads(message_data.decode('utf-8'))
        msg_type = msg.get('type', 'unknown')
        if msg_type not in ('ping',):  # Don't log pings
            log(f"Received: {msg_type}", 3)
        return msg

    except Exception as e:
        log(f"read_native_message error: {e}", 0)
        log(traceback.format_exc(), 0)
        return None


def send_native_message(message: dict) -> None:
    """
    Send a message to Chrome extension via stdout.

    Chrome's native messaging protocol:
    - First 4 bytes: message length (little-endian uint32)
    - Remaining bytes: UTF-8 encoded JSON
    """
    try:
        msg_type = message.get('type', 'unknown')

        # Encode to JSON
        json_str = json.dumps(message)
        encoded = json_str.encode('utf-8')

        # Create length prefix
        length_prefix = struct.pack('<I', len(encoded))
        data = length_prefix + encoded

        # Write with lock
        with _stdout_lock:
            success = _native_write(data)

        if not success:
            log(f"Failed to send {msg_type}", 0)
        elif msg_type not in ('pong', 'heartbeat'):  # Don't log routine messages
            log(f"Sent: {msg_type}", 3)

    except Exception as e:
        log(f"send_native_message error: {e}", 0)
        log(traceback.format_exc(), 0)


_init_model = None
_init_device = None
_init_thread = None
_init_error = None

def _background_load_engine():
    """Load speech engine in background thread."""
    global speech_engine, streaming_engine, _init_error, _engine_type
    import io
    import time

    # Wait a moment to ensure ready message is sent before we touch stdout
    time.sleep(0.5)

    # Redirect stdout to prevent any prints from corrupting native messaging
    old_stdout = sys.stdout
    captured_output = io.StringIO()

    try:
        log(f"Loading {_engine_type} model: {_init_model} on {_init_device}")

        # Redirect stdout for the import and init
        sys.stdout = captured_output

        if _engine_type == 'parakeet':
            from parakeet_engine import ParakeetEngine, StreamingParakeet
            speech_engine = ParakeetEngine(model_name=_init_model, device=_init_device)
            streaming_engine = StreamingParakeet(speech_engine)
        elif _engine_type == 'faster-whisper':
            from faster_whisper_engine import FasterWhisperEngine, StreamingFasterWhisper
            speech_engine = FasterWhisperEngine(model_name=_init_model, device=_init_device)
            streaming_engine = StreamingFasterWhisper(speech_engine)
        else:
            from whisper_engine import WhisperEngine, StreamingWhisper
            speech_engine = WhisperEngine(model_name=_init_model, device=_init_device)
            streaming_engine = StreamingWhisper(speech_engine)

        # Restore stdout before logging success
        sys.stdout = old_stdout
        log(f"{_engine_type} loaded successfully")

        # Log any captured output at debug level
        captured = captured_output.getvalue()
        if captured:
            log(f"Captured stdout: {captured[:200]}", 3)
    except Exception as e:
        sys.stdout = old_stdout
        _init_error = str(e)
        log(f"{_engine_type} load error: {e}", 0)
        log(traceback.format_exc(), 0)

def handle_init(message: dict) -> dict:
    """Handle initialization request - start loading speech engine in background."""
    global _init_model, _init_device, _init_thread, _engine_type

    _engine_type = message.get('engine', 'faster-whisper')  # 'whisper', 'faster-whisper', or 'parakeet'

    # Set default model based on engine type
    if _engine_type == 'parakeet':
        _init_model = message.get('model', 'nvidia/parakeet-tdt-0.6b-v3')
    else:
        # Both whisper and faster-whisper use the same model names
        _init_model = message.get('model', 'large-v3')

    _init_device = message.get('device', 'cuda')

    # Start loading in background thread
    _init_thread = threading.Thread(target=_background_load_engine, daemon=True)
    _init_thread.start()

    log(f"Init: engine={_engine_type}, model={_init_model}, device={_init_device}", 3)

    # Return ready immediately - transcription will wait for model
    return {
        'type': 'ready',
        'engine': _engine_type,
        'model': _init_model,
        'device': _init_device,
        'status': 'loading'  # Indicate still loading
    }


_transcribe_queue = queue.Queue()
_transcribe_thread = None

def _transcription_worker():
    """Background worker for transcription."""
    global streaming_engine, _init_thread, _init_error

    while True:
        try:
            task = _transcribe_queue.get(timeout=1)
            if task is None:  # Shutdown signal
                break

            message, chunk_id = task

            # Wait for Whisper if still loading
            if _init_thread is not None and _init_thread.is_alive():
                log("Waiting for Whisper to load...", 3)
                _init_thread.join(timeout=60)

            if _init_error is not None:
                send_native_message({
                    'type': 'error',
                    'message': f'Whisper initialization failed: {_init_error}',
                    'chunkId': chunk_id
                })
                continue

            if streaming_engine is None:
                send_native_message({
                    'type': 'error',
                    'message': 'Engine not initialized',
                    'chunkId': chunk_id
                })
                continue

            # Process transcription
            audio_base64 = message.get('audio', '')
            timestamp = message.get('timestamp', 0)
            language = message.get('language', 'en')

            log(f"Processing chunk {chunk_id}", 3)
            segments = streaming_engine.process_chunk(audio_base64, timestamp, language)
            full_text = ' '.join(seg['text'] for seg in segments)

            if full_text.strip():
                log(f"Transcription: {full_text[:80]}")
            send_native_message({
                'type': 'transcription',
                'chunkId': chunk_id,
                'text': full_text,
                'segments': segments,
                'timestamp': timestamp
            })

        except queue.Empty:
            continue
        except Exception as e:
            log(f"Worker error: {e}", 0)
            log(traceback.format_exc(), 0)

def handle_transcribe(message: dict) -> dict:
    """Handle transcription request - queue for background processing."""
    global _transcribe_thread

    # Start worker thread if not running
    if _transcribe_thread is None or not _transcribe_thread.is_alive():
        _transcribe_thread = threading.Thread(target=_transcription_worker, daemon=True)
        _transcribe_thread.start()
        log("Transcription worker started", 3)

    chunk_id = message.get('chunkId', '')
    _transcribe_queue.put((message, chunk_id))
    log(f"Queued: {chunk_id}", 3)

    # Send acknowledgment to keep connection alive
    return {
        'type': 'transcribe_ack',
        'chunkId': chunk_id,
        'status': 'queued'
    }


def handle_reset(message: dict) -> dict:
    """Handle reset request (e.g., on video seek)."""
    global streaming_engine

    if streaming_engine:
        streaming_engine.reset()

    return {
        'type': 'reset_complete'
    }


def handle_ping(message: dict) -> dict:
    """Handle ping request for health check."""
    return {
        'type': 'pong',
        'initialized': speech_engine is not None
    }


def handle_message(message: dict) -> Optional[dict]:
    """Route message to appropriate handler."""
    msg_type = message.get('type', '')

    handlers = {
        'init': handle_init,
        'transcribe': handle_transcribe,
        'reset': handle_reset,
        'ping': handle_ping,
        'shutdown': lambda m: {'_shutdown': True}  # Special marker for shutdown
    }

    handler = handlers.get(msg_type)
    if handler:
        return handler(message)
    else:
        return {
            'type': 'error',
            'message': f'Unknown message type: {msg_type}'
        }


_heartbeat_stop = threading.Event()

def _heartbeat_thread():
    """Heartbeat thread - currently disabled, Chrome handles pinging."""
    # Disabled: Let Chrome initiate all communication
    # while not _heartbeat_stop.wait(timeout=0.5):
    #     try:
    #         send_native_message({'type': 'heartbeat'})
    #     except Exception as e:
    #         log(f"Heartbeat error: {e}")
    #         break
    _heartbeat_stop.wait()  # Just wait until stopped

def main():
    """Main entry point - message processing loop."""
    running = True

    # Start heartbeat thread
    heartbeat = threading.Thread(target=_heartbeat_thread, daemon=True)
    heartbeat.start()

    while running:
        try:
            # Read message from Chrome
            message = read_native_message()

            if message is None:
                # Connection closed or read error
                break

            # Handle message
            response = handle_message(message)

            if response is None:
                # No immediate response needed (async processing)
                pass
            elif response.get('_shutdown'):
                # Shutdown requested
                running = False
            else:
                # Send response
                send_native_message(response)

        except Exception as e:
            # Send error response
            send_native_message({
                'type': 'error',
                'message': f'Unexpected error: {str(e)}'
            })

    # Stop heartbeat
    _heartbeat_stop.set()


if __name__ == '__main__':
    try:
        main()
        log("Host shutdown", 3)
    except Exception as e:
        log(f"Fatal error: {e}", 0)
        log(traceback.format_exc(), 0)
        raise
