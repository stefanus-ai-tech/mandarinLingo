const { createClient } = require("@supabase/supabase-js");
const dotenv = require("dotenv");

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CHAT_TABLE_NAME = "chat_messages"; // Ensure this matches

let supabase;
if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
} else {
    console.error("ERROR: SUPABASE_URL or SUPABASE_KEY not found for delete_chat_history. Supabase integration will be disabled.");
}

exports.handler = async (event, context) => {
    // Typically, DELETE method is used, but POST is also common for simplicity with some clients/proxies
    if (event.httpMethod !== 'POST' && event.httpMethod !== 'DELETE') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    if (!supabase) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error (Supabase client not initialized).' }) };
    }

    try {
        // Deletes all rows from the table. 
        // Ensure RLS is in place if this table could contain multi-user data.
        const { data, error } = await supabase
            .from(CHAT_TABLE_NAME)
            .delete()
            .neq('role', 'this_is_a_dummy_value_to_target_all_rows'); // Targets all rows

        if (error) {
            console.error("Supabase error deleting chat history:", error);
            throw error;
        }
        
        console.log("Chat history deletion executed (JS). Deleted data:", data);

        return {
            statusCode: 200, // Or 204 if no body content
            body: JSON.stringify({ message: 'Chat history deleted successfully.' }),
            headers: { 'Content-Type': 'application/json' }
        };
    } catch (error) {
        console.error("Error deleting chat history (JS):", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: `Failed to delete chat history: ${error.message || error}` }),
            headers: { 'Content-Type': 'application/json' }
        };
    }
};
