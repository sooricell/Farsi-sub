import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { createBlob, decode, decodeAudioData } from './utils';

// Icons
const MicIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
  </svg>
);

const StopIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
    <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 7.5A2.25 2.25 0 0 1 7.5 5.25h9a2.25 2.25 0 0 1 2.25 2.25v9a2.25 2.25 0 0 1-2.25 2.25h-9a2.25 2.25 0 0 1-2.25-2.25v-9Z" />
  </svg>
);

const DesktopIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m-9-12V15a2.25 2.25 0 0 0 2.25 2.25h9.5A2.25 2.25 0 0 0 19.5 15V5.25m-9-12h9.5a2.25 2.25 0 0 1 2.25 2.25v9a2.25 2.25 0 0 1-2.25 2.25h-9.5a2.25 2.25 0 0 1-2.25-2.25v-9a2.25 2.25 0 0 1 2.25-2.25Z" />
  </svg>
);

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [currentSubtitle, setCurrentSubtitle] = useState('');
  const [subtitleHistory, setSubtitleHistory] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [audioSourceType, setAudioSourceType] = useState<'mic' | 'tab'>('tab');

  // References for cleanup
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  
  // Audio Playback
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const disconnect = useCallback(() => {
    // Cleanup Audio Contexts
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    
    // Stop Tracks
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    
    // Cleanup nodes
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    
    // Clear State
    setIsConnected(false);
    nextStartTimeRef.current = 0;
    sourcesRef.current.clear();
  }, []);

  const connect = async () => {
    setError(null);
    try {
      // 1. Get Media Stream (System Audio or Microphone)
      let stream: MediaStream;
      if (audioSourceType === 'tab') {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true, // Required for getDisplayMedia to allow audio selection
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          } 
        });
      } else {
         stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 16000,
            channelCount: 1,
          }
        });
      }

      mediaStreamRef.current = stream;

      // Handle stream stop (user clicks "Stop Sharing" in browser UI)
      stream.getTracks()[0].onended = () => {
        disconnect();
      };

      // If capturing a tab, we might have a video track we want to show for preview
      if (videoRef.current && audioSourceType === 'tab') {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }

      // 2. Initialize Gemini Client
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      // 3. Audio Setup
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      const inputAudioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = inputAudioContext;
      
      const outputAudioContext = new AudioContext({ sampleRate: 24000 });
      outputAudioContextRef.current = outputAudioContext;
      const outputNode = outputAudioContext.createGain();
      outputNode.connect(outputAudioContext.destination);

      // 4. Connect to Gemini Live
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            
            // Setup Audio Processing Pipeline
            const source = inputAudioContext.createMediaStreamSource(stream);
            sourceNodeRef.current = source;
            
            // Using ScriptProcessor for compatibility and simplicity in this single-file setup
            // In a larger app, AudioWorklet is preferred.
            const processor = inputAudioContext.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => {
                 session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(processor);
            processor.connect(inputAudioContext.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Transcription (The "Subtitle")
            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              if (text) {
                setCurrentSubtitle(prev => prev + text);
              }
            }

            // Handle Turn Complete (Push to history)
            if (message.serverContent?.turnComplete) {
              setCurrentSubtitle(prev => {
                if (prev.trim().length > 0) {
                   setSubtitleHistory(h => [prev, ...h].slice(0, 50));
                }
                return '';
              });
            }

            // Handle Audio Output (The "Dubbing" - optional, but helps flow)
            // We can mute this if the user only wants text, but keeping it for now gives feedback.
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContext.currentTime);
              
              const audioBuffer = await decodeAudioData(
                decode(base64Audio),
                outputAudioContext,
                24000,
                1
              );
              
              const source = outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputNode);
              source.addEventListener('ended', () => {
                sourcesRef.current.delete(source);
              });
              
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }
          },
          onclose: () => {
            disconnect();
          },
          onerror: (err) => {
            console.error(err);
            setError("Connection error occurred. Please try again.");
            disconnect();
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          },
          outputAudioTranscription: {}, // Request transcription of model output
          systemInstruction: `
            You are an expert simultaneous interpreter. 
            Your task is to listen to the incoming English audio stream and translate it into Farsi (Persian) in real-time.
            
            Strict Guidelines:
            1. Output ONLY the Farsi translation. Do not repeat the English.
            2. Be concise and accurate.
            3. Translate idiomatically for a Persian audience.
            4. If there is silence or no speech, remain silent.
          `
        }
      });

    } catch (err) {
      console.error(err);
      setError("Failed to initialize capture. Please ensure permissions are granted.");
      disconnect();
    }
  };

  // Auto-scroll history (optional logic can go here)

  return (
    <div className="min-h-screen bg-slate-900 text-slate-50 flex flex-col font-sans selection:bg-cyan-500 selection:text-slate-900">
      
      {/* Header */}
      <header className="p-6 border-b border-slate-800 flex items-center justify-between backdrop-blur-md bg-slate-900/80 sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-cyan-400 to-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-cyan-500/20">
             <span className="text-xl font-bold text-white">F</span>
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">FarsiLiveSub</h1>
            <p className="text-xs text-slate-400">Real-time English to Persian Interpreter</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
           {isConnected && (
             <span className="flex items-center gap-2 px-3 py-1 rounded-full bg-red-500/10 text-red-400 text-xs font-medium animate-pulse border border-red-500/20">
               <span className="w-2 h-2 rounded-full bg-red-500"></span>
               LIVE
             </span>
           )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-5xl mx-auto w-full p-6 flex flex-col md:flex-row gap-6">
        
        {/* Left Panel: Controls & Preview */}
        <section className="flex flex-col gap-6 w-full md:w-1/3">
          
          {/* Controls Card */}
          <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6 shadow-xl backdrop-blur-sm">
            <h2 className="text-sm font-semibold text-slate-300 mb-4 uppercase tracking-wider">Source</h2>
            
            <div className="flex gap-2 mb-6">
              <button 
                onClick={() => setAudioSourceType('tab')}
                className={`flex-1 flex flex-col items-center justify-center gap-2 p-4 rounded-xl border transition-all ${
                  audioSourceType === 'tab' 
                    ? 'bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-500/25' 
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-750 hover:border-slate-600'
                }`}
              >
                <DesktopIcon />
                <span className="text-sm font-medium">System Audio</span>
              </button>
              
              <button 
                onClick={() => setAudioSourceType('mic')}
                className={`flex-1 flex flex-col items-center justify-center gap-2 p-4 rounded-xl border transition-all ${
                  audioSourceType === 'mic' 
                    ? 'bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-500/25' 
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-750 hover:border-slate-600'
                }`}
              >
                <MicIcon />
                <span className="text-sm font-medium">Microphone</span>
              </button>
            </div>

            {error && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-200 text-sm">
                {error}
              </div>
            )}

            {!isConnected ? (
              <button
                onClick={connect}
                className="w-full py-4 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white font-bold rounded-xl shadow-lg shadow-emerald-500/20 transition-all active:scale-95 flex items-center justify-center gap-2 group"
              >
                <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                </div>
                Start Translation
              </button>
            ) : (
              <button
                onClick={disconnect}
                className="w-full py-4 bg-red-500 hover:bg-red-400 text-white font-bold rounded-xl shadow-lg shadow-red-500/20 transition-all active:scale-95 flex items-center justify-center gap-2"
              >
                 <StopIcon />
                Stop Translation
              </button>
            )}
            
            {audioSourceType === 'tab' && (
              <p className="mt-4 text-xs text-slate-500 leading-relaxed">
                Tip: When browser asks, select the tab playing the video and ensure <strong>"Share tab audio"</strong> is checked.
              </p>
            )}
          </div>

          {/* Video Preview (Hidden if mic, small if tab) */}
          <div className={`aspect-video bg-black rounded-2xl overflow-hidden border border-slate-800 shadow-2xl relative group ${audioSourceType === 'mic' ? 'hidden' : 'block'}`}>
            <video 
              ref={videoRef} 
              muted 
              className="w-full h-full object-contain opacity-50 group-hover:opacity-100 transition-opacity"
            />
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-slate-600 text-sm font-medium px-3 py-1 bg-black/50 rounded-full border border-white/10 backdrop-blur-md">Video Preview</span>
            </div>
          </div>

        </section>

        {/* Right Panel: Subtitles */}
        <section className="flex-1 flex flex-col gap-6">
            
            {/* Live Subtitle Area */}
            <div className="flex-1 bg-gradient-to-b from-slate-800 to-slate-900 border border-slate-700 rounded-3xl p-8 relative overflow-hidden flex flex-col justify-end min-h-[300px] shadow-2xl">
               <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-cyan-500 via-blue-500 to-purple-500 opacity-50"></div>
               
               {/* Label */}
               <div className="absolute top-6 right-6 px-3 py-1 bg-slate-700/50 rounded-full text-xs text-slate-400 border border-slate-600/50 backdrop-blur">
                  Live Output (Persian)
               </div>

               {/* Current active text */}
               <div className="font-farsi text-right dir-rtl">
                  {!isConnected && !currentSubtitle && subtitleHistory.length === 0 ? (
                      <div className="text-center text-slate-600 mt-auto pb-10">
                          <p className="text-lg">Ready to translate.</p>
                          <p className="text-sm">Click Start to begin real-time interpretation.</p>
                      </div>
                  ) : (
                    <div className="space-y-2">
                        <span className="text-4xl md:text-5xl font-bold leading-tight text-transparent bg-clip-text bg-gradient-to-l from-white to-slate-300 drop-shadow-sm transition-all duration-100 ease-out">
                            {currentSubtitle || "..."}
                        </span>
                    </div>
                  )}
               </div>
            </div>

            {/* History Log */}
            <div className="h-64 bg-slate-900/50 border border-slate-800 rounded-2xl p-4 overflow-y-auto">
                <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3 sticky top-0 bg-slate-900/90 pb-2 backdrop-blur">Translation History</h3>
                <div className="space-y-3 font-farsi text-right dir-rtl">
                    {subtitleHistory.map((sub, i) => (
                        <div key={i} className="text-lg text-slate-400 border-b border-slate-800/50 pb-2 last:border-0 hover:text-slate-200 transition-colors">
                            {sub}
                        </div>
                    ))}
                    {subtitleHistory.length === 0 && (
                        <p className="text-slate-600 text-sm text-center italic mt-10">No history yet</p>
                    )}
                </div>
            </div>

        </section>
      </main>
      
      {/* Footer */}
      <footer className="p-4 text-center text-slate-600 text-xs border-t border-slate-800">
        <p>Powered by Google Gemini 2.5 Flash Native Audio</p>
      </footer>

    </div>
  );
}