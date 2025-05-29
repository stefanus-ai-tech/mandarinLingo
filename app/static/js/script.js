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
  let allAiAudioUrls = [];

  // Initialize with welcome message
  initializeChat();

  function initializeChat() {
    updateStatus("Ready to help you learn");
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
        audioChunks = [];
        await sendAudioToServer(audioBlob);
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
        if (
          !audioUrl.startsWith("/static/audio/") &&
          !audioUrl.startsWith("http")
        ) {
          audioUrl = "/static/audio/" + audioUrl;
        }

        aiAudioPlayer.src = audioUrl + `?t=${new Date().getTime()}`;
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

  clearChatButton.addEventListener("click", () => {
    // Clear all messages except welcome
    chatHistory.innerHTML = `
    <div class="welcome-message">
      <div class="welcome-icon">🇨🇳</div>
      <h3>Welcome to Mandarin AI Tutor!</h3>
      <p>Start speaking to practice your Mandarin. I'll help you with pronunciation, translation, and conversation.</p>
    </div>
  `;

    // Clear stored audio URLs
    allAiAudioUrls = [];

    updateStatus("Chat cleared. Ready for new input");

    // Add a subtle animation
    chatHistory.style.opacity = "0.5";
    setTimeout(() => {
      chatHistory.style.opacity = "1";
    }, 200);
  });
  function appendMessage(data, type) {
    // Add this debug line at the very beginning
    console.log("appendMessage called with:", { data, type });

    // Remove welcome message if it's still there
    const welcomeMessage = document.querySelector(".welcome-message");
    if (welcomeMessage) {
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
        if (
          !audioUrl.startsWith("/static/audio/") &&
          !audioUrl.startsWith("http")
        ) {
          audioUrl = "/static/audio/" + audioUrl;
        }

        aiAudioPlayer.src = audioUrl + `?t=${new Date().getTime()}`;
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

  async function sendAudioToServer(audioBlob) {
    const formData = new FormData();
    formData.append("audio_file", audioBlob, "user_audio.webm");

    updateStatus("Transcribing and getting AI response...");
    showLoadingMessage();

    try {
      const response = await fetch("/interact", {
        method: "POST",
        body: formData,
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

      // Add user message
      if (data.user_input) {
        appendMessage(data.user_input, "user");
      }

      // Add AI response
      // Add AI response
      if (data.ai_response) {
        setTimeout(() => {
          // Make sure to pass the audio_url to the AI response
          const aiResponseData = {
            ...data.ai_response,
            audio_url: data.audio_url, // Ensure audio_url is included
          };
          console.log("Adding AI response with data:", aiResponseData);
          appendMessage(aiResponseData, "ai");
        }, 300); // Small delay for better UX
      }
      // Handle audio response
      // Handle audio response
      if (data.audio_url) {
        // Store the audio URL immediately when we get it
        allAiAudioUrls.push(data.audio_url);
        console.log("Stored audio URL:", data.audio_url);
        console.log("Total stored URLs:", allAiAudioUrls.length);

        // Ensure the audio URL has the correct path
        let audioUrl = data.audio_url;
        if (
          !audioUrl.startsWith("/static/audio/") &&
          !audioUrl.startsWith("http")
        ) {
          audioUrl = "/static/audio/" + audioUrl;
        }
        aiAudioPlayer.src = audioUrl + `?t=${new Date().getTime()}`;

        updateStatus("Playing AI response...");

        try {
          await aiAudioPlayer.play();

          aiAudioPlayer.onended = () => {
            updateStatus("Ready to help you learn");
          };
        } catch (playError) {
          console.error("Error playing audio:", playError);
          updateStatus("Response ready. Tap to speak again");
        }
      } else {
        updateStatus("Ready to help you learn");
      }
    } catch (error) {
      removeLoadingMessage();
      console.error("Error sending audio or processing response:", error);
      updateStatus(`Error: ${error.message}. Please try again.`, true);

      // Reset status after a few seconds
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
