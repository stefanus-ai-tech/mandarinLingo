import os
import json
import asyncio
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
CHAT_TABLE_NAME = "chat_messages" # Ensure this matches the one in interact.py

supabase: Client = None
if SUPABASE_URL and SUPABASE_KEY:
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
else:
    print("ERROR: SUPABASE_URL or SUPABASE_KEY not found. Supabase integration will be disabled.")


async def handler(event, context):
    if event['httpMethod'] != 'GET':
        return {
            'statusCode': 405,
            'body': json.dumps({'error': 'Method Not Allowed'}),
            'headers': {'Content-Type': 'application/json'}
        }

    if not supabase:
        print("ERROR: Supabase client not initialized.")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': 'Server configuration error (Supabase client not initialized).'}),
            'headers': {'Content-Type': 'application/json'}
        }

    try:
        response = await asyncio.to_thread(
            supabase.table(CHAT_TABLE_NAME)
            .select("role, hanzi, pinyin, english, audio_url, created_at") # Select specific columns
            .order('created_at', desc=False) # Fetch in chronological order
            .execute
        )
        
        chat_history = response.data if response.data else []
        print(f"Fetched chat history from Supabase: {len(chat_history)} messages.")

        return {
            'statusCode': 200,
            'body': json.dumps(chat_history),
            'headers': {'Content-Type': 'application/json'}
        }
    except Exception as e:
        print(f"Error fetching chat history: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': f'Failed to fetch chat history: {str(e)}'}),
            'headers': {'Content-Type': 'application/json'}
        }

# For local testing (optional)
# if __name__ == '__main__':
#     async def main_test():
#         mock_event = {'httpMethod': 'GET'}
#         mock_context = {}
#         response = await handler(mock_event, mock_context)
#         print(response)
#     asyncio.run(main_test())
