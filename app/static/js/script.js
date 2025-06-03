document.addEventListener("DOMContentLoaded", () => {
  const recordButton = document.getElementById("recordButton");
  const clearChatButton = document.getElementById("clearChatButton");
  const statusMessage = document.getElementById("statusMessage");
  const chatHistory = document.getElementById("chatHistory");
  const aiAudioPlayer = document.getElementById("aiAudioPlayer");
  document
    .getElementById("replayAllButton")
    .addEventListener("click", replayAllAudio);
  let mediaRecorder;
  let audioChunks = [];
  let isRecording = false;
  let allAiAudioUrls = []; // This might be less relevant if history is always fetched

  // API endpoints
  const API_BASE_URL = "/.netlify/functions"; // Using Netlify's default path

  initializeChat();

  async function initializeChat() {
    updateStatus("Loading chat history...");
    try {
      const response = await fetch(`${API_BASE_URL}/get_chat_history`);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: "Failed to load chat history" }));
        throw new Error(errorData.detail || "Unknown error loading history");
      }
      const history = await response.json();
      chatHistory.innerHTML = ''; // Clear any existing welcome message
      if (history.length === 0) {
        appendWelcomeMessage(); // Add welcome if history is empty
      } else {
        history.forEach(item => {
          // Adapt 'item' to the structure expected by appendMessage
          // The 'type' will be item.role. 'audio_url' is directly item.audio_url
          appendMessage({ 
            hanzi: item.hanzi, 
            pinyin: item.pinyin, 
            english: item.english, 
            audio_url: item.audio_url 
          }, item.role);
        });
      }
      updateStatus("Ready to help you learn");
    } catch (error) {
      console.error("Error initializing chat:", error);
      updateStatus(`Error loading history: ${error.message}`, true);
      appendWelcomeMessage(); // Show welcome message on error
    }
    // Scroll to bottom after loading history
    setTimeout(() => {
      chatHistory.scrollTo({ top: chatHistory.scrollHeight, behavior: "auto" });
    }, 100);
  }
  
  function appendWelcomeMessage() {
    // Only append if it doesn't exist
    if (!document.querySelector(".welcome-message")) {
      const welcomeDiv = document.createElement('div');
      welcomeDiv.classList.add("welcome-message");
      welcomeDiv.innerHTML = `
        <div class="welcome-icon">🇨🇳</div>
        <h3>Welcome to Mandarin AI Tutor!</h3>
        <p>Start speaking to practice your Mandarin. I'll help you with pronunciation, translation, and conversation.</p>
      `;
      chatHistory.appendChild(welcomeDiv);
    }
  }

  function updateStatus(message, isError = false) {
    statusMessage.textContent = message;
    statusMessage.style.color = isError
      ? "#ff6b6b"
      : "rgba(255, 255, 255, 0.8)";
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
        const filename = `user_audio_${new Date().toISOString()}.webm`;
        audioChunks = [];
        
        // Convert Blob to base64
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
          const base64Audio = reader.result.split(',')[1]; // Get base64 part
          await sendAudioToServer(base64Audio, filename);
        };
        reader.onerror = (error) => {
            console.error("Error converting audio blob to base64:", error);
            updateStatus("Error processing audio. Please try again.", true);
            // Reset UI
            recordButton.classList.remove("recording");
            recordButton.querySelector(".record-text").textContent = "Tap to speak";
        }
        
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start();
      isRecording = true;

      // Update UI for recording state
      recordButton.classList.add("recording");
      recordButton.querySelector(".record-text").textContent = "Recording...";
      updateStatus("Listening... Speak now");

      // Hide welcome message if it exists
      const welcomeMessage = document.querySelector(".welcome-message");
      if (welcomeMessage) {
        welcomeMessage.style.display = "none";
      }
    } catch (err) {
      console.error("Error accessing microphone:", err);
      updateStatus(
        "Could not access microphone. Please grant permission.",
        true
      );
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
      isRecording = false;

      // Reset UI
      recordButton.classList.remove("recording");
      recordButton.querySelector(".record-text").textContent = "Tap to speak";
      updateStatus("Processing your audio...");
    }
  }

  recordButton.addEventListener("click", () => {
    if (!isRecording) {
      startRecording();
    } else {
      stopRecording();
    }
  });

  async function replayAllAudio() {
    if (allAiAudioUrls.length === 0) {
      updateStatus("No AI audio to replay", true);
      setTimeout(() => {
        updateStatus("Ready to help you learn");
      }, 2000);
      return;
    }

    updateStatus(
      `Playing all AI responses (${allAiAudioUrls.length} messages)...`
    );

    for (let i = 0; i < allAiAudioUrls.length; i++) {
      try {
        // Ensure the audio URL has the correct path
        let audioUrl = allAiAudioUrls[i];
        // Audio URLs from Supabase will be absolute, so no prefixing needed
        // let audioUrl = allAiAudioUrls[i];
        // if (
        //   !audioUrl.startsWith("/static/audio/") &&
        //   !audioUrl.startsWith("http")
        // ) {
        //   audioUrl = "/static/audio/" + audioUrl;
        // }
        // aiAudioPlayer.src = audioUrl + `?t=${new Date().getTime()}`;
        
        aiAudioPlayer.src = allAiAudioUrls[i] + `?t=${new Date().getTime()}`; // Assuming Supabase URLs are absolute
        await new Promise((resolve, reject) => {
          aiAudioPlayer.onended = resolve;
          aiAudioPlayer.onerror = reject;
          aiAudioPlayer.play().catch(reject);
        });

        // Small pause between messages
        if (i < allAiAudioUrls.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (error) {
        console.error("Error playing audio:", error);
        break;
      }
    }

    updateStatus("Ready to help you learn");
  }

  clearChatButton.addEventListener("click", async () => {
    updateStatus("Clearing chat...");
    try {
      const response = await fetch(`${API_BASE_URL}/delete_chat_history`, {
        method: "POST",
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: "Failed to clear chat on server" }));
        throw new Error(errorData.detail || "Unknown server error during clear");
      }
      // Clear UI
      chatHistory.innerHTML = '';
      appendWelcomeMessage(); // Add back the welcome message
      allAiAudioUrls = []; // Clear local cache of audio URLs
      updateStatus("Chat cleared. Ready for new input.");
    } catch (error) {
      console.error("Error clearing chat:", error);
      updateStatus(`Error clearing chat: ${error.message}`, true);
    }
  });

  function appendMessage(data, type) {
    console.log("appendMessage called with:", { data, type });

    const welcomeMessage = document.querySelector(".welcome-message");
    if (welcomeMessage && chatHistory.children.length > 1) { // Remove if not the only child
        welcomeMessage.remove();
    } else if (welcomeMessage && type) { // Remove if adding any message
        welcomeMessage.remove();
    }


    const messageBubble = document.createElement("div");
    messageBubble.classList.add("response-bubble", `${type}-bubble`);
    // Create message content
    if (data.hanzi || data.pinyin) {
      // Mandarin content
      const mandarinBlock = document.createElement("div");
      mandarinBlock.classList.add("mandarin-block");

      if (data.pinyin) {
        const pinyinP = document.createElement("p");
        pinyinP.classList.add("pinyin");
        pinyinP.textContent = data.pinyin;
        mandarinBlock.appendChild(pinyinP);
      }

      if (data.hanzi) {
        const hanziP = document.createElement("p");
        hanziP.classList.add("hanzi");
        hanziP.textContent = data.hanzi;
        mandarinBlock.appendChild(hanziP);
      }

      messageBubble.appendChild(mandarinBlock);
    }

    if (data.english) {
      const englishP = document.createElement("p");
      englishP.classList.add("english");
      englishP.textContent = data.english;
      messageBubble.appendChild(englishP);
    }

    // Add replay button for AI audio messages
    if (type === "ai" && data.audio_url) {
      // Add this debug line
      console.log("Adding replay button for audio URL:", data.audio_url);

      // Store the audio URL for replay all functionality
      allAiAudioUrls.push(data.audio_url);
      console.log("Current allAiAudioUrls:", allAiAudioUrls);
      const replayButton = document.createElement("button");
      replayButton.classList.add("replay-btn");
      replayButton.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="5 3 19 12 5 21 5 3"></polygon>
    </svg>
  `;
      replayButton.title = "Replay this message";

      replayButton.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Visual feedback
        replayButton.style.transform = "scale(0.9)";
        setTimeout(() => {
          replayButton.style.transform = "scale(1)";
        }, 150);

        // Ensure the audio URL has the correct path
        let audioUrl = data.audio_url;
        // Audio URLs from Supabase will be absolute
        // let audioUrl = data.audio_url;
        // if (
        //   !audioUrl.startsWith("/static/audio/") &&
        //   !audioUrl.startsWith("http")
        // ) {
        //   audioUrl = "/static/audio/" + audioUrl;
        // }
        // aiAudioPlayer.src = audioUrl + `?t=${new Date().getTime()}`;
        aiAudioPlayer.src = data.audio_url + `?t=${new Date().getTime()}`; // Assuming Supabase URLs are absolute
        aiAudioPlayer
          .play()
          .catch((e) => console.error("Error playing audio:", e));
        updateStatus("Playing this AI response...");

        aiAudioPlayer.onended = () => {
          updateStatus("Ready to help you learn");
        };
      });
      messageBubble.appendChild(replayButton);
    }

    chatHistory.appendChild(messageBubble);

    // Smooth scroll to bottom
    setTimeout(() => {
      chatHistory.scrollTo({
        top: chatHistory.scrollHeight,
        behavior: "smooth",
      });
    }, 100);
  }

  function showLoadingMessage() {
    const loadingBubble = document.createElement("div");
    loadingBubble.classList.add("response-bubble", "ai-bubble");
    loadingBubble.id = "loading-message";

    const loadingContent = document.createElement("div");
    loadingContent.innerHTML = `
      <div class="loading-dots">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <p style="margin-top: 8px; font-size: 14px; opacity: 0.8;">AI is thinking...</p>
    `;

    loadingBubble.appendChild(loadingContent);
    chatHistory.appendChild(loadingBubble);

    // Scroll to bottom
    setTimeout(() => {
      chatHistory.scrollTo({
        top: chatHistory.scrollHeight,
        behavior: "smooth",
      });
    }, 100);
  }

  function removeLoadingMessage() {
    const loadingMessage = document.getElementById("loading-message");
    if (loadingMessage) {
      loadingMessage.remove();
    }
  }

  async function sendAudioToServer(audioBase64, audioFilename) {
    updateStatus("Transcribing and getting AI response...");
    showLoadingMessage();

    try {
      const response = await fetch(`${API_BASE_URL}/interact`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ 
          audio_base64: audioBase64,
          filename: audioFilename 
        }),
      });

      removeLoadingMessage();

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ detail: "Unknown server error" }));
        throw new Error(
          `Server error: ${response.status} - ${errorData.detail}`
        );
      }

      const data = await response.json();

      if (data.user_input) {
        appendMessage(data.user_input, "user");
      }

      if (data.ai_response) {
         setTimeout(() => { // Keep small delay for UX
            const aiResponseData = {
                ...data.ai_response,
                audio_url: data.audio_url, 
            };
            console.log("Adding AI response with data:", aiResponseData);
            appendMessage(aiResponseData, "ai");

            // Play audio if URL exists
            if (data.audio_url) {
                // allAiAudioUrls.push(data.audio_url); // Already handled by appendMessage if needed for replay all
                aiAudioPlayer.src = data.audio_url + `?t=${new Date().getTime()}`; // Assuming absolute Supabase URL
                updateStatus("Playing AI response...");
                aiAudioPlayer.play().catch(e => {
                    console.error("Error playing AI audio:", e);
                    updateStatus("Response ready. Tap to speak again.", true);
                });
                aiAudioPlayer.onended = () => {
                    updateStatus("Ready to help you learn");
                };
            } else {
                 updateStatus("Ready to help you learn");
            }
        }, 300);
      } else {
         updateStatus("Ready to help you learn");
      }
    } catch (error) {
      removeLoadingMessage();
      console.error("Error sending audio or processing response:", error);
      updateStatus(`Error: ${error.message}. Please try again.`, true);
      setTimeout(() => {
        updateStatus("Ready to help you learn");
      }, 3000);
    }
  }

  // Add keyboard shortcut for spacebar to record
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.repeat && e.target === document.body) {
      e.preventDefault();
      if (!isRecording) {
        startRecording();
      }
    }
  });

  document.addEventListener("keyup", (e) => {
    if (e.code === "Space" && e.target === document.body) {
      e.preventDefault();
      if (isRecording) {
        stopRecording();
      }
    }
  });

  // Prevent spacebar from scrolling when recording
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && isRecording && e.target === document.body) {
      e.preventDefault();
    }
  });
});
