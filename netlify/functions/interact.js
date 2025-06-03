const Groq = require("groq-sdk");
const { SupabaseClient, createClient } = require("@supabase/supabase-js");
const dotenv = require("dotenv");
const { pinyin } = require("pinyin"); // npm install pinyin
const gTTS = require("gtts"); // npm install gtts - or a node equivalent
const fs = require("fs"); // For createReadStream
const fsPromises = require("fs").promises; // For other async fs operations
const os = require("os");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

dotenv.config();

const GROQ_API_KEY = process.env.GROQZ_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // This should be the anon key for client-side accessible functions, or service_role for admin tasks on server

const AUDIO_BUCKET_NAME = "audioresponses"; // Ensure this matches your Supabase bucket
const CHAT_TABLE_NAME = "chat_messages"; // Ensure this matches your Supabase table

let supabase;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
} else {
  console.error(
    "ERROR: SUPABASE_URL or SUPABASE_KEY not found. Supabase integration will be disabled."
  );
}

let groq;
if (GROQ_API_KEY) {
  groq = new Groq({ apiKey: GROQ_API_KEY });
} else {
  console.error("ERROR: GROQ_API_KEY not found.");
}

const getPinyinString = (textToConvert) => {
  if (!textToConvert) return "";
  return pinyin(textToConvert, {
    style: pinyin.STYLE_TONE,
    heteronym: false,
  }).join(" ");
};

async function transcribeAudioGroq(audioPath) {
  console.log(`[TRANSCRIBE_AUDIO_GROQ] Called with audioPath: ${audioPath}`);
  if (!groq) {
    console.error("[TRANSCRIBE_AUDIO_GROQ] Groq client not initialized.");
    throw new Error("Groq client not initialized.");
  }
  try {
    // Using fs.createReadStream as per Groq documentation for audio files
    console.log(
      "[TRANSCRIBE_AUDIO_GROQ] Calling Groq API for transcription with stream..."
    );
    const startTimeTranscription = Date.now();
    console.log(
      `[TRANSCRIBE_AUDIO_GROQ] Starting transcription API call at ${startTimeTranscription}`
    );
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(audioPath), // Using stream
      model: "whisper-large-v3", // Reverted to original model
      response_format: "verbose_json", // Keeping verbose_json as it was in the last successful file state
      language: "zh",
    });
    const endTimeTranscription = Date.now();
    console.log(
      `[TRANSCRIBE_AUDIO_GROQ] Transcription API call completed at ${endTimeTranscription}. Duration: ${
        endTimeTranscription - startTimeTranscription
      }ms`
    );
    console.log("[TRANSCRIBE_AUDIO_GROQ] Groq API call completed.");

    const transcribedText =
      typeof transcription === "string"
        ? transcription.trim()
        : (transcription.text || "").trim();
    console.log(
      `[TRANSCRIBE_AUDIO_GROQ] Transcription result: "${transcribedText}"`
    );
    return transcribedText;
  } catch (error) {
    console.error("[TRANSCRIBE_AUDIO_GROQ] Groq transcription error:", error);
    throw new Error(`Audio transcription failed: ${error.message || error}`);
  }
}

async function getEnglishTranslationForUserText(textToTranslate) {
  if (!groq) throw new Error("Groq client not initialized.");
  if (!textToTranslate) return "No input to translate.";
  try {
    const messages = [
      {
        role: "user",
        content: `Translate the following Mandarin Chinese text to English, providing only the English translation: "${textToTranslate}"`,
      },
    ];
    const startTimeTranslation = Date.now();
    console.log(
      `[GET_ENGLISH_TRANSLATION] Starting translation API call at ${startTimeTranslation}`
    );
    const completion = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct", // Ensure model name is correct
      messages: messages,
      temperature: 1,
      max_tokens: 1024, // Check SDK for correct parameter name (max_tokens vs max_completion_tokens)
      top_p: 1,
      stream: false,
    });
    const endTimeTranslation = Date.now();
    console.log(
      `[GET_ENGLISH_TRANSLATION] Translation API call completed at ${endTimeTranslation}. Duration: ${
        endTimeTranslation - startTimeTranslation
      }ms`
    );
    let translation = completion.choices[0]?.message?.content?.trim() || "";
    if (translation.toLowerCase().startsWith("english translation:")) {
      translation = translation
        .substring(translation.toLowerCase().indexOf(":") + 1)
        .trim();
    }
    return translation || "Could not translate.";
  } catch (error) {
    console.error("Error translating user text:", error);
    return "Translation unavailable.";
  }
}

async function getAiResponseWithAudioSupabase(userText, chatContext = []) {
  if (!groq) throw new Error("Groq client not initialized.");
  let mandarinResponseText = "";
  let englishTranslation = "Translation not available.";
  let audioSupabaseUrl = null;

  const messages = [
    {
      role: "system",
      content:
        "You are a friendly Mandarin Chinese tutor. Respond in simple Mandarin Chinese (1-2 short sentences). After your Mandarin response, on a new line, provide the English translation of your Mandarin response, like this: English translation: [Your English translation here]",
    },
  ];

  // Use the provided chatContext
  chatContext.forEach((msg) => {
    // Adapt based on the structure of chatContext items
    // Assuming items have 'role' and 'hanzi' (or 'content' for user messages)
    if (msg.role === "user") {
      messages.push({ role: "user", content: msg.hanzi || msg.content || "" });
    } else if (msg.role === "assistant" || msg.role === "ai") {
      // Accept 'ai' as a role from frontend
      messages.push({
        role: "assistant",
        content: msg.hanzi || msg.content || "",
      });
    }
  });
  messages.push({ role: "user", content: userText });

  try {
    const startTimeAIResponse = Date.now();
    console.log(
      `[GET_AI_RESPONSE] Starting AI response API call at ${startTimeAIResponse}`
    );
    const completion = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: messages,
      temperature: 1,
      max_tokens: 1024,
      top_p: 1,
      stream: false,
    });
    const endTimeAIResponse = Date.now();
    console.log(
      `[GET_AI_RESPONSE] AI response API call completed at ${endTimeAIResponse}. Duration: ${
        endTimeAIResponse - startTimeAIResponse
      }ms`
    );

    const fullGroqTextOutput =
      completion.choices[0]?.message?.content?.trim() || "";
    console.log("Generated text:", fullGroqTextOutput);

    if (fullGroqTextOutput) {
      const lines = fullGroqTextOutput.split("\n");
      const mandarinParts = [];
      let englishPartFound = false;
      for (const line of lines) {
        const strippedLine = line.trim();
        if (!strippedLine) continue;
        if (strippedLine.toLowerCase().includes("english translation:")) {
          englishTranslation = strippedLine
            .substring(strippedLine.toLowerCase().indexOf(":") + 1)
            .trim();
          englishPartFound = true;
          break;
        } else if (!englishPartFound) {
          mandarinParts.push(strippedLine);
        }
      }
      if (mandarinParts.length > 0)
        mandarinResponseText = mandarinParts.join(" ");
      if (!mandarinResponseText && lines.length > 0) {
        mandarinResponseText = lines[0].trim();
        if (
          lines.length > 1 &&
          lines[1].toLowerCase().includes("english translation:")
        ) {
          englishTranslation = lines[1]
            .substring(lines[1].toLowerCase().indexOf(":") + 1)
            .trim();
        }
      }
    }
    if (!mandarinResponseText) {
      mandarinResponseText = "你好！";
      englishTranslation = "Hello!";
    }

    // Re-enabling gTTS audio generation and Supabase upload.
    // console.log("[DEBUG] Skipping gTTS audio generation and Supabase upload."); // Keep this commented
    // audioSupabaseUrl = null; // Keep this commented

    if (mandarinResponseText) {
      const tempAudioDir = path.join(os.tmpdir(), "audio_output_js");
      await fsPromises.mkdir(tempAudioDir, { recursive: true }); // Use fsPromises
      const gttsAudioFilenameTemp = `response_${uuidv4()}.mp3`;
      const gttsAudioFilepathTemp = path.join(
        tempAudioDir,
        gttsAudioFilenameTemp
      );

      // Using gtts library
      const tts = new gTTS(mandarinResponseText, "zh-cn");
      await new Promise((resolve, reject) => {
        tts.save(gttsAudioFilepathTemp, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      console.log(`gTTS audio generated: ${gttsAudioFilepathTemp}`);

      if (supabase) {
        try {
          const audioFileBuffer = await fsPromises.readFile(
            gttsAudioFilepathTemp
          ); // Use fsPromises
          const supabasePath = `${gttsAudioFilenameTemp}`; // File name as path in bucket

          const { data: uploadData, error: uploadError } =
            await supabase.storage
              .from(AUDIO_BUCKET_NAME)
              .upload(supabasePath, audioFileBuffer, {
                contentType: "audio/mpeg",
                upsert: false, // true to overwrite if exists, false to error
              });

          if (uploadError) throw uploadError;

          const { data: publicUrlData } = supabase.storage
            .from(AUDIO_BUCKET_NAME)
            .getPublicUrl(supabasePath);
          audioSupabaseUrl = publicUrlData?.publicUrl;
          console.log(`Audio uploaded to Supabase: ${audioSupabaseUrl}`);
        } catch (supabaseError) {
          console.error("Supabase audio upload failed:", supabaseError);
          audioSupabaseUrl = null;
        } finally {
          await fsPromises // Use fsPromises
            .unlink(gttsAudioFilepathTemp)
            .catch((e) => console.error("Failed to delete temp audio file", e));
        }
      } else {
        console.warn("Supabase client not initialized. Skipping audio upload.");
      }
    }
  } catch (error) {
    console.error("Overall error in getAiResponseWithAudioSupabase:", error);
    // Fallback response
    mandarinResponseText = "抱歉，出现了技术问题。";
    englishTranslation = "Sorry, there was a technical issue.";
    audioSupabaseUrl = null;
  }

  return {
    hanzi: mandarinResponseText,
    pinyin: getPinyinString(mandarinResponseText),
    english: englishTranslation,
    audio_url: audioSupabaseUrl,
  };
}

async function loadChatHistoryFromSupabase() {
  if (!supabase) {
    console.warn("Supabase client not initialized. Cannot load chat history.");
    return [];
  }
  try {
    const { data, error } = await supabase
      .from(CHAT_TABLE_NAME)
      .select("role, hanzi, pinyin, english, audio_url, created_at")
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error("Error loading chat history from Supabase:", error);
    return [];
  }
}

async function saveChatHistoryToSupabase(
  role,
  hanzi,
  pinyin,
  english,
  audio_url = null
) {
  if (!supabase) {
    console.warn("Supabase client not initialized. Cannot save chat history.");
    return;
  }
  try {
    const { error } = await supabase
      .from(CHAT_TABLE_NAME)
      .insert([{ role, hanzi, pinyin, english, audio_url }]);
    if (error) throw error;
  } catch (error) {
    console.error("Error saving chat history to Supabase:", error);
  }
}

exports.handler = async (event, context) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }
  if (!groq || !supabase) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error:
          "Server configuration error (Groq or Supabase client not initialized).",
      }),
    };
  }

  let tempUserAudioPath;

  try {
    const body = JSON.parse(event.body || "{}");
    const audioBase64 = body.audio_base64;
    const filename = body.filename || `user_audio_${uuidv4()}.webm`;
    const chat_context = body.chat_context || []; // Get chat_context from request

    if (!audioBase64) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "audio_base64 not found in request body",
        }),
      };
    }

    const audioBytes = Buffer.from(audioBase64, "base64");
    const tempUserAudioDir = path.join(os.tmpdir(), "user_audio_js");
    await fsPromises.mkdir(tempUserAudioDir, { recursive: true }); // Use fsPromises
    tempUserAudioPath = path.join(tempUserAudioDir, filename);
    await fsPromises.writeFile(tempUserAudioPath, audioBytes); // Use fsPromises
    console.log(`[HANDLER] User audio saved to: ${tempUserAudioPath}`);

    console.log("[HANDLER] Starting audio transcription...");
    const userTranscribedText = await transcribeAudioGroq(tempUserAudioPath);
    console.log(`[HANDLER] Transcription result: "${userTranscribedText}"`);

    if (!userTranscribedText) {
      console.log("[HANDLER] Transcription was empty. Returning early.");
      return {
        statusCode: 200,
        body: JSON.stringify({
          user_input: {
            hanzi: "无法转录音频。",
            pinyin: getPinyinString("无法转录音频。"),
            english: "Could not transcribe audio.",
          },
          ai_response: {
            hanzi: "抱歉，我没听清您说什么。",
            pinyin: getPinyinString("抱歉，我没听清您说什么。"),
            english: "Sorry, I didn't understand what you said.",
          },
          audio_url: null,
        }),
        headers: { "Content-Type": "application/json" },
      };
    }

    const userPinyin = getPinyinString(userTranscribedText);
    console.log("[HANDLER] Starting user text translation...");
    const userEnglishTranslation = await getEnglishTranslationForUserText(
      userTranscribedText
    );
    console.log(
      `[HANDLER] User text translated to English: "${userEnglishTranslation}"`
    );

    const userInputData = {
      hanzi: userTranscribedText,
      pinyin: userPinyin,
      english: userEnglishTranslation,
    };

    // Save current user input to DB
    console.log("[HANDLER] Saving user input to Supabase DB...");
    await saveChatHistoryToSupabase(
      "user",
      userTranscribedText,
      userPinyin,
      userEnglishTranslation
    );
    console.log("[HANDLER] User input saved to Supabase DB.");

    // Use chat_context from the request for the AI response generation.
    // Add the current user's transcribed text to this context for the current turn.
    const contextForAI = [
      ...chat_context,
      { role: "user", hanzi: userTranscribedText },
    ];

    console.log("[HANDLER] Starting AI response generation with audio...");
    const aiResponseData = await getAiResponseWithAudioSupabase(
      userTranscribedText,
      contextForAI
    );
    console.log("[HANDLER] AI response with audio generated.");

    // Save AI response to DB
    console.log("[HANDLER] Saving AI response to Supabase DB...");
    await saveChatHistoryToSupabase(
      "assistant",
      aiResponseData.hanzi,
      aiResponseData.pinyin,
      aiResponseData.english,
      aiResponseData.audio_url
    );
    console.log("[HANDLER] AI response saved to Supabase DB.");

    const finalResponsePayload = {
      user_input: userInputData,
      ai_response: {
        hanzi: aiResponseData.hanzi,
        pinyin: aiResponseData.pinyin,
        english: aiResponseData.english,
      },
      audio_url: aiResponseData.audio_url,
    };

    return {
      statusCode: 200,
      body: JSON.stringify(finalResponsePayload),
      headers: { "Content-Type": "application/json" },
    };
  } catch (error) {
    console.error("Error in /interact handler (JS):", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || "Internal Server Error" }),
      headers: { "Content-Type": "application/json" },
    };
  } finally {
    if (tempUserAudioPath) {
      await fsPromises // Use fsPromises
        .unlink(tempUserAudioPath)
        .catch((e) =>
          console.error("Failed to delete temp user audio file", e)
        );
    }
  }
};
