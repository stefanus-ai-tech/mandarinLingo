import os
import json
import asyncio
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
CHAT_TABLE_NAME = "chat_messages" # Ensure this matches

supabase: Client = None
if SUPABASE_URL and SUPABASE_KEY:
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
else:
    print("ERROR: SUPABASE_URL or SUPABASE_KEY not found. Supabase integration will be disabled.")

async def handler(event, context):
    if event['httpMethod'] != 'POST': # Using POST for simplicity, could be DELETE
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
        # This deletes all rows from the table.
        # Be cautious with this in production if you have multiple users' data in the same table without a user_id filter.
        # For this app, assuming it's single-user context or all history is global.
        response = await asyncio.to_thread(
            supabase.table(CHAT_TABLE_NAME)
            .delete()
            .neq('role', 'this_is_a_dummy_value_to_target_all_rows') # Delete all rows
            .execute
        )
        
        # Supabase delete operation in supabase-py v2 returns a list of deleted records in `response.data`
        # and errors would raise an exception or be in `response.error` if not configured to raise.
        # We'll assume execute() raises an error or we check response.error if applicable for the version.
        # For supabase-py v2, a successful delete returns the deleted records.
        # If an error occurs, it typically raises an APIError.

        print(f"Chat history deletion executed. Response: {response.data}")

        return {
            'statusCode': 200, 
            'body': json.dumps({'message': 'Chat history deleted successfully.'}),
            'headers': {'Content-Type': 'application/json'}
        }
    except Exception as e:
        print(f"Error deleting chat history: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': f'Failed to delete chat history: {str(e)}'}),
            'headers': {'Content-Type': 'application/json'}
        }

# For local testing (optional)
# if __name__ == '__main__':
#     async def main_test():
#         mock_event = {'httpMethod': 'POST'} # or DELETE
#         mock_context = {}
#         response = await handler(mock_event, mock_context)
#         print(response)
#     asyncio.run(main_test())
