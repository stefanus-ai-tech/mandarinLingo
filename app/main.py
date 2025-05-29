# python -m uvicorn app.main:app --reload --port 8001

import os
import uuid
import asyncio
import json # Added for parsing chat history
import base64
import mimetypes
import re
import struct
from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, HTTPException, Form # Added Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from groq import Groq
from google import genai as google_genai
from google.generativeai import types as google_types # Corrected import alias
import pypinyin # Ensure pypinyin is imported directly
from pypinyin import Style # Import Style from pypinyin
import aiofiles
from fastapi import Request as FastAPIRequest
import wave
import contextlib
import traceback
import pypinyin
from pypinyin import Style
from gtts import gTTS # Import gTTS

load_dotenv()

def save_binary_file(file_name, data):
    f = open(file_name, "wb")
    f.write(data)
    f.close()
    print(f"File saved to to: {file_name}")

def convert_to_wav(audio_data: bytes, mime_type: str) -> bytes:
    """Generates a WAV file header for the given audio data and parameters.

    Args:
        audio_data: The raw audio data as a bytes object.
        mime_type: Mime type of the audio data.

    Returns:
        A bytes object representing the WAV file header.
    """
    parameters = parse_audio_mime_type(mime_type)
    bits_per_sample = parameters["bits_per_sample"]
    sample_rate = parameters["rate"]
    num_channels = 1
    data_size = len(audio_data)
    bytes_per_sample = bits_per_sample // 8
    block_align = num_channels * bytes_per_sample
    byte_rate = sample_rate * block_align
    chunk_size = 36 + data_size  # 36 bytes for header fields before data chunk size

    # http://soundfile.sapp.org/doc/WaveFormat/

    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",          # ChunkID
        chunk_size,       # ChunkSize (total file size - 8 bytes)
        b"WAVE",          # Format
        b"fmt ",          # Subchunk1ID
        16,               # Subchunk1Size (16 for PCM)
        1,                # AudioFormat (1 for PCM)
        num_channels,     # NumChannels
        sample_rate,      # SampleRate
        byte_rate,        # ByteRate
        block_align,      # BlockAlign
        bits_per_sample,  # BitsPerSample
        b"data",          # Subchunk2ID
        data_size         # Subchunk2Size (size of audio data)
    )
    return header + audio_data

def parse_audio_mime_type(mime_type: str) -> dict[str, int | None]:
    """Parses bits per sample and rate from an audio MIME type string.

    Assumes bits per sample is encoded like "L16" and rate as "rate=xxxxx".

    Args:
        mime_type: The audio MIME type string (e.g., "audio/L16;rate=24000").

    Returns:
        A dictionary with "bits_per_sample" and "rate" keys. Values will be
        integers if found, otherwise None.
    """
    bits_per_sample = 16
    rate = 24000

    # Extract rate from parameters
    parts = mime_type.split(";")
    for param in parts: # Skip the main type part
        param = param.strip()
        if param.lower().startswith("rate="):
            try:
                rate_str = param.split("=", 1)[1]
                rate = int(rate_str)
            except (ValueError, IndexError):
                # Handle cases like "rate=" with no value or non-integer value
                pass # Keep rate as default
        elif param.startswith("audio/L"):
            try:
                bits_per_sample = int(param.split("L", 1)[1])
            except (ValueError, IndexError):
                pass # Keep bits_per_sample as default if conversion fails

    return {"bits_per_sample": bits_per_sample, "rate": rate}

# --- Configuration ---
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
# Changed to a model suitable for text generation
GEMINI_TEXT_MODEL_NAME = "models/gemini-2.0-flash-live-001" 
# This model is correct for the Live API audio synthesis
# GEMINI_LIVE_AUDIO_MODEL_NAME = "models/gemini-2.0-flash-live-001" 

if not GOOGLE_API_KEY:
    raise ValueError("GOOGLE_API_KEY not found in .env file.")
if not GROQ_API_KEY:
    raise ValueError("GROQ_API_KEY not found in .env file.")

# Configure the global API key for google-genai
google_genai.Client(api_key=GOOGLE_API_KEY)
groq_client = Groq(api_key=GROQ_API_KEY)

# Client for standard Gemini model interactions (text generation)
# Uses globally configured API key.
google_model_client = google_genai.Client() 
# Client specifically for Live API interactions
# The Live API quickstart script uses v1beta.
live_api_google_client = google_genai.Client(http_options={"api_version": "v1beta"})


app = FastAPI()
app.mount("/static", StaticFiles(directory="app/static"), name="static")
templates = Jinja2Templates(directory="app/templates")
audio_output_dir = "app/static/audio"
os.makedirs(audio_output_dir, exist_ok=True)

def get_pinyin(text_to_convert):
    if not text_to_convert:
        return ""
    return " ".join([item[0] for item in pypinyin.pinyin(text_to_convert, style=Style.TONE, heteronym=False)])

async def transcribe_audio_groq(audio_path: str) -> str:
    try:
        with open(audio_path, "rb") as file_obj:
            transcription_obj = await asyncio.to_thread(
                groq_client.audio.transcriptions.create,
                file=(os.path.basename(audio_path), file_obj.read()),
                model="whisper-large-v3", # Changed from whisper-large-v3-turbo as it's often more stable
                response_format="text",
                language="zh"
            )
        transcription_text = ""
        if isinstance(transcription_obj, str):
            transcription_text = transcription_obj.strip()
        # Groq's Transcription object does not have a .text attribute for response_format="text"
        # The object itself is the string.
        # elif hasattr(transcription_obj, 'text'): 
        #     transcription_text = transcription_obj.text.strip()
        return transcription_text
    except Exception as e:
        print(f"Groq transcription error: {e}")
        raise HTTPException(status_code=500, detail=f"Audio transcription failed: {e}")

async def get_english_translation_for_user_text(text_to_translate: str) -> str:
    if not text_to_translate:
        return "No input to translate."
    try:
        prompt = f"Translate the following Mandarin Chinese text to English, providing only the English translation: \"{text_to_translate}\""
        
        text_model = GEMINI_TEXT_MODEL_NAME 
        text_config = {"response_modalities": ["TEXT"]}
            
        print(f"Translating user text: '{text_to_translate}' with prompt: '{prompt}'")
        async with live_api_google_client.aio.live.connect(model=text_model, config=text_config) as session:
            await session.send_client_content(
                turns={"role": "user", "parts": [{"text": prompt}]}, 
                turn_complete=True
            )
            
            text_parts = []
            turn = session.receive()
            async for chunk in turn:
                if chunk.text is not None:
                    text_parts.append(chunk.text)
            
            translation = "".join(text_parts).strip()
            print(f"Raw translation from Gemini: '{translation}'")
            # Clean up potential "English translation:" prefix if the model includes it
            if translation.lower().startswith("english translation:"):
                translation = translation.split(":", 1)[1].strip()
            return translation if translation else "Could not translate."

    except Exception as e:
        print(f"Error translating user text: {e}")
        traceback.print_exc()
        return "Translation unavailable."

@contextlib.contextmanager
def wave_file_writer(filename, channels=1, rate=24000, sample_width=2):
    with wave.open(filename, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sample_width)
        wf.setframerate(rate)
        yield wf

async def async_enumerate(aiterable):
  n=0
  async for item in aiterable:
    yield n, item
    n+=1

async def get_gemini_response_with_audio(user_text: str, chat_history: list = None):
    try:
        mandarin_response_text = ""
        english_translation = "Translation not available."
        audio_filename_to_return = None

        # First, generate text response using a separate stable approach
        history_prompt_segment = ""
        if chat_history:
            history_prompt_segment = "Here is the previous conversation history:\n"
            for message in chat_history:
                role = "User" if message.get("role") == "user" else "AI Tutor"
                text_content = message.get("hanzi", "")
                if not text_content or text_content == "...":
                    text_content = message.get("english", "")

                if text_content and text_content != "...":
                    history_prompt_segment += f"{role}: {text_content}\n"
            history_prompt_segment += "\nNow, considering the history above:\n"

        prompt_for_text_generation = f"""
        You are a friendly Mandarin Chinese tutor.
        {history_prompt_segment}
        The user just said in Mandarin: "{user_text}"
        Respond to the user in simple Mandarin Chinese (1-2 short sentences), keeping the conversation history in mind.
        After your Mandarin response, on a new line, provide the English translation of your Mandarin response, like this:
        English translation: [Your English translation here]

        Example interaction if user says "你好吗？" (and there's no prior history):
        Mandarin response: 我很好，谢谢！你呢？
        English translation: I'm fine, thank you! And you?

        Now, respond to the user's input: "{user_text}"
        Ensure your output strictly follows this format: first the Mandarin response, then a newline, then "English translation: " followed by the translation.
        """
        
        # Step 1: Generate text using the more stable model
        print("Generating text response...")
        text_model = "gemini-2.0-flash-live-001"  # More stable for text
        
        try:
            text_config = {"response_modalities": ["TEXT"]}
            
            async with live_api_google_client.aio.live.connect(model=text_model, config=text_config) as session:
                await session.send_client_content(
                    turns={"role": "user", "parts": [{"text": prompt_for_text_generation}]}, 
                    turn_complete=True
                )
                
                text_parts = []
                turn = session.receive()
                async for chunk in turn:
                    if chunk.text is not None:
                        text_parts.append(chunk.text)
                        print(f'Text chunk: {chunk.text}')
                
                full_gemini_text_output = "".join(text_parts).strip()
                print(f"Generated text: {full_gemini_text_output}")
        
        except Exception as text_e:
            print(f"Text generation failed: {text_e}")
            full_gemini_text_output = ""

        # Parse the text response
        if full_gemini_text_output:
            lines = full_gemini_text_output.split('\n')
            mandarin_parts = []
            english_part_found = False
            
            for line in lines:
                stripped_line = line.strip()
                if not stripped_line: 
                    continue
                if "english translation:" in stripped_line.lower():
                    english_translation = stripped_line.split(":", 1)[1].strip()
                    english_part_found = True
                    break 
                elif not english_part_found: 
                    if "mandarin response:" in stripped_line.lower():
                        mandarin_parts.append(stripped_line.split(":", 1)[1].strip())
                    else:
                        mandarin_parts.append(stripped_line)
            
            if mandarin_parts:
                mandarin_response_text = " ".join(mandarin_parts)
            
            if not mandarin_response_text and lines:
                mandarin_response_text = lines[0].strip()
                if len(lines) > 1:
                    english_translation = lines[1].strip()

        if not mandarin_response_text:
            mandarin_response_text = "你好！" 
            english_translation = "Hello!"
            print("Warning: Using fallback text response")

        print(f"Final Mandarin text: '{mandarin_response_text}'")
        print(f"Final English translation: '{english_translation}'")

        # Step 2: Generate audio using the new streaming approach
        if mandarin_response_text: # Generate audio even for fallback text
            try:
                print("Generating audio...")
                model = "gemini-2.5-flash-preview-tts"
                contents = mandarin_response_text
                generate_content_config = google_genai.types.GenerateContentConfig(
                    temperature=1,
                    response_modalities=[
                        "audio",
                    ],
                    speech_config=google_genai.types.SpeechConfig(
                        voice_config=google_genai.types.VoiceConfig(
                            prebuilt_voice_config=google_genai.types.PrebuiltVoiceConfig(
                                voice_name="Zephyr"
                            )
                        )
                    ),
                )

                unique_id = uuid.uuid4()
                audio_file_name_temp = f"response_{unique_id}"
                audio_filepath_temp_base = os.path.join(audio_output_dir, audio_file_name_temp)
                
                file_index = 0
                for chunk in google_model_client.models.generate_content_stream(
                    model=model,
                    contents=contents,
                    config=generate_content_config,
                ):
                    if (
                        chunk.candidates is None
                        or chunk.candidates[0].content is None
                        or chunk.candidates[0].content.parts is None
                    ):
                        continue
                    if chunk.candidates[0].content.parts[0].inline_data and chunk.candidates[0].content.parts[0].inline_data.data:
                        current_file_name = f"{audio_filepath_temp_base}_{file_index}"
                        file_index += 1
                        inline_data = chunk.candidates[0].content.parts[0].inline_data
                        data_buffer = inline_data.data
                        file_extension = mimetypes.guess_extension(inline_data.mime_type)
                        if file_extension is None:
                            file_extension = ".wav"
                            data_buffer = convert_to_wav(inline_data.data, inline_data.mime_type)
                        
                        final_audio_path = f"{current_file_name}{file_extension}"
                        save_binary_file(final_audio_path, data_buffer)
                        audio_filename_to_return = os.path.basename(final_audio_path) # Only return the last one for now
                    else:
                        print(chunk.text) # This might print non-audio chunks if any

                if audio_filename_to_return:
                    print(f"Audio saved successfully: {os.path.join(audio_output_dir, audio_filename_to_return)}")
                else:
                    print("No substantial audio data generated from stream.")
                        
            except Exception as audio_e:
                print(f"Gemini audio generation failed: {audio_e}. Attempting gTTS fallback.")
                traceback.print_exc()
                try:
                    tts = gTTS(text=mandarin_response_text, lang='zh-cn')
                    unique_id = uuid.uuid4()
                    gtts_audio_filename = f"response_{unique_id}.mp3"
                    gtts_audio_filepath = os.path.join(audio_output_dir, gtts_audio_filename)
                    tts.save(gtts_audio_filepath)
                    audio_filename_to_return = gtts_audio_filename
                    print(f"gTTS audio saved successfully: {gtts_audio_filepath}")
                except Exception as gtts_e:
                    print(f"gTTS fallback also failed: {gtts_e}")
                    traceback.print_exc()
                    audio_filename_to_return = None # Ensure no audio URL is returned on failure

        return {
            "hanzi": mandarin_response_text,
            "pinyin": get_pinyin(mandarin_response_text),
            "english": english_translation,
            "audio_url": f"/static/audio/{audio_filename_to_return}" if audio_filename_to_return else None,
        }

    except Exception as e:
        print(f"Overall error in get_gemini_response_with_audio: {e}")
        traceback.print_exc()
        
        return {
            "hanzi": "抱歉，出现了技术问题。",
            "pinyin": get_pinyin("抱歉，出现了技术问题。"),
            "english": "Sorry, there was a technical issue.",
            "audio_url": None
        }

# --- API Endpoints ---
@app.get("/", response_class=HTMLResponse)
async def get_index(request: FastAPIRequest):
    return templates.TemplateResponse("index.html", {"request": request})

@app.post("/interact")
async def interact_with_ai(audio_file: UploadFile = File(...), chat_history_str: str = Form(None)):
    if not audio_file.content_type or not audio_file.content_type.startswith("audio/"):
        raise HTTPException(status_code=400, detail="Invalid audio file type or content type missing.")

    parsed_chat_history = []
    if chat_history_str:
        try:
            parsed_chat_history = json.loads(chat_history_str)
            if not isinstance(parsed_chat_history, list):
                print("Warning: chat_history_str was not a list, ignoring.")
                parsed_chat_history = []
        except json.JSONDecodeError:
            print("Warning: Could not decode chat_history_str, ignoring.")
            parsed_chat_history = []

    file_extension = ".webm" 
    if audio_file.filename:
        try:
            ext_part = audio_file.filename.split('.')[-1]
            if ext_part: 
                 file_extension = "." + ext_part.lower()
        except IndexError:
            pass 

    temp_audio_path = f"temp_user_audio_{uuid.uuid4()}{file_extension}"

    try:
        async with aiofiles.open(temp_audio_path, "wb") as f_temp:
            content_bytes = await audio_file.read()
            await f_temp.write(content_bytes)
        print(f"User audio saved to: {temp_audio_path}")

        user_transcribed_text = await transcribe_audio_groq(temp_audio_path)
        print(f"User (transcribed by Groq): {user_transcribed_text}")

        if not user_transcribed_text:
            fallback_user_hanzi = "无法转录音频。"
            fallback_user_pinyin = get_pinyin(fallback_user_hanzi)
            fallback_user_english = "Could not transcribe audio."
            
            fallback_ai_hanzi = "抱歉，我没听清您说什么。"
            fallback_ai_pinyin = get_pinyin(fallback_ai_hanzi)
            fallback_ai_english = "Sorry, I didn't understand what you said."
            
            print("Transcription failed or empty, returning fallback text-only response.")
            return JSONResponse(content={
                "user_input": {
                    "hanzi": fallback_user_hanzi,
                    "pinyin": fallback_user_pinyin,
                    "english": fallback_user_english
                },
                "ai_response": {
                    "hanzi": fallback_ai_hanzi,
                    "pinyin": fallback_ai_pinyin,
                    "english": fallback_ai_english
                },
                "audio_url": None 
            })

        # Get Pinyin and English translation for user's transcribed text
        user_pinyin = get_pinyin(user_transcribed_text)
        user_english_translation = await get_english_translation_for_user_text(user_transcribed_text)

        user_input_data = {
            "hanzi": user_transcribed_text,
            "pinyin": user_pinyin,
            "english": user_english_translation
        }

        ai_response_data = await get_gemini_response_with_audio(user_transcribed_text, parsed_chat_history)
        print(f"AI (Gemini response package): {ai_response_data}")
        
        # Ensure ai_response_data is not None and has expected keys
        if not ai_response_data: # Should be handled by fallback in get_gemini_response_with_audio
             ai_response_data = {
                "hanzi": "抱歉，AI响应处理失败。",
                "pinyin": get_pinyin("抱歉，AI响应处理失败。"),
                "english": "Sorry, AI response processing failed.",
                "audio_url": None
            }

        final_response = {
            "user_input": user_input_data,
            "ai_response": {
                "hanzi": ai_response_data.get("hanzi"),
                "pinyin": ai_response_data.get("pinyin"),
                "english": ai_response_data.get("english")
            },
            "audio_url": ai_response_data.get("audio_url")
        }
        
        return JSONResponse(content=final_response)

    except HTTPException as http_exc: # Re-raise HTTPExceptions directly
        raise http_exc
    except Exception as exc:
        print(f"Error in /interact endpoint: {exc}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        if os.path.exists(temp_audio_path):
            try:
                os.remove(temp_audio_path)
                print(f"Removed temporary user audio file: {temp_audio_path}")
            except Exception as e_remove:
                print(f"Error removing temporary file {temp_audio_path}: {e_remove}")
