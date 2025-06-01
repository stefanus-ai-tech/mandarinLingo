const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const FormData = require('form-data');
const gtts = require('gtts');
const pinyin = require('pinyin'); // This is correct - pinyin is an object with methods
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8001;

// Configuration
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const CHAT_HISTORY_FILE = "chat_history.json";

if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY not found in .env file.");
}

// Middleware
app.use(express.json());
app.use('/app/static', express.static(path.join(__dirname, 'static')));

// Set up view engine for templates
app.set('view engine', 'html');
app.set('views', path.join(__dirname, 'templates'));

// Ensure audio output directory exists
const audioOutputDir = path.join(__dirname, 'static/audio');
if (!fsSync.existsSync(audioOutputDir)) {
    fsSync.mkdirSync(audioOutputDir, { recursive: true });
}

// Multer configuration for file uploads
const upload = multer({
    dest: 'temp_uploads/',
    limits: {
        fileSize: 25 * 1024 * 1024 // 25MB limit
    },
    fileFilter: (req, file, cb) => {
        // Accept various audio formats
        const allowedMimes = [
            'audio/webm',
            'audio/wav',
            'audio/mp3',
            'audio/mpeg',
            'audio/mp4',
            'audio/m4a',
            'audio/ogg',
            'audio/flac'
        ];

        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid audio file type'), false);
        }
    }
});

// Utility Functions
function saveBinaryFile(fileName, data) {
    fsSync.writeFileSync(fileName, data);
    console.log(`File saved to: ${fileName}`);
}

function getPinyin(textToConvert) {
    if (!textToConvert) return "";
    try {
        // Debug: Check what pinyin actually is
        console.log('Pinyin module type:', typeof pinyin);
        console.log('Pinyin module keys:', Object.keys(pinyin));

        // Try different approaches based on the pinyin package version
        let result;

        if (typeof pinyin === 'function') {
            // If pinyin is a function (older versions)
            result = pinyin(textToConvert, {
                style: pinyin.STYLE_TONE || 'tone',
                heteronym: false
            });
        } else if (pinyin.default && typeof pinyin.default === 'function') {
            // If it's an ES6 module with default export
            result = pinyin.default(textToConvert, {
                style: pinyin.default.STYLE_TONE || 'tone',
                heteronym: false
            });
        } else if (pinyin.pinyin && typeof pinyin.pinyin === 'function') {
            // If it has a pinyin method
            result = pinyin.pinyin(textToConvert, {
                style: pinyin.STYLE_TONE || 'tone',
                heteronym: false
            });
        } else {
            // Fallback: return empty string and log the issue
            console.error('Cannot determine how to use pinyin module');
            return "";
        }

        // Convert result to string
        if (Array.isArray(result)) {
            return result.map(item => Array.isArray(item) ? item[0] : item).join(' ');
        } else {
            return String(result || "");
        }

    } catch (error) {
        console.error('Error generating pinyin:', error);
        console.error('Stack trace:', error.stack);
        return "";
    }
}

async function transcribeAudioGroq(audioPath) {
    try {
        console.log(`Attempting to transcribe audio file: ${audioPath}`);

        // Check if file exists and get its stats
        const stats = await fs.stat(audioPath);
        console.log(`File size: ${stats.size} bytes`);

        if (stats.size === 0) {
            throw new Error('Audio file is empty');
        }

        // Read the audio file
        const audioBuffer = await fs.readFile(audioPath);

        // Create form data
        const formData = new FormData();

        // Determine file extension and set appropriate filename
        const fileExt = path.extname(audioPath).toLowerCase() || '.webm';
        const filename = `audio${fileExt}`;

        formData.append('file', audioBuffer, {
            filename: filename,
            contentType: 'audio/webm' // Groq accepts webm format
        });

        formData.append('model', 'whisper-large-v3'); // Use turbo version
        formData.append('response_format', 'text');
        formData.append('language', 'zh'); // Chinese language code
        formData.append('temperature', '0'); // More deterministic results

        console.log('Sending transcription request to Groq...');

        const response = await axios.post(
            'https://api.groq.com/openai/v1/audio/transcriptions',
            formData,
            {
                headers: {
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                    ...formData.getHeaders()
                },
                timeout: 30000, // 30 second timeout
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );

        console.log('Groq API response status:', response.status);

        // Handle different response formats
        let transcriptionText = '';
        if (typeof response.data === 'string') {
            transcriptionText = response.data.trim();
        } else if (response.data && response.data.text) {
            transcriptionText = response.data.text.trim();
        } else {
            console.log('Unexpected response format:', response.data);
            transcriptionText = '';
        }

        console.log(`Transcription result: "${transcriptionText}"`);
        return transcriptionText;

    } catch (error) {
        console.error('Groq transcription error details:', {
            message: error.message,
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data
        });

        if (error.response?.status === 400) {
            throw new Error(`Audio transcription failed: Bad request - ${error.response?.data?.error?.message || 'Invalid audio format or parameters'}`);
        } else if (error.response?.status === 401) {
            throw new Error('Audio transcription failed: Invalid API key');
        } else if (error.response?.status === 413) {
            throw new Error('Audio transcription failed: File too large');
        } else {
            throw new Error(`Audio transcription failed: ${error.message}`);
        }
    }
}

async function getEnglishTranslationForUserText(textToTranslate) {
    if (!textToTranslate) return "No input to translate.";

    try {
        const messages = [
            {
                role: "user",
                content: `Translate the following Mandarin Chinese text to English, providing only the English translation: "${textToTranslate}"`
            }
        ];

        console.log(`Translating user text: '${textToTranslate}'`);

        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model:"meta-llama/llama-4-scout-17b-16e-instruct",
            messages: messages,
            temperature: 0.3,
            max_tokens: 1024,
            top_p: 1,
            stream: false
        }, {
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        let translation = response.data.choices[0].message.content.trim();
        console.log(`Raw translation from Groq: '${translation}'`);

        if (translation.toLowerCase().startsWith("english translation:")) {
            translation = translation.split(":", 2)[1].trim();
        }

        return translation || "Could not translate.";
    } catch (error) {
        console.error(`Error translating user text:`, error.response?.data || error.message);
        return "Translation unavailable.";
    }
}

// Enhanced chat history management
function loadChatHistory() {
    try {
        if (fsSync.existsSync(CHAT_HISTORY_FILE)) {
            const data = fsSync.readFileSync(CHAT_HISTORY_FILE, 'utf8');
            const history = JSON.parse(data);

            // Ensure each entry has proper structure
            return history.map(entry => ({
                role: entry.role || 'user',
                hanzi: entry.hanzi || '',
                english: entry.english || '',
                pinyin: entry.pinyin || '',
                timestamp: entry.timestamp || new Date().toISOString(),
                topics: entry.topics || []
            }));
        }
    } catch (error) {
        console.error('Error loading chat history:', error);
    }
    return [];
}

function saveChatHistory(history) {
    try {
        // Keep only the last 50 messages to prevent file from growing too large
        const trimmedHistory = history.slice(-50);
        fsSync.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(trimmedHistory, null, 4), 'utf8');
    } catch (error) {
        console.error('Error saving chat history:', error);
    }
}

// Enhanced context analysis
function analyzeConversationContext(chatHistory) {
    if (!chatHistory || chatHistory.length === 0) {
        return {
            recentTopics: [],
            conversationStyle: 'greeting',
            learningLevel: 'beginner',
            lastUserMessage: null,
            contextSummary: ''
        };
    }

    // Get recent messages (last 10)
    const recentMessages = chatHistory.slice(-10);

    // Extract topics and patterns
    const topics = [];
    const userMessages = recentMessages.filter(msg => msg.role === 'user');
    const lastUserMessage = userMessages[userMessages.length - 1];

    // Simple topic extraction based on common Chinese topics
    const topicKeywords = {
        greeting: ['你好', '再见', '谢谢', '不客气'],
        family: ['爸爸', '妈妈', '家人', '儿子', '女儿'],
        food: ['吃', '饭', '菜', '水果', '喝'],
        weather: ['天气', '雨', '晴天', '冷', '热'],
        work: ['工作', '公司', '老板', '同事'],
        time: ['时间', '今天', '昨天', '明天', '现在'],
        location: ['在哪里', '去', '来', '这里', '那里']
    };

    for (const [topic, keywords] of Object.entries(topicKeywords)) {
        for (const message of recentMessages) {
            if (keywords.some(keyword => message.hanzi.includes(keyword))) {
                if (!topics.includes(topic)) {
                    topics.push(topic);
                }
            }
        }
    }

    // Determine conversation style
    let conversationStyle = 'casual';
    if (recentMessages.length <= 2) {
        conversationStyle = 'greeting';
    } else if (topics.includes('greeting')) {
        conversationStyle = 'polite';
    }

    // Generate context summary
    let contextSummary = '';
    if (recentMessages.length > 0) {
        const recentUserMessages = recentMessages.filter(msg => msg.role === 'user').slice(-3);
        const recentAIMessages = recentMessages.filter(msg => msg.role === 'assistant').slice(-3);

        if (recentUserMessages.length > 0) {
            contextSummary = `Recent conversation topics: ${topics.join(', ') || 'general conversation'}. `;
            contextSummary += `User has been discussing: ${recentUserMessages.map(msg => msg.english).join(', ')}.`;
        }
    }

    return {
        recentTopics: topics,
        conversationStyle: conversationStyle,
        learningLevel: 'beginner', // Could be enhanced with analysis
        lastUserMessage: lastUserMessage,
        contextSummary: contextSummary,
        messageCount: chatHistory.length
    };
}

// Enhanced system prompt generation
function generateContextualSystemPrompt(context) {
    let basePrompt = "You are a friendly Mandarin Chinese tutor. ";

    // Adjust based on conversation context
    if (context.messageCount === 0) {
        basePrompt += "This is the start of a new conversation. Greet the user warmly in Chinese. ";
    } else if (context.conversationStyle === 'greeting') {
        basePrompt += "Continue the greeting conversation naturally. ";
    } else {
        basePrompt += `Continue the conversation naturally. Recent topics have included: ${context.recentTopics.join(', ') || 'general conversation'}. `;
    }

    if (context.lastUserMessage) {
        basePrompt += `The user just said: "${context.lastUserMessage.english}". Respond appropriately to continue the conversation flow. `;
    }

    basePrompt += "Respond in simple Mandarin Chinese (1-2 short sentences). ";
    basePrompt += "Make your response relevant to what the user said and the conversation context. ";
    basePrompt += "After your Mandarin response, on a new line, provide the English translation of your Mandarin response, like this: English translation: [Your English translation here]";

    return basePrompt;
}

async function getAIResponseWithAudio(userText, chatHistory = null) {
    try {
        let mandarinResponseText = "";
        let englishTranslation = "Translation not available.";
        let audioFilenameToReturn = null;

        // Analyze conversation context
        const context = analyzeConversationContext(chatHistory);
        console.log('Conversation context:', context);

        // Generate contextual system prompt
        const systemPrompt = generateContextualSystemPrompt(context);
        console.log('System prompt:', systemPrompt);

        const messages = [
            {
                role: "system",
                content: systemPrompt
            }
        ];

        // Add relevant conversation history with better context preservation
        if (chatHistory && chatHistory.length > 0) {
            // Include more context for better flow, but limit to prevent token overflow
            const contextMessages = chatHistory.slice(-8); // Last 8 messages for better context

            for (const message of contextMessages) {
                if (message.role === "user") {
                    messages.push({
                        role: "user",
                        content: `${message.hanzi}${message.english ? ` (English: ${message.english})` : ''}`
                    });
                } else if (message.role === "assistant") {
                    messages.push({
                        role: "assistant",
                        content: message.hanzi || ""
                    });
                }
            }
        }

        // Add current user message
        messages.push({ role: "user", content: userText });

        console.log("Generating contextual response with Groq...");
        console.log("Message history length:", messages.length);

        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model:"meta-llama/llama-4-scout-17b-16e-instruct",
            messages: messages,
            temperature: 0.7,
            max_tokens: 1024,
            top_p: 1,
            stream: false
        }, {
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const fullGroqTextOutput = response.data.choices[0].message.content;
        console.log(`Generated contextual text: ${fullGroqTextOutput}`);

        if (fullGroqTextOutput) {
            const lines = fullGroqTextOutput.split('\n');
            const mandarinParts = [];
            let englishPartFound = false;

            for (const line of lines) {
                const strippedLine = line.trim();
                if (!strippedLine) continue;

                if (strippedLine.toLowerCase().includes("english translation:")) {
                    englishTranslation = strippedLine.split(":", 2)[1].trim();
                    englishPartFound = true;
                    break;
                } else if (!englishPartFound) {
                    mandarinParts.push(strippedLine);
                }
            }

            if (mandarinParts.length > 0) {
                mandarinResponseText = mandarinParts.join(" ");
            }

            if (!mandarinResponseText && lines.length > 0) {
                mandarinResponseText = lines[0].trim();
                if (lines.length > 1 && lines[1].toLowerCase().includes("english translation:")) {
                    englishTranslation = lines[1].split(":", 2)[1].trim();
                }
            }
        }

        // Contextual fallback responses
        if (!mandarinResponseText) {
            if (context.messageCount === 0) {
                mandarinResponseText = "你好！很高兴见到你！";
                englishTranslation = "Hello! Nice to meet you!";
            } else {
                mandarinResponseText = "我明白了。";
                englishTranslation = "I understand.";
            }
            console.log("Warning: Using contextual fallback text response");
        }

        console.log(`Final Mandarin text: '${mandarinResponseText}'`);
        console.log(`Final English translation: '${englishTranslation}'`);

        // Generate audio with gTTS
        if (mandarinResponseText) {
            try {
                console.log("Generating audio with gTTS...");
                const uniqueId = uuidv4();
                const gttsAudioFilename = `response_${uniqueId}.mp3`;
                const gttsAudioFilepath = path.join(audioOutputDir, gttsAudioFilename);

                const tts = new gtts(mandarinResponseText, 'zh-cn');
                await new Promise((resolve, reject) => {
                    tts.save(gttsAudioFilepath, (err) => {
                        if (err) {
                            console.error('gTTS error:', err);
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                });

                audioFilenameToReturn = gttsAudioFilename;
                console.log(`gTTS audio saved successfully: ${gttsAudioFilepath}`);
            } catch (gttsError) {
                console.error(`gTTS audio generation failed: ${gttsError}`);
                audioFilenameToReturn = null;
            }
        }

        return {
            hanzi: mandarinResponseText,
            pinyin: getPinyin(mandarinResponseText),
            english: englishTranslation,
            audio_url: audioFilenameToReturn ? `/static/audio/${audioFilenameToReturn}` : null,
            context: context // Include context in response for debugging
        };

    } catch (error) {
        console.error(`Overall error in getAIResponseWithAudio:`, error.response?.data || error.message);

        // Contextual error responses
        const context = analyzeConversationContext(chatHistory);
        let errorResponse = "抱歉，出现了技术问题。";
        let errorEnglish = "Sorry, there was a technical issue.";

        if (context.messageCount === 0) {
            errorResponse = "抱歉，我现在有点问题。你好 ！";
            errorEnglish = "Sorry, I'm having some issues right now. Hello!";
        }

        return {
            hanzi: errorResponse,
            pinyin: getPinyin(errorResponse),
            english: errorEnglish,
            audio_url: null
        };
    }
}

// Routes
app.get('/', (req, res) => {
    const templatePath = path.join(__dirname, 'templates/index.html');
    if (fsSync.existsSync(templatePath)) {
        res.sendFile(templatePath);
    } else {
        res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Template Not Found</title>
        </head>
        <body>
            <h1>Template Not Found</h1>
            <p>Could not find templates/index.html</p>
            <p>Please ensure your file structure matches:</p>
            <pre>
your-projec