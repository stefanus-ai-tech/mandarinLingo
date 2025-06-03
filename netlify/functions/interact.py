import os
import uuid
import asyncio
import json
import base64
import mimetypes
import re
import struct
from dotenv import load_dotenv
# from fastapi import File, UploadFile, HTTPException, Form # Not used directly in Netlify func like this
# from fastapi.responses import JSONResponse # Use standard json.dumps for response
from groq import Groq
import pypinyin
from pypinyin import Style
import aiofiles # May need to handle file uploads differently
import wave
import contextlib
import traceback
from gtts import gTTS
# Supabase client will be added here
from supabase import create_client, Client

load_dotenv()

# --- Configuration ---
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

supabase: Client = None
if SUPABASE_URL and SUPABASE_KEY:
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
else:
    print("ERROR: SUPABASE_URL or SUPABASE_KEY not found. Supabase integration will be disabled.")

if not GROQ_API_KEY:
    print("ERROR: GROQ_API_KEY not found.")
    # Groq client initialization will fail if key is missing

groq_client = Groq(api_key=GROQ_API_KEY)
audio_output_dir_temp = "/tmp/audio_output" # Use /tmp for serverless environments
os.makedirs(audio_output_dir_temp, exist_ok=True)
AUDIO_BUCKET_NAME = "audio_responses" # Replace with your actual bucket name
CHAT_TABLE_NAME = "chat_messages" # Replace with your actual table name

# Helper functions (get_pinyin, transcribe_audio_groq, get_english_translation_for_user_text, etc.)
# will be moved/adapted here.

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
        # In serverless, re-raise or return an error structure
        raise Exception(f"Audio transcription failed: {e}")


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
        completion = await asyncio.to_thread(
            groq_client.chat.completions.create,
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=messages,
            temperature=1,
            max_completion_tokens=1024,
            top_p=1,
            stream=False, # Simpler for serverless, or handle stream differently
            stop=None,
        )
        translation = completion.choices[0].message.content.strip()
        if translation.lower().startswith("english translation:"):
            translation = translation.split(":", 1)[1].strip()
        return translation if translation else "Could not translate."
    except Exception as e:
        print(f"Error translating user text: {e}")
        traceback.print_exc()
        return "Translation unavailable."

async def get_ai_response_with_audio_supabase(user_text: str, chat_history_from_db: list = None):
    # This function will be adapted to use Supabase for audio storage
    try:
        mandarin_response_text = ""
        english_translation = "Translation not available."
        audio_supabase_url = None

        messages = [
            {"role": "system", "content": "You are a friendly Mandarin Chinese tutor. Respond in simple Mandarin Chinese (1-2 short sentences). After your Mandarin response, on a new line, provide the English translation of your Mandarin response, like this: English translation: [Your English translation here]"},
        ]

        if chat_history_from_db:
            for message in chat_history_from_db:
                # Adapt based on how chat history is stored in Supabase
                if message.get("role") == "user":
                    messages.append({"role": "user", "content": message.get("hanzi", "")})
                elif message.get("role") == "assistant":
                    messages.append({"role": "assistant", "content": message.get("hanzi", "")})
        
        messages.append({"role": "user", "content": user_text})
        
        completion = await asyncio.to_thread(
            groq_client.chat.completions.create,
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=messages,
            temperature=1,
            max_completion_tokens=1024,
            top_p=1,
            stream=False, # Simpler for serverless
            stop=None,
        )
        
        full_groq_text_output = completion.choices[0].message.content.strip()
        print(f"Generated text: {full_groq_text_output}")

        if full_groq_text_output:
            lines = full_groq_text_output.split('\n')
            mandarin_parts = []
            english_part_found = False
            for line in lines:
                stripped_line = line.strip()
                if not stripped_line: continue
                if "english translation:" in stripped_line.lower():
                    english_translation = stripped_line.split(":", 1)[1].strip()
                    english_part_found = True
                    break 
                elif not english_part_found: 
                    mandarin_parts.append(stripped_line)
            if mandarin_parts: mandarin_response_text = " ".join(mandarin_parts)
            if not mandarin_response_text and lines:
                mandarin_response_text = lines[0].strip()
                if len(lines) > 1 and "english translation:" in lines[1].lower():
                    english_translation = lines[1].split(":", 1)[1].strip()
        
        if not mandarin_response_text:
            mandarin_response_text = "你好！" 
            english_translation = "Hello!"

        if mandarin_response_text:
            try:
                tts = gTTS(text=mandarin_response_text, lang='zh-cn')
                unique_id = uuid.uuid4()
                gtts_audio_filename_temp = f"response_{unique_id}.mp3"
                gtts_audio_filepath_temp = os.path.join(audio_output_dir_temp, gtts_audio_filename_temp)
                tts.save(gtts_audio_filepath_temp)
                
                if supabase:
                    try:
                        with open(gtts_audio_filepath_temp, 'rb') as f_audio:
                            # Use file name as path in bucket to ensure uniqueness
                            supabase_path = f"{gtts_audio_filename_temp}"
                            supabase.storage.from_(AUDIO_BUCKET_NAME).upload(
                                path=supabase_path,
                                file=f_audio,
                                file_options={"content-type": "audio/mpeg"} # Explicitly set content type
                            )
                        # Get public URL
                        audio_supabase_url = supabase.storage.from_(AUDIO_BUCKET_NAME).get_public_url(supabase_path)
                        print(f"Audio uploaded to Supabase: {audio_supabase_url}")
                    except Exception as supabase_e:
                        print(f"Supabase audio upload failed: {supabase_e}")
                        traceback.print_exc()
                        audio_supabase_url = None # Fallback if upload fails
                    finally:
                        if os.path.exists(gtts_audio_filepath_temp):
                            os.remove(gtts_audio_filepath_temp) # Clean up temp file
                else:
                    print("Supabase client not initialized. Skipping audio upload.")
                    # Fallback: maybe return a local path if testing without Supabase, but not ideal for Netlify
                    audio_supabase_url = None # Or some other placeholder if needed for non-Supabase flow

            except Exception as gtts_e:
                print(f"gTTS audio generation or Supabase upload failed: {gtts_e}")
                traceback.print_exc()
        
        return {
            "hanzi": mandarin_response_text,
            "pinyin": get_pinyin(mandarin_response_text),
            "english": english_translation,
            "audio_url": audio_supabase_url,
        }

    except Exception as e:
        print(f"Overall error in get_ai_response_with_audio_supabase: {e}")
        traceback.print_exc()
        return {
            "hanzi": "抱歉，出现了技术问题。",
            "pinyin": get_pinyin("抱歉，出现了技术问题。"),
            "english": "Sorry, there was a technical issue.",
            "audio_url": None
        }

async def load_chat_history_from_supabase():
    if not supabase:
        print("Supabase client not initialized. Cannot load chat history.")
        return []
    try:
        # response = supabase.table(CHAT_TABLE_NAME).select("role, hanzi, pinyin, english, audio_url, created_at").order('created_at', desc=False).execute()
        # Supabase-py v2 uses .select().order().execute()
        response = await asyncio.to_thread(
            supabase.table(CHAT_TABLE_NAME)
            .select("role, hanzi, pinyin, english, audio_url, created_at")
            .order('created_at', desc=False)
            .execute
        )
        return response.data if response.data else []
    except Exception as e:
        print(f"Error loading chat history from Supabase: {e}")
        traceback.print_exc()
        return []

async def save_chat_history_to_supabase(role: str, hanzi: str, pinyin: str, english: str, audio_url: str = None):
    if not supabase:
        print("Supabase client not initialized. Cannot save chat history.")
        return
    try:
        await asyncio.to_thread(
            supabase.table(CHAT_TABLE_NAME).insert({
                "role": role,
                "hanzi": hanzi,
                "pinyin": pinyin,
                "english": english,
                "audio_url": audio_url
            }).execute
        )
    except Exception as e:
        print(f"Error saving chat history to Supabase: {e}")
        traceback.print_exc()

async def handler(event, context):
    if event['httpMethod'] != 'POST':
        return {
            'statusCode': 405,
            'body': json.dumps({'error': 'Method Not Allowed'}),
            'headers': {'Content-Type': 'application/json'}
        }

    if not groq_client: # Check if Groq client failed to initialize
        return {
            'statusCode': 500,
            'body': json.dumps({'error': 'Server configuration error (Groq API key missing or invalid).'}),
            'headers': {'Content-Type': 'application/json'}
        }
    
    # Supabase client is checked before each Supabase operation within helper functions.

    # Handling file uploads in Netlify functions from form-data:
    # The body will be base64 encoded. We need to parse it.
    # This part is complex and might require a multipart parser library
    # or careful manual parsing if the structure is simple.
    # For now, let's assume the client sends audio data in a specific way,
    # or we simplify for a text-only interaction first.

    # Simplified: Assuming the audio file comes as base64 encoded string in the JSON body
    # This is a common way to send files to serverless functions if not using multipart/form-data directly
    # The client-side JS would need to be adapted to send it this way.
    # A more robust solution uses Netlify's ability to handle multipart/form-data,
    # but the Python runtime might need a library like `multipart` to parse it.

    try:
        body = json.loads(event.get('body', '{}'))
        # If sending raw audio bytes base64 encoded:
        # audio_data_base64 = body.get('audio_file_base64')
        # audio_content_type = body.get('audio_content_type', 'audio/webm')
        # if not audio_data_base64:
        #     return {'statusCode': 400, 'body': json.dumps({'error': 'Missing audio_file_base64'})}
        # audio_bytes = base64.b64decode(audio_data_base64)

        # --- TEMPORARY: Simulating audio upload for now ---
        # In a real scenario, you'd get the file from the event body.
        # Netlify's Python runtime doesn't directly give you a file object like FastAPI.
        # You often have to parse multipart/form-data from the event['body'] if it's a raw POST.
        # Or, the client sends base64 encoded data.
        
        # For this step, we'll assume the audio file handling needs more work
        # and focus on the text flow first, then integrate Supabase file upload.
        # Let's assume we get the audio file content somehow.
        # This is a MAJOR simplification for now.
        # The actual file handling from event['body'] for multipart/form-data is non-trivial.

        # For now, let's assume the client sends the audio file as part of the form data.
        # Netlify functions can receive multipart/form-data.
        # The `event['body']` will contain the raw HTTP request body.
        # We need a way to parse this. Python's `cgi` module's `FieldStorage` can sometimes work,
        # but it expects stdin and environment variables that might not be set up the same way.
        # A common approach is to use a library like `requests-toolbelt` for its `MultipartDecoder`.

        # Let's assume for now the client sends a base64 encoded audio string
        # This is simpler to handle in the serverless function initially.
        # The JavaScript client would need to be updated to do this.

        # --- Parsing multipart/form-data (Conceptual) ---
        # This part is complex and needs a robust parser.
        # For now, we'll simulate receiving the file path.
        # A real implementation would extract the file from `event['body']`.
        
        # This is a placeholder for actual file extraction logic
        # For local testing, we might read a dummy file.
        # In Netlify, this needs to parse event['body']
        
        # The `event` object for a POST request with `multipart/form-data` will have `isBase64Encoded: true`
        # and `body` will be the base64 encoded raw request body.
        # We need to decode it and then parse the multipart content.

        # This is a placeholder for robust multipart parsing
        # For now, we'll assume the audio file is written to a temp path by some magic
        # or the client sends base64 data directly in JSON.
        
        # Let's assume the client sends JSON with base64 audio for simplicity of this step
        content_type = event.get('headers', {}).get('content-type', '')
        
        temp_audio_path = f"/tmp/user_audio_{uuid.uuid4()}.webm" # Default extension

        if 'multipart/form-data' in content_type:
            # This is the hard part. We need to parse the multipart body.
            # For now, we'll skip proper parsing and return an error or a mock response.
            # This needs a library like `python-multipart` or `requests-toolbelt`.
            # Let's install `python-multipart` and try to use it.
            # Add 'python-multipart' to requirements.txt
            
            # Simplified approach: Assume the file is the only part and extract it.
            # This is NOT robust for general multipart.
            try:
                from multipart import tob
                from multipart.multipart import parse_options_header, MultipartParser

                body_bytes = base64.b64decode(event['body']) if event.get('isBase64Encoded', False) else event['body'].encode('utf-8')
                
                _, params = parse_options_header(content_type)
                boundary = params.get(b'boundary')
                if not boundary:
                    raise ValueError("Boundary not found in content-type")

                # Create a BytesIO stream for the parser
                from io import BytesIO
                stream = BytesIO(body_bytes)
                
                # Find the part corresponding to 'audio_file'
                # This is still a bit manual and error-prone
                # A full FieldStorage-like interface is better.
                
                # A more direct way if `python-multipart` is available:
                # This library is often used by FastAPI/Starlette under the hood.
                # However, using it directly in a serverless function needs careful setup.

                # Let's try a simpler path for now: assume the client sends base64 encoded audio in a JSON payload.
                # This avoids complex multipart parsing in the serverless function itself.

                # Reverting to JSON with base64 encoded audio for simplicity in this step
                if not event.get('body'):
                     return {'statusCode': 400, 'body': json.dumps({'error': 'Request body is empty'})}

                parsed_body = json.loads(event['body'])
                audio_base64 = parsed_body.get('audio_base64')
                filename = parsed_body.get('filename', f"user_audio_{uuid.uuid4()}.webm") # Get filename or generate
                
                if not audio_base64:
                    return {'statusCode': 400, 'body': json.dumps({'error': 'audio_base64 not found in request body'})}

                audio_bytes = base64.b64decode(audio_base64)
                temp_audio_path = f"/tmp/{filename}"
                async with aiofiles.open(temp_audio_path, "wb") as f_temp:
                    await f_temp.write(audio_bytes)
                print(f"User audio saved to: {temp_audio_path}")

            except Exception as e_parse:
                print(f"Error parsing multipart/form-data or base64 audio: {e_parse}")
                traceback.print_exc()
                return {'statusCode': 400, 'body': json.dumps({'error': f'Invalid request format: {e_parse}'})}
        
        else: # Fallback or other content types
            return {'statusCode': 400, 'body': json.dumps({'error': 'Unsupported content-type. Please send multipart/form-data or JSON with base64 audio.'})}


        user_transcribed_text = await transcribe_audio_groq(temp_audio_path)
        print(f"User (transcribed by Groq): {user_transcribed_text}")

        if not user_transcribed_text:
            # Simplified fallback response
            return {
                'statusCode': 200, # Or 400 if transcription failure is client's fault (bad audio)
                'body': json.dumps({
                    "user_input": {"hanzi": "无法转录音频。", "pinyin": get_pinyin("无法转录音频。"), "english": "Could not transcribe audio."},
                    "ai_response": {"hanzi": "抱歉，我没听清您说什么。", "pinyin": get_pinyin("抱歉，我没听清您说什么。"), "english": "Sorry, I didn't understand what you said."},
                    "audio_url": None 
                }),
                'headers': {'Content-Type': 'application/json'}
            }

        user_pinyin = get_pinyin(user_transcribed_text)
        user_english_translation = await get_english_translation_for_user_text(user_transcribed_text)

        user_input_data = {
            "hanzi": user_transcribed_text,
            "pinyin": user_pinyin,
            "english": user_english_translation
        }

        # Placeholder: Load chat history from Supabase
        chat_history_from_db = await load_chat_history_from_supabase()
        
        # Save user message to Supabase
        await save_chat_history_to_supabase(
            role="user",
            hanzi=user_transcribed_text,
            pinyin=user_pinyin, # Save pinyin for user too
            english=user_english_translation
        )
        
        # Add current user message to history for AI context
        # The chat history loaded from Supabase is already ordered by created_at
        current_turn_history = chat_history_from_db + [
            {"role": "user", "hanzi": user_transcribed_text, "pinyin": user_pinyin, "english": user_english_translation}
        ]

        ai_response_data = await get_ai_response_with_audio_supabase(user_transcribed_text, current_turn_history)
        
        if not ai_response_data: # Should not happen if get_ai_response handles errors
             ai_response_data = { # Fallback
                "hanzi": "抱歉，AI响应处理失败。", "pinyin": get_pinyin("抱歉，AI响应处理失败。"),
                "english": "Sorry, AI response processing failed.", "audio_url": None
            }

        # Save AI message to Supabase
        await save_chat_history_to_supabase(
            role="assistant",
            hanzi=ai_response_data.get("hanzi"),
            pinyin=ai_response_data.get("pinyin"), # Save pinyin for AI too
            english=ai_response_data.get("english"),
            audio_url=ai_response_data.get("audio_url")
        )

        final_response_payload = {
            "user_input": user_input_data,
            "ai_response": {
                "hanzi": ai_response_data.get("hanzi"),
                "pinyin": ai_response_data.get("pinyin"),
                "english": ai_response_data.get("english")
            },
            "audio_url": ai_response_data.get("audio_url") # This should be the Supabase public URL
        }
        
        return {
            'statusCode': 200,
            'body': json.dumps(final_response_payload),
            'headers': {'Content-Type': 'application/json'}
        }

    except Exception as exc:
        print(f"Error in /interact handler: {exc}")
        traceback.print_exc()
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(exc)}),
            'headers': {'Content-Type': 'application/json'}
        }
    finally:
        if os.path.exists(temp_audio_path) and 'temp_audio_path' in locals():
            try:
                os.remove(temp_audio_path)
                print(f"Removed temporary user audio file: {temp_audio_path}")
            except Exception as e_remove:
                print(f"Error removing temporary file {temp_audio_path}: {e_remove}")

# For local testing of the handler logic (optional)
# if __name__ == '__main__':
#     # Create a mock event
#     mock_event = {
#         'httpMethod': 'POST',
#         'headers': {'content-type': 'application/json'}, # or 'multipart/form-data; boundary=...'
#         # For JSON with base64:
#         'body': json.dumps({
#             'audio_base64': base64.b64encode(open('path_to_test_audio.webm', 'rb').read()).decode('utf-8'),
#             'filename': 'test_audio.webm'
#         }),
#         'isBase64Encoded': False # If body is JSON string; True if body is raw base64 of multipart
#     }
#     mock_context = {}
#     async def main_test():
#         response = await handler(mock_event, mock_context)
#         print(response)
#     asyncio.run(main_test())
