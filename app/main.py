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
import pypinyin
from pypinyin import Style
import aiofiles
from fastapi import Request as FastAPIRequest
import wave
import contextlib
import traceback
from gtts import gTTS # Import gTTS

load_dotenv()

CHAT_HISTORY_FILE = "chat_history.json"

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
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

if not GROQ_API_KEY:
    raise ValueError("GROQ_API_KEY not found in .env file.")

groq_client = Groq(api_key=GROQ_API_KEY)

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
                model="whisper-large-v3",
                response_format="text",
                language="zh"
            )
        transcription_text = ""
        if isinstance(transcription_obj, str):
            transcription_text = transcription_obj.strip()
        return transcription_text
    except Exception as e:
        print(f"Groq transcription error: {e}")
        raise HTTPException(status_code=500, detail=f"Audio transcription failed: {e}")

async def get_english_translation_for_user_text(text_to_translate: str) -> str:
    if not text_to_translate:
        return "No input to translate."
    try:
        messages = [
            {
                "role": "user",
                "content": f"Translate the following Mandarin Chinese text to English, providing only the English translation: \"{text_to_translate}\""
            }
        ]
        
        print(f"Translating user text: '{text_to_translate}'")
        completion = await asyncio.to_thread(
            groq_client.chat.completions.create,
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=messages,
            temperature=1,
            max_completion_tokens=1024,
            top_p=1,
            stream=True,
            stop=None,
        )
        
        translation_parts = []
        for chunk in completion:
            if chunk.choices[0].delta.content:
                translation_parts.append(chunk.choices[0].delta.content)
        
        translation = "".join(translation_parts).strip()
        print(f"Raw translation from Groq: '{translation}'")
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

def load_chat_history():
    if os.path.exists(CHAT_HISTORY_FILE):
        with open(CHAT_HISTORY_FILE, 'r', encoding='utf-8') as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                return []
    return []

def save_chat_history(history):
    with open(CHAT_HISTORY_FILE, 'w', encoding='utf-8') as f:
        json.dump(history, f, ensure_ascii=False, indent=4)

async def get_ai_response_with_audio(user_text: str, chat_history: list = None):
    try:
        mandarin_response_text = ""
        english_translation = "Translation not available."
        audio_filename_to_return = None

        messages = [
            {"role": "system", "content": "You are a friendly Mandarin Chinese tutor. Respond in simple Mandarin Chinese (1-2 short sentences). After your Mandarin response, on a new line, provide the English translation of your Mandarin response, like this: English translation: [Your English translation here]"},
        ]

        if chat_history:
            for message in chat_history:
                if message.get("role") == "user":
                    messages.append({"role": "user", "content": message.get("hanzi", "")})
                elif message.get("role") == "assistant":
                    messages.append({"role": "assistant", "content": message.get("hanzi", "")})

        messages.append({"role": "user", "content": user_text})
        
        print("Generating text response with Groq...")
        completion = await asyncio.to_thread(
            groq_client.chat.completions.create,
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=messages,
            temperature=1,
            max_completion_tokens=1024,
            top_p=1,
            stream=True,
            stop=None,
        )
        
        full_groq_text_output = ""
        for chunk in completion:
            if chunk.choices[0].delta.content:
                full_groq_text_output += chunk.choices[0].delta.content
        
        print(f"Generated text: {full_groq_text_output}")

        if full_groq_text_output:
            lines = full_groq_text_output.split('\n')
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
                    mandarin_parts.append(stripped_line)
            
            if mandarin_parts:
                mandarin_response_text = " ".join(mandarin_parts)
            
            if not mandarin_response_text and lines:
                mandarin_response_text = lines[0].strip()
                if len(lines) > 1 and "english translation:" in lines[1].lower():
                    english_translation = lines[1].split(":", 1)[1].strip()

        if not mandarin_response_text:
            mandarin_response_text = "你好！" 
            english_translation = "Hello!"
            print("Warning: Using fallback text response")

        print(f"Final Mandarin text: '{mandarin_response_text}'")
        print(f"Final English translation: '{english_translation}'")

        if mandarin_response_text:
            try:
                print("Generating audio with gTTS...")
                tts = gTTS(text=mandarin_response_text, lang='zh-cn')
                unique_id = uuid.uuid4()
                gtts_audio_filename = f"response_{unique_id}.mp3"
                gtts_audio_filepath = os.path.join(audio_output_dir, gtts_audio_filename)
                tts.save(gtts_audio_filepath)
                audio_filename_to_return = gtts_audio_filename
                print(f"gTTS audio saved successfully: {gtts_audio_filepath}")
            except Exception as gtts_e:
                print(f"gTTS audio generation failed: {gtts_e}")
                traceback.print_exc()
                audio_filename_to_return = None

        return {
            "hanzi": mandarin_response_text,
            "pinyin": get_pinyin(mandarin_response_text),
            "english": english_translation,
            "audio_url": f"/static/audio/{audio_filename_to_return}" if audio_filename_to_return else None,
        }

    except Exception as e:
        print(f"Overall error in get_ai_response_with_audio: {e}")
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
async def interact_with_ai(audio_file: UploadFile = File(...)):
    if not audio_file.content_type or not audio_file.content_type.startswith("audio/"):
        raise HTTPException(status_code=400, detail="Invalid audio file type or content type missing.")

    chat_history = load_chat_history()

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

        user_pinyin = get_pinyin(user_transcribed_text)
        user_english_translation = await get_english_translation_for_user_text(user_transcribed_text)

        user_input_data = {
            "hanzi": user_transcribed_text,
            "pinyin": user_pinyin,
            "english": user_english_translation
        }

        chat_history.append({"role": "user", "hanzi": user_transcribed_text, "english": user_english_translation})
        save_chat_history(chat_history)

        ai_response_data = await get_ai_response_with_audio(user_transcribed_text, chat_history)
        print(f"AI (Groq response package): {ai_response_data}")
        
        if not ai_response_data:
             ai_response_data = {
                "hanzi": "抱歉，AI响应处理失败。",
                "pinyin": get_pinyin("抱歉，AI响应处理失败。"),
                "english": "Sorry, AI response processing failed.",
                "audio_url": None
            }

        chat_history.append({"role": "assistant", "hanzi": ai_response_data.get("hanzi"), "english": ai_response_data.get("english")})
        save_chat_history(chat_history)

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

    except HTTPException as http_exc:
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
