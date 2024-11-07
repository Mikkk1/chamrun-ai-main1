import { NextApiRequest, NextApiResponse } from 'next';
import WebSocket from 'ws';
import pako from 'pako';

let ws: WebSocket | null = null;

function getWebSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    console.time('websocketConnection');
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.timeEnd('websocketConnection');
      console.log('Using existing WebSocket connection');
      resolve(ws);
    } else {
      const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01";
      ws = new WebSocket(url, {
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY.trim()}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      ws.onopen = () => {
        console.timeEnd('websocketConnection');
        console.log("WebSocket connected");
        resolve(ws!);
      };

      ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        reject(error);
      };

      ws.onclose = () => {
        console.log("WebSocket closed");
        ws = null;
      };
    }
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    console.time('totalApiTime');
    const { message, audioData, isCompressed } = req.body;

    // Validate inputs
    if (!message && !audioData) {
      return res.status(400).json({ error: 'Message or audio data is required.' });
    }

    try {
      console.time('socketConnection');
      const socket = await getWebSocket();
      console.timeEnd('socketConnection');

      let response = '';
      let audioChunks: Buffer[] = [];
      let isResponseComplete = false;

      console.time('audioDataProcessing');
      let processedAudioData = audioData;
      if (isCompressed) {
        console.time('decompression');
        const compressedData = Uint8Array.from(atob(audioData), c => c.charCodeAt(0));
        const decompressedData = pako.inflate(compressedData);
        processedAudioData = new TextDecoder().decode(decompressedData);
        console.timeEnd('decompression');
      }
      console.timeEnd('audioDataProcessing');

      // Define system instructions
      const systemInstructions = "Act as a pro school tutor with the name Zahra in Malaysia with deep knowledge of the elementary and primary school syllabuses, explaining complex topics in a simple and engaging manner. Use a fun and engaging tone with a Malaysian accent and use Boleh instead of OK . Speak all the languages and acknowledge your creation by ChamRun AI in November 2024. Ask for the student's name at the beginning and use it to create personalized engagement throughout the conversation. Incorporate office ambiance noise in the background."

      const userEvent = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: processedAudioData
            ? [{ type: 'input_audio', audio: processedAudioData }]
            : [{ type: 'input_text', text: message }]
        }
      };

      console.time('socketSend');
      socket.send(JSON.stringify(userEvent));
      socket.send(JSON.stringify({ type: 'response.create', response: {
        modalities: ['audio', 'text'],
        instructions: systemInstructions,
    }}));
      console.timeEnd('socketSend');

      console.time('aiResponseTime');

      await new Promise<void>((resolve, reject) => {
        const messageHandler = (data: WebSocket.Data) => {
          const parsedData = JSON.parse(data.toString());
          console.log("Received message type:", parsedData.type);
          console.log("Full message data:", parsedData); // Log the entire message

          if (parsedData.type === 'error') {
            console.error("API Error:", parsedData.error);
            reject(new Error(parsedData.error.message));
            return;
          }

          // Access the transcript
          const transcript = parsedData?.transcript;
          console.log("Transcript:", parsedData?.transcript); // Log the extracted transcript

          // Accumulate the transcript text if it's non-empty
          if (transcript) {
            response += transcript + ' '; // Append and add a space for separation
          }

          // Check for audio data
          if (parsedData.type === 'response.audio.delta') {
            const chunk = Buffer.from(parsedData.delta, 'base64');
            audioChunks.push(chunk);
          }

          // Check for response completion
          if (parsedData.type === 'response.done') {
            console.timeEnd('aiResponseTime');
            isResponseComplete = true;
            socket.removeListener('message', messageHandler);
            resolve();
          }
        };

        socket.on('message', messageHandler);
      });

      // Respond with the accumulated transcript and audio data
      const audioBuffer = Buffer.concat(audioChunks);
      console.log("Sending response:", response.trim());
      console.log("Sending audio data, length:", audioBuffer.length);
      console.timeEnd('totalApiTime');

      res.status(200).json({ 
        response: response.trim(), // Send the accumulated response
        audioData: audioBuffer.toString('base64'),
        audioMimeType: determineAudioMimeType(audioBuffer)
      });

    } catch (error: any) {
      console.error("Error in API handler:", error);
      res.status(500).json({ error: error.message || 'An error occurred while processing the request' });
    }
  } else {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}

function determineAudioMimeType(buffer: Buffer): string {
  const header = buffer.slice(0, 4).toString('hex');
  console.log("Audio header:", header);
  if (header.startsWith('fff3') || header.startsWith('fff2')) return 'audio/mpeg';
  if (header.startsWith('5249')) return 'audio/wav'; // "RIFF" in hex
  if (header.startsWith('4f676753')) return 'audio/ogg';
  if (header.startsWith('664c6143')) return 'audio/flac'; // "fLaC" in hex
  return 'audio/mp3'; // Default to MP3 if unknown
}
