const cedictModule = require('@tykok/cedict-dictionary');
const Gtts = require('gtts');
const { createClient } = require("@supabase/supabase-js");
const dotenv = require("dotenv");
const os = require("os");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const AUDIO_BUCKET_NAME = "audioresponses"; // From interact.js
const CHAR_AUDIO_SUBFOLDER = "char_tts_audio"; // New subfolder for character TTS

let supabase;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log("Supabase client initialized for get_char_info.");
} else {
  console.error(
    "get_char_info: SUPABASE_URL or SUPABASE_KEY not found. Supabase audio upload will be disabled."
  );
}

let Cedict = null;
if (cedictModule) {
  if (cedictModule.default) {
    Cedict = cedictModule.default;
  } else if (cedictModule.Cedict) {
    Cedict = cedictModule.Cedict;
  } else if (typeof cedictModule.getBySimplified === 'function') {
    Cedict = cedictModule;
  }
  if (Cedict) {
    console.log("Cedict module loaded for get_char_info. Type:", typeof Cedict);
    if (typeof Cedict.getBySimplified === 'function') {
      console.log("Cedict.getBySimplified is a function.");
    } else {
      console.error("CRITICAL: Cedict.getBySimplified is NOT a function. Type:", typeof Cedict.getBySimplified);
    }
  } else {
    console.error("CRITICAL: Cedict module FAILED to load.");
  }
}


function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
      headers: { 'Content-Type': 'application/json' },
    };
  }

  const character = event.queryStringParameters && event.queryStringParameters.char;

  if (!character || character.length !== 1) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'A single character must be provided via the "char" query parameter.' }),
      headers: { 'Content-Type': 'application/json' },
    };
  }

  if (!Cedict || typeof Cedict.getBySimplified !== 'function') {
    console.error("get_char_info: Cedict class or getBySimplified method not found.");
    return {
      statusCode: 503,
      body: JSON.stringify({ error: 'Dictionary service initialization failed.' }),
      headers: { 'Content-Type': 'application/json' },
    };
  }

  try {
    console.log(`get_char_info: Looking up character: "${character}"`);
    const entriesArray = Cedict.getBySimplified(character); // This returns an array
    console.log(`get_char_info: Raw entriesArray from Cedict.getBySimplified("${character}"):`, JSON.stringify(entriesArray, null, 2));

    let pinyin = 'N/A';
    let englishDefinition = 'No definition found.';

    if (Array.isArray(entriesArray) && entriesArray.length > 0) {
      const firstEntry = entriesArray[0]; // Get the first (and likely only) entry object
      if (firstEntry && typeof firstEntry === 'object') {
        pinyin = firstEntry.pinyin || 'N/A';
        // The 'english' property is an array of strings according to the log
        if (Array.isArray(firstEntry.english) && firstEntry.english.length > 0) {
          englishDefinition = firstEntry.english.join('; '); // Join multiple English definitions if they exist
        } else if (typeof firstEntry.english === 'string') { // Fallback if it's a string (though log shows array)
          englishDefinition = firstEntry.english;
        } else {
          englishDefinition = 'No definition found.';
        }
        console.log(`get_char_info: Parsed pinyin: "${pinyin}", english: "${englishDefinition}" for char "${character}"`);
      } else {
        console.warn(`get_char_info: First item in entriesArray is not a valid object for "${character}". Entry was:`, firstEntry);
      }
    } else {
      console.warn(`get_char_info: No entries found or invalid array for character "${character}". entriesArray was:`, entriesArray);
    }

    let audioUrl = null;
    if (supabase) { // Only attempt TTS and upload if Supabase is configured
      try {
        const gttsInstance = new Gtts(character, 'zh-CN');
        const audioBuffer = await streamToBuffer(gttsInstance.stream());
        
        const audioFilename = `${uuidv4()}.mp3`;
        const supabasePath = `${CHAR_AUDIO_SUBFOLDER}/${audioFilename}`;

        console.log(`get_char_info: Uploading char TTS audio to Supabase: ${supabasePath}`);
        const { data: uploadData, error: uploadError } =
          await supabase.storage
            .from(AUDIO_BUCKET_NAME)
            .upload(supabasePath, audioBuffer, {
              contentType: "audio/mpeg",
              upsert: false, // Don't upsert, always new file
            });

        if (uploadError) {
          console.error(`get_char_info: Supabase char audio upload failed for "${character}":`, uploadError);
          throw uploadError; // Let outer catch handle it or send null audioUrl
        }

        const { data: publicUrlData } = supabase.storage
          .from(AUDIO_BUCKET_NAME)
          .getPublicUrl(supabasePath);
        
        if (publicUrlData && publicUrlData.publicUrl) {
          audioUrl = publicUrlData.publicUrl;
          console.log(`get_char_info: Successfully uploaded char TTS for "${character}". URL: ${audioUrl}`);
        } else {
          console.error(`get_char_info: Failed to get public URL for Supabase object: ${supabasePath}`);
        }

      } catch (ttsOrUploadError) {
        console.error(`get_char_info: Error during TTS generation or Supabase upload for "${character}":`, ttsOrUploadError);
        // audioUrl will remain null
      }
    } else {
      console.warn(`get_char_info: Supabase not configured. Skipping TTS audio generation for character "${character}".`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        character,
        pinyin,
        english: englishDefinition,
        audioUrl, // This will be the Supabase URL or null
      }),
      headers: { 'Content-Type': 'application/json' },
    };
  } catch (error) {
    console.error(`get_char_info: General error processing character "${character}":`, error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal Server Error while fetching character info.' }),
      headers: { 'Content-Type': 'application/json' },
    };
  }
};
