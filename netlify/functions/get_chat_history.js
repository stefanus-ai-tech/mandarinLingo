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
    console.error("ERROR: SUPABASE_URL or SUPABASE_KEY not found for get_chat_history. Supabase integration will be disabled.");
}

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    if (!supabase) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error (Supabase client not initialized).' }) };
    }

    try {
        const { data, error } = await supabase
            .from(CHAT_TABLE_NAME)
            .select("role, hanzi, pinyin, english, audio_url, created_at")
            .order('created_at', { ascending: true });

        if (error) {
            console.error("Supabase error fetching chat history:", error);
            throw error;
        }
        
        const chatHistory = data || [];
        console.log(`Fetched chat history from Supabase (JS): ${chatHistory.length} messages.`);

        return {
            statusCode: 200,
            body: JSON.stringify(chatHistory),
            headers: { 'Content-Type': 'application/json' }
        };
    } catch (error) {
        console.error("Error fetching chat history (JS):", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: `Failed to fetch chat history: ${error.message || error}` }),
            headers: { 'Content-Type': 'application/json' }
        };
    }
};
