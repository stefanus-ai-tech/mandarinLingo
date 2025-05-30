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
app.use('/static', express.static(path.join(__dirname, 'static')));

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
        // Fixed: pinyin is an object, not a function
        return pinyin(textToConvert, {
            style: pinyin.STYLE_TONE,
            heteronym: false
        }).map(item => item[0]).join(' ');
    } catch (error) {
        console.error('Error generating pinyin:', error);
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

        formData.append('model', 'whisper-large-v3-turbo'); // Use turbo version
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
            model: "meta-llama/llama-4-scout-17b-16e-instruct", // More stable model
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

function loadChatHistory() {
    try {
        if (fsSync.existsSync(CHAT_HISTORY_FILE)) {
            const data = fsSync.readFileSync(CHAT_HISTORY_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error loading chat history:', error);
    }
    return [];
}

function saveChatHistory(history) {
    try {
        fsSync.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(history, null, 4), 'utf8');
    } catch (error) {
        console.error('Error saving chat history:', error);
    }
}

async function getAIResponseWithAudio(userText, chatHistory = null) {
    try {
        let mandarinResponseText = "";
        let englishTranslation = "Translation not available.";
        let audioFilenameToReturn = null;

        const messages = [
            {
                role: "system",
                content: "You are a friendly Mandarin Chinese tutor. Respond in simple Mandarin Chinese (1-2 short sentences). After your Mandarin response, on a new line, provide the English translation of your Mandarin response, like this: English translation: [Your English translation here]"
            }
        ];

        if (chatHistory) {
            for (const message of chatHistory.slice(-10)) { // Keep last 10 messages for context
                if (message.role === "user") {
                    messages.push({ role: "user", content: message.hanzi || "" });
                } else if (message.role === "assistant") {
                    messages.push({ role: "assistant", content: message.hanzi || "" });
                }
            }
        }

        messages.push({ role: "user", content: userText });

        console.log("Generating text response with Groq...");

        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "meta-llama/llama-4-scout-17b-16e-instruct", // More stable model
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
        console.log(`Generated text: ${fullGroqTextOutput}`);

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

        if (!mandarinResponseText) {
            mandarinResponseText = "你好！";
            englishTranslation = "Hello!";
            console.log("Warning: Using fallback text response");
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
            audio_url: audioFilenameToReturn ? `/static/audio/${audioFilenameToReturn}` : null
        };

    } catch (error) {
        console.error(`Overall error in getAIResponseWithAudio:`, error.response?.data || error.message);

        return {
            hanzi: "抱歉，出现了技术问题。",
            pinyin: getPinyin("抱歉，出现了技术问题。"),
            english: "Sorry, there was a technical issue.",
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
your-project/
├── templates/
│   └── index.html
├── static/
│   ├── css/
│   │   └── style.css
│   └── js/
│       └── script.js
└── server.js
            </pre>
        </body>
        </html>
        `);
    }
});

app.post('/interact', upload.single('audio_file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No audio file provided or invalid audio file type." });
        }

        const chatHistory = loadChatHistory();
        const tempAudioPath = req.file.path;

        console.log(`User audio saved to: ${tempAudioPath}`);
        console.log(`File details:`, {
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size
        });

        let userTranscribedText;
        try {
            userTranscribedText = await transcribeAudioGroq(tempAudioPath);
            console.log(`User (transcribed by Groq): ${userTranscribedText}`);
        } catch (transcriptionError) {
            console.error('Transcription error:', transcriptionError);
            userTranscribedText = "";
        }

        if (!userTranscribedText) {
            const fallbackUserHanzi = "无法转录音频。";
            const fallbackUserPinyin = getPinyin(fallbackUserHanzi);
            const fallbackUserEnglish = "Could not transcribe audio.";

            const fallbackAiHanzi = "抱歉，我没听清您说 什么。";
            const fallbackAiPinyin = getPinyin(fallbackAiHanzi);
            const fallbackAiEnglish = "Sorry, I didn't understand what you said.";

            console.log("Transcription failed or empty, returning fallback text-only response.");

            // Clean up temp file
            try {
                await fs.unlink(tempAudioPath);
            } catch (e) {
                console.error(`Error removing temp file: ${e}`);
            }

            return res.json({
                user_input: {
                    hanzi: fallbackUserHanzi,
                    pinyin: fallbackUserPinyin,
                    english: fallbackUserEnglish
                },
                ai_response: {
                    hanzi: fallbackAiHanzi,
                    pinyin: fallbackAiPinyin,
                    english: fallbackAiEnglish
                },
                audio_url: null
            });
        }

        const userPinyin = getPinyin(userTranscribedText);
        const userEnglishTranslation = await getEnglishTranslationForUserText(userTranscribedText);

        const userInputData = {
            hanzi: userTranscribedText,
            pinyin: userPinyin,
            english: userEnglishTranslation
        };

        // Update chat history
        chatHistory.push({
            role: "user",
            hanzi: userTranscribedText,
            english: userEnglishTranslation
        });
        saveChatHistory(chatHistory);

        let aiResponseData = await getAIResponseWithAudio(userTranscribedText, chatHistory);
        console.log(`AI (Groq response package): ${JSON.stringify(aiResponseData)}`);

        if (!aiResponseData) {
            aiResponseData = {
                hanzi: "抱歉，AI响应处理失败。",
                pinyin: getPinyin("抱歉，AI响应处理失败 。"),
                english: "Sorry, AI response processing failed.",
                audio_url: null
            };
        }

        // Update chat history with AI response
        chatHistory.push({
            role: "assistant",
            hanzi: aiResponseData.hanzi,
            english: aiResponseData.english
        });
        saveChatHistory(chatHistory);

        const finalResponse = {
            user_input: userInputData,
            ai_response: {
                hanzi: aiResponseData.hanzi,
                pinyin: aiResponseData.pinyin,
                english: aiResponseData.english
            },
            audio_url: aiResponseData.audio_url
        };

        // Clean up temp file
        try {
            await fs.unlink(tempAudioPath);
            console.log(`Removed temporary user audio file: ${tempAudioPath}`);
        } catch (removeError) {
            console.error(`Error removing temporary file ${tempAudioPath}: ${removeError}`);
        }

        res.json(finalResponse);

    } catch (error) {
        console.error(`Error in /interact endpoint: ${error}`);

        // Clean up temp file in case of error
        if (req.file && req.file.path) {
            try {
                await fs.unlink(req.file.path);
            } catch (e) {
                console.error(`Error removing temp file: ${e}`);
            }
        }

        res.status(500).json({ error: error.message });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large (max 25MB)' });
        }
    }

    if (error.message === 'Invalid audio file type') {
        return res.status(400).json({ error: 'Invalid audio file type. Please upload a valid audio file.' });
    }

    console.error('Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// Ensure temp upload directory exists
const tempUploadDir = 'temp_uploads';
if (!fsSync.existsSync(tempUploadDir)) {
    fsSync.mkdirSync(tempUploadDir, { recursive: true });
}

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Visit http://localhost:${PORT} to see the server`);
});

module.exports = app;