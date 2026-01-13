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

const CHUNK_DURATION = 5; // seconds - smaller chunks for better latency
const SAMPLE_RATE = 16000; // Whisper expects 16kHz

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

      // Add to buffer
      audioBuffer.push(...resampled);
      bufferDuration = audioBuffer.length / SAMPLE_RATE;

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
  // Get chunk samples
  const chunkSamples = audioBuffer.splice(0, SAMPLE_RATE * CHUNK_DURATION);
  bufferDuration = audioBuffer.length / SAMPLE_RATE;

  // Convert to PCM16
  const pcm16 = new Int16Array(chunkSamples.length);
  for (let i = 0; i < chunkSamples.length; i++) {
    pcm16[i] = Math.max(-32768, Math.min(32767, Math.floor(chunkSamples[i] * 32767)));
  }

  // Encode as base64
  const bytes = new Uint8Array(pcm16.buffer);
  const base64 = arrayBufferToBase64(bytes);

  // Send to service worker
  chrome.runtime.sendMessage({
    action: 'audioChunk',
    audio: base64,
    duration: CHUNK_DURATION
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
