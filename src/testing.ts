// Install the assemblyai package: npm install assemblyai
import { AssemblyAI } from "assemblyai";
import fs from "fs";
import path from "path";

// // Initialize AssemblyAI client with your API key
const client = new AssemblyAI({
  apiKey: "6d5279b4526d4c209f31de7a3ef45344", // Ensure this key is valid
});

// Use absolute path to the video file
const audioFile = path.resolve(__dirname, "yyy.mp4");

// Verify file exists before proceeding
if (!fs.existsSync(audioFile)) {
  console.error("Error: File does not exist at", audioFile);
  process.exit(1);
}

const params: any = {
  audio: audioFile, // Local video file
  speech_model: "nano", // Faster model for testing (supports Hindi)
  format_text: true, // Add punctuation and casing
  language_code: "en" // Hindi (Devanagari output)
};

const run = async () => {
  try {
    console.log("Starting transcription for", audioFile);
    const transcript : any = await client.transcripts.transcribe(params);
    console.log(transcript)

    // Poll for completion
    while (transcript.status !== "completed" && transcript.status !== "failed") {
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds
      const status :any = await client.transcripts.get(transcript.id);
      console.log("Transcription status:", status.status);
      if (status.status === "completed") {
        console.log("Transcribed text:", status.text);
        break;
      } else if (status.status === "failed") {
        console.error("Transcription failed:", status.error);
        break;
      }
    }
  } catch (error : any ) {
    console.error("Error during transcription:", error.message);
  }
};

// run();