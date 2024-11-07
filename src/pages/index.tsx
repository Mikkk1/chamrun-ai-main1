import { useState, useRef, useEffect, FC } from 'react';
import Head from 'next/head';
import pako from 'pako';
import Sidebar from './components/sidebar';
import { CirclePlay } from "lucide-react";
import dynamic from 'next/dynamic';
import type { TypewriterProps } from 'react-typewriter-effect';
import { start } from 'repl';
interface TypewriterProps {
  // Add TypewriterProps interface as needed
}

interface Message {
  role: string;
  content: string;
}
const Typewriter = dynamic(() => import('react-typewriter-effect'), {
  ssr: false,
}) as FC<TypewriterProps>;
declare global {
  interface Window {
    webkitSpeechRecognition: any;
  }
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [isAISpeaking, setIsAISpeaking] = useState(false);
  const [userVolume, setUserVolume] = useState(0);
  const [aiVolume, setAIVolume] = useState(0);
  const [isListening, setIsListening] = useState(false);
  const [status, setStatus] = useState('Initializing...');
  const [micCheckInterval, setMicCheckInterval] = useState<ReturnType<typeof setInterval> | null>(null);


  const animationFrameRef = useRef<number | null>(null);
  const recognitionRef = useRef<any>(null);
  const isProcessingRef = useRef(false);


  const playAudio = async (audioData: string, audioMimeType: string, fallbackText: string) => {
    try {
      const binaryString = atob(audioData);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const wavBuffer = createWavFromPcm(bytes);
      const blob = new Blob([wavBuffer], { type: 'audio/wav' });
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);

      return new Promise<void>((resolve, reject) => {
        audio.oncanplay = () => {
          audio.play().catch(reject);
        };

        audio.onended = () => {
          URL.revokeObjectURL(audioUrl);
          resolve();
        };

        audio.onerror = () => {
          URL.revokeObjectURL(audioUrl);
          const utterance = new SpeechSynthesisUtterance(fallbackText);
          window.speechSynthesis.speak(utterance);
          reject(new Error('Audio playback failed'));
        };
      });
    } catch (error) {
      console.error('Error in playAudio:', error);
      const utterance = new SpeechSynthesisUtterance(fallbackText);
      window.speechSynthesis.speak(utterance);
      throw error;
    }
  };

  function createWavFromPcm(pcmData: Uint8Array): ArrayBuffer {
    const numChannels = 1; // Mono
    const sampleRate = 24000; // Assuming 24kHz sample rate, adjust if needed
    const bitsPerSample = 16; // Assuming 16-bit PCM, adjust if needed

    const wavHeader = new ArrayBuffer(44);
    const view = new DataView(wavHeader);

    // RIFF chunk descriptor
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + pcmData.length, true);
    writeString(view, 8, 'WAVE');

    // fmt sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size
    view.setUint16(20, 1, true); // AudioFormat (PCM)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true); // ByteRate
    view.setUint16(32, numChannels * (bitsPerSample / 8), true); // BlockAlign
    view.setUint16(34, bitsPerSample, true);

    // data sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, pcmData.length, true);

    // Combine header and PCM data
    const wavBuffer = new Uint8Array(wavHeader.byteLength + pcmData.length);
    wavBuffer.set(new Uint8Array(wavHeader), 0);
    wavBuffer.set(pcmData, wavHeader.byteLength);

    return wavBuffer.buffer;
  }

  function writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  const sendMessage = async (content: string, isAudio: boolean = false) => {
    if (isProcessingRef.current) {
      console.log('Already processing a message, skipping...');
      return;
    }

    isProcessingRef.current = true;
    setIsLoading(true);

    try {
      // Temporarily pause recognition while processing
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: isAudio ? undefined : content,
          audioData: isAudio ? content : undefined,
          isCompressed: isAudio
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      // Add messages to conversation
      setMessages(prevMessages => [
        ...prevMessages,
        { role: 'user', content: isAudio ? 'Sent audio message' : content },
        { role: 'assistant', content: data.response }
      ]);
      console.log('Message sent:', content);

      // Handle audio response
      if (data.audioData && data.audioMimeType) {
        setIsAISpeaking(true);
        simulateAISpeaking();
        await playAudio(data.audioData, data.audioMimeType, data.response);
        setIsAISpeaking(false);
      } else {
        // Fallback to text-to-speech
        const utterance = new SpeechSynthesisUtterance(data.response);
        setIsAISpeaking(true);
        simulateAISpeaking();
        
        await new Promise<void>((resolve) => {
          utterance.onend = () => {
            setIsAISpeaking(false);
            setAIVolume(0);
            resolve();
          };
          window.speechSynthesis.speak(utterance);
        });
      }

    } catch (error) {
      console.error('Error in sendMessage:', error);
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
      setMessages(prevMessages => [...prevMessages, { role: 'assistant', content: `Error: ${errorMessage}` }]);
    } finally {
      isProcessingRef.current = false;
      setIsLoading(false);
      setInput('');

      // Restart recognition if it was active
      if (isListening && recognitionRef.current) {
        try {
          recognitionRef.current.start();
        } catch (error) {
          console.error('Error restarting recognition:', error);
        }
      }
    }
  };

  const simulateAISpeaking = () => {
    let frame = 0;
    const animate = () => {
      frame++;
      const volume = Math.sin(frame / 5) * 50 + 50;
      setAIVolume(volume);
      
      if (isAISpeaking && !document.hidden) {
        animationFrameRef.current = requestAnimationFrame(animate);
      } else {
        setAIVolume(0);
      }
    };
    animate();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      sendMessage(input);
    }
  };

  const startRecording = async () => {
    console.log('Starting recording...');
    setIsRecording(true);
    // Create a new SpeechRecognition instance and configure it
    recognitionRef.current = new window.webkitSpeechRecognition();
    recognitionRef.current.continuous = true;
    recognitionRef.current.interimResults = false;

    // Event handler for speech recognition results
    recognitionRef.current.onresult = (event: any) => {
      const { transcript } = event.results[event.results.length - 1][0];

      // Log the recognition results and update the transcript state
      console.log(event.results);
      console.log('Transcript:', transcript);
      sendMessage(transcript);
      // Clear the recognition results to prevent processing the same transcript multiple times
      setIsListening(true);
      };

    // Start the speech recognition
    await recognitionRef.current.start();
    const interval = setInterval(checkAndEnableMic, 15000);
    setMicCheckInterval(interval);
  };
  const checkAndEnableMic = async () => {
    try {
      // Check if the microphone is available
      await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('Microphone is available');
      try {
        await recognitionRef.current.start();
      } catch (error) {
      }
        } catch (error) {
  
      // Try to re-enable the microphone
      const permissionStatus = await navigator.mediaDevices.getUserMedia({ audio: true })
        .then(() => 'granted')
        .catch(() => 'denied');
  
      setStatus(permissionStatus);
  
      if (permissionStatus === 'granted') {
        console.log('Microphone re-enabled');
  
        // Restart the speech recognition
        if (recognitionRef.current) {
          try {
            await recognitionRef.current.start();
            setIsListening(true);
          } catch (error) {
            console.error('Error restarting speech recognition:', error);
          }
        }
      } else {
        console.log('Microphone permission denied');
      }
    }
  };
  useEffect(() => {
    const checkMicPermission = async () => {
      try {
        const permissionStatus = await navigator.mediaDevices.getUserMedia({ audio: true })
          .then(() => 'granted')
          .catch(() => 'denied');
  
        setStatus(permissionStatus);
      } catch (error) {
        console.error('Error checking microphone permission:', error);
        setStatus('Error');
      }
    };
  
    checkMicPermission();
    startRecording();
    return () => {
      // Stop the speech recognition if it's active
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      if (micCheckInterval) {
        clearInterval(micCheckInterval);
      }
    };
  }, []);
  return (
    <div className="bg-themecolor min-h-screen text-white flex  justify-center h-screen">
      <Head>
        <title>Chamrun AI</title>
        <meta name="description" content="Chat with AI using interactive circles" />
      </Head>
      <Sidebar />
      <main className="container mx-auto p-4 flex flex-col items-center">
      <img src="tutor.avif" alt="Tutor" className="mb-4 rounded-full" style={{ width: '100px' }} />
      <div className='flex justify-center items-center mt-2 mb-4'>
      <img src="malaysia-flag-icon.svg" className='h-4' alt="flag" />
      <h1 className='text-center text-black ml-2 text-2xl font-bold'>Your Ai Tutor</h1>
      <img src="malaysia-flag-icon.svg" className='h-4 ml-2' alt="flag" />
      </div>
     
        <div className="w-full relative bg-white rounded-lg border border-gray p-4 mb-4 h-5/6 overflow-y-auto">
          {messages.map((message, index) => (
            <div key={index} className='mb-2'>

              <p className='text-black uppercase text-bold'>{message.role === 'user' ? 'User' : 'Assistant'}</p>
              <span className={`inline-block p-2 text-sm rounded-lg text-black ${message.role === 'user' ? 'bg-white' : 'bg-white'}`}>
              
                  <Typewriter
                text={message.content}
                typeSpeed={55} // Speed of typing in milliseconds
                startDelay={500} // Delay before starting the typing effect
                cursorColor="#000" // Color of the cursor
                hideCursorAfterText={true} // Hides cursor after typing
              />
            
            
              </span>
            </div>
          ))}
          {isLoading &&
         <div className="text-center text-black absolute top-0 left-0 right-0 bottom-0 flex justify-center items-center">
          <div className="loader bg-white p-5 rounded-full flex space-x-3">
    <div className="w-5 h-5 bg-gray-800 rounded-full animate-bounce"></div>
    <div className="w-5 h-5 bg-gray-800 rounded-full animate-bounce"></div>
    <div className="w-5 h-5 bg-gray-800 rounded-full animate-bounce"></div>
  </div>
          </div>}
        </div>


        <div className="flex justify-between mb-8">
          <div 
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-all duration-100 ml-2 ${
              isAISpeaking ? 'bg-green-600' : 'bg-gray-600'
            }`}
            style={{
              transform: `scale(${1 + aiVolume / 200})`,
              boxShadow: `0 0 ${aiVolume}px ${aiVolume / 2}px rgba(16, 185, 129, 0.5)`
            }}
          >
            <span className="text-xl font-bold">
              {isAISpeaking ? 'AI Speaking...' : 'AI'}
            </span>
          </div>
        </div>
       
        <form onSubmit={handleSubmit} className="w-full  flex">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="flex-grow text-black p-2 rounded-l-lg focus:outline-none"
            placeholder="Type your message..."
            disabled={isLoading || isRecording}
          />
          <button
            type="submit"
            className="bg-transparent text-black p-2 border border-gray rounded-r-lg hover:bg-blue-700 focus:outline-none"
            disabled={isLoading || isRecording}
          >
            Send
          </button>
        </form>
      </main>
    </div>
  );
}