// Offscreen document for audio capture and processing
// This is needed because chrome.tabCapture.capture() can't run in a service worker

let audioContext = null;
let mediaStream = null;
let processor = null;
let audioBuffer = [];
let bufferDuration = 0;
let isCapturing = false;
let isPaused = false;
let audioPlayback = null; // Audio element for playback

// Generation capture state (separate from live transcription)
let genAudioContext = null;
let genMediaStream = null;
let genProcessor = null;
let genAudioBuffer = [];
let genBufferDuration = 0;
let genIsCapturing = false;
let genAudioPlayback = null;
let genTimestamp = 0;

const CHUNK_DURATION = 10; // seconds - larger chunks for better context
const OVERLAP_DURATION = 2; // seconds - overlap between chunks to avoid cutting mid-sentence
const SAMPLE_RATE = 16000; // Whisper expects 16kHz

// Rolling audio buffer for pattern learning (keeps last 60 seconds)
const PATTERN_BUFFER_DURATION = 60;
let patternAudioBuffer = new Float32Array(SAMPLE_RATE * PATTERN_BUFFER_DURATION);
let patternBufferWritePos = 0;
let patternBufferVideoTime = 0; // Video time corresponding to buffer end

// Listen for messages from the service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Offscreen received:', message.action);

  switch (message.action) {
    case 'startCapture':
      startCapture(message.streamId)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'stopCapture':
      stopCapture();
      sendResponse({ success: true });
      break;

    case 'pauseCapture':
      isPaused = true;
      sendResponse({ success: true });
      break;

    case 'resumeCapture':
      isPaused = false;
      sendResponse({ success: true });
      break;

    case 'resetCapture':
      audioBuffer = [];
      bufferDuration = 0;
      sendResponse({ success: true });
      break;

    // Generation capture handlers
    case 'startGenerationCapture':
      startGenerationCapture(message.streamId)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'stopGenerationCapture':
      stopGenerationCapture();
      sendResponse({ success: true });
      break;

    // Pattern learning handlers
    case 'extractAudioForPattern':
      const result = extractAudioRange(
        message.startTime,
        message.endTime,
        message.currentVideoTime
      );
      sendResponse(result);
      break;

    case 'updatePatternBufferTime':
      patternBufferVideoTime = message.currentVideoTime;
      sendResponse({ success: true });
      break;

    case 'clearPatternBuffer':
      patternAudioBuffer.fill(0);
      patternBufferWritePos = 0;
      patternBufferVideoTime = 0;
      sendResponse({ success: true });
      break;
  }
});

async function startCapture(streamId) {
  if (isCapturing) {
    throw new Error('Already capturing');
  }

  try {
    // Get the media stream using the stream ID from tabCapture.getMediaStreamId()
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });

    // Play the captured audio back so user can still hear it
    // Clone the stream for playback to avoid interference
    audioPlayback = new Audio();
    audioPlayback.srcObject = mediaStream.clone();
    audioPlayback.play().catch(e => console.log('Audio playback error:', e));

    // Create audio context for processing
    audioContext = new AudioContext({ sampleRate: 48000 });

    const source = audioContext.createMediaStreamSource(mediaStream);

    // Create script processor for audio chunks
    processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      if (isPaused || !isCapturing) return;

      const inputData = event.inputBuffer.getChannelData(0);

      // Resample from 48kHz to 16kHz
      const resampled = resample(inputData, 48000, SAMPLE_RATE);

      // Add to transcription buffer
      audioBuffer.push(...resampled);
      bufferDuration = audioBuffer.length / SAMPLE_RATE;

      // Also add to pattern learning buffer (rolling buffer)
      updatePatternBuffer(resampled);

      // Send chunk when we have enough audio
      if (bufferDuration >= CHUNK_DURATION) {
        sendAudioChunk();
      }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    isCapturing = true;
    isPaused = false;
    console.log('Audio capture started with playback');

  } catch (error) {
    console.error('Failed to start capture:', error);
    stopCapture();
    throw error;
  }
}

function resample(inputData, inputSampleRate, outputSampleRate) {
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.floor(inputData.length / ratio);
  const output = new Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = Math.floor(i * ratio);
    output[i] = inputData[srcIndex];
  }

  return output;
}

function sendAudioChunk() {
  const chunkSamples = SAMPLE_RATE * CHUNK_DURATION;
  const overlapSamples = SAMPLE_RATE * OVERLAP_DURATION;

  // Get the full chunk including what will become overlap for next chunk
  const samplesNeeded = chunkSamples;
  const samplesToSend = audioBuffer.slice(0, samplesNeeded);

  // Keep overlap samples for the next chunk (don't remove them from buffer)
  // Only remove the non-overlapping portion
  const samplesToRemove = chunkSamples - overlapSamples;
  audioBuffer.splice(0, samplesToRemove);
  bufferDuration = audioBuffer.length / SAMPLE_RATE;

  // Convert to PCM16
  const pcm16 = new Int16Array(samplesToSend.length);
  for (let i = 0; i < samplesToSend.length; i++) {
    pcm16[i] = Math.max(-32768, Math.min(32767, Math.floor(samplesToSend[i] * 32767)));
  }

  // Encode as base64
  const bytes = new Uint8Array(pcm16.buffer);
  const base64 = arrayBufferToBase64(bytes);

  // Send to service worker with overlap info
  chrome.runtime.sendMessage({
    action: 'audioChunk',
    audio: base64,
    duration: CHUNK_DURATION,
    overlap: OVERLAP_DURATION
  });
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function stopCapture() {
  isCapturing = false;

  if (processor) {
    processor.disconnect();
    processor = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  if (audioPlayback) {
    audioPlayback.pause();
    audioPlayback.srcObject = null;
    audioPlayback = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  audioBuffer = [];
  bufferDuration = 0;

  console.log('Audio capture stopped');
}

// ============================================================================
// Generation Capture (for pre-generating subtitles)
// ============================================================================

async function startGenerationCapture(streamId) {
  if (genIsCapturing) {
    throw new Error('Generation already capturing');
  }

  try {
    genMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });

    // Play the captured audio back so user can still hear it
    genAudioPlayback = new Audio();
    genAudioPlayback.srcObject = genMediaStream.clone();
    genAudioPlayback.play().catch(e => console.log('Generation audio playback error:', e));

    genAudioContext = new AudioContext({ sampleRate: 48000 });
    const source = genAudioContext.createMediaStreamSource(genMediaStream);
    genProcessor = genAudioContext.createScriptProcessor(4096, 1, 1);

    genTimestamp = 0;

    genProcessor.onaudioprocess = (event) => {
      if (!genIsCapturing) return;

      const inputData = event.inputBuffer.getChannelData(0);
      const resampled = resample(inputData, 48000, SAMPLE_RATE);

      genAudioBuffer.push(...resampled);
      genBufferDuration = genAudioBuffer.length / SAMPLE_RATE;

      if (genBufferDuration >= CHUNK_DURATION) {
        sendGenerationAudioChunk();
      }
    };

    source.connect(genProcessor);
    genProcessor.connect(genAudioContext.destination);

    genIsCapturing = true;
    console.log('Generation audio capture started');

  } catch (error) {
    console.error('Failed to start generation capture:', error);
    stopGenerationCapture();
    throw error;
  }
}

function sendGenerationAudioChunk() {
  const chunkSamples = SAMPLE_RATE * CHUNK_DURATION;
  const overlapSamples = SAMPLE_RATE * OVERLAP_DURATION;

  const samplesNeeded = chunkSamples;
  const samplesToSend = genAudioBuffer.slice(0, samplesNeeded);

  const samplesToRemove = chunkSamples - overlapSamples;
  genAudioBuffer.splice(0, samplesToRemove);
  genBufferDuration = genAudioBuffer.length / SAMPLE_RATE;

  // Convert to PCM16
  const pcm16 = new Int16Array(samplesToSend.length);
  for (let i = 0; i < samplesToSend.length; i++) {
    pcm16[i] = Math.max(-32768, Math.min(32767, Math.floor(samplesToSend[i] * 32767)));
  }

  // Encode as base64
  const bytes = new Uint8Array(pcm16.buffer);
  const base64 = arrayBufferToBase64(bytes);

  // Send to service worker
  chrome.runtime.sendMessage({
    action: 'generationAudioChunk',
    audio: base64,
    duration: CHUNK_DURATION,
    timestamp: genTimestamp,
    overlap: OVERLAP_DURATION
  });

  // Update timestamp for next chunk
  genTimestamp += CHUNK_DURATION - OVERLAP_DURATION;
}

function stopGenerationCapture() {
  genIsCapturing = false;

  if (genProcessor) {
    genProcessor.disconnect();
    genProcessor = null;
  }

  if (genAudioContext) {
    genAudioContext.close();
    genAudioContext = null;
  }

  if (genAudioPlayback) {
    genAudioPlayback.pause();
    genAudioPlayback.srcObject = null;
    genAudioPlayback = null;
  }

  if (genMediaStream) {
    genMediaStream.getTracks().forEach(track => track.stop());
    genMediaStream = null;
  }

  genAudioBuffer = [];
  genBufferDuration = 0;
  genTimestamp = 0;

  console.log('Generation audio capture stopped');
}

// ============================================================================
// Pattern Learning Buffer Functions
// ============================================================================

function updatePatternBuffer(resampled) {
  /**
   * Add resampled audio to the rolling pattern buffer.
   * Buffer wraps around when full, keeping the most recent audio.
   */
  const bufferLen = patternAudioBuffer.length;
  const dataLen = resampled.length;

  if (patternBufferWritePos + dataLen <= bufferLen) {
    // Fits without wrapping
    patternAudioBuffer.set(resampled, patternBufferWritePos);
    patternBufferWritePos += dataLen;
  } else {
    // Need to wrap - shift buffer left and append
    const overflow = (patternBufferWritePos + dataLen) - bufferLen;

    // Shift existing data left by overflow amount
    patternAudioBuffer.copyWithin(0, overflow);

    // Update write position
    patternBufferWritePos = bufferLen - dataLen;

    // Write new data at the end
    patternAudioBuffer.set(resampled, patternBufferWritePos);
    patternBufferWritePos = bufferLen;
  }

  // Update video time to match buffer end
  patternBufferVideoTime += dataLen / SAMPLE_RATE;
}

function extractAudioRange(startTime, endTime, currentVideoTime) {
  /**
   * Extract audio from the pattern buffer for a given video time range.
   *
   * @param {number} startTime - Start time in video (seconds)
   * @param {number} endTime - End time in video (seconds)
   * @param {number} currentVideoTime - Current video playback time (seconds)
   * @returns {object} { success: boolean, audio?: string (base64), error?: string }
   */
  try {
    // Calculate how much audio is in the buffer
    const bufferDurationSeconds = patternBufferWritePos / SAMPLE_RATE;
    const bufferStartVideoTime = patternBufferVideoTime - bufferDurationSeconds;

    console.log(`[Pattern] Extract: want ${startTime.toFixed(1)}-${endTime.toFixed(1)}s, ` +
      `buffer has ${bufferStartVideoTime.toFixed(1)}-${patternBufferVideoTime.toFixed(1)}s`);

    // Check if requested range is in buffer
    if (startTime < bufferStartVideoTime) {
      return {
        success: false,
        error: `Start time ${startTime.toFixed(1)}s is before buffer start ${bufferStartVideoTime.toFixed(1)}s. ` +
          `Buffer only keeps last ${PATTERN_BUFFER_DURATION}s of audio.`
      };
    }

    if (endTime > patternBufferVideoTime) {
      return {
        success: false,
        error: `End time ${endTime.toFixed(1)}s is after buffer end ${patternBufferVideoTime.toFixed(1)}s. ` +
          `Make sure the video has played past the end time.`
      };
    }

    // Calculate sample positions in buffer
    const startOffset = startTime - bufferStartVideoTime;
    const endOffset = endTime - bufferStartVideoTime;
    const startSample = Math.floor(startOffset * SAMPLE_RATE);
    const endSample = Math.floor(endOffset * SAMPLE_RATE);

    if (startSample < 0 || endSample > patternBufferWritePos || startSample >= endSample) {
      return {
        success: false,
        error: `Invalid sample range: ${startSample}-${endSample}`
      };
    }

    // Extract audio segment
    const audioSegment = patternAudioBuffer.slice(startSample, endSample);
    const duration = audioSegment.length / SAMPLE_RATE;

    console.log(`[Pattern] Extracted ${duration.toFixed(1)}s of audio (${audioSegment.length} samples)`);

    // Convert to PCM16 and base64 encode
    const pcm16 = new Int16Array(audioSegment.length);
    for (let i = 0; i < audioSegment.length; i++) {
      pcm16[i] = Math.max(-32768, Math.min(32767, Math.floor(audioSegment[i] * 32767)));
    }

    const bytes = new Uint8Array(pcm16.buffer);
    const base64 = arrayBufferToBase64(bytes);

    return {
      success: true,
      audio: base64,
      duration: duration,
      startTime: startTime,
      endTime: endTime
    };

  } catch (error) {
    console.error('[Pattern] Extract error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}
