document.addEventListener("DOMContentLoaded", () => {
  const recordButton = document.getElementById("recordButton");
  const clearChatButton = document.getElementById("clearChatButton");
  const statusMessage = document.getElementById("statusMessage");
  const chatHistory = document.getElementById("chatHistory");
  const aiAudioPlayer = document.getElementById("aiAudioPlayer");

  let mediaRecorder;
  let audioChunks = [];
  let isRecording = false;

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: "audio/webm" }); // or 'audio/wav' or 'audio/m4a' depending on browser/encoder
        audioChunks = [];
        await sendAudioToServer(audioBlob);
        stream.getTracks().forEach((track) => track.stop()); // Release microphone
      };

      mediaRecorder.start();
      isRecording = true;
      recordButton.textContent = "🛑 Stop Recording";
      recordButton.classList.add("recording");
      statusMessage.textContent = "Recording... Speak now.";
      // Don't hide individual bubbles, new ones will be added
    } catch (err) {
      console.error("Error accessing microphone:", err);
      statusMessage.textContent =
        "Error: Could not access microphone. Please grant permission.";
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
      isRecording = false;
      recordButton.textContent = "🎤 Start Recording";
      recordButton.classList.remove("recording");
      statusMessage.textContent = "Processing audio...";
    }
  }

  recordButton.addEventListener("click", () => {
    if (!isRecording) {
      startRecording();
    } else {
      stopRecording();
    }
  });

  clearChatButton.addEventListener("click", () => {
    chatHistory.innerHTML = ""; // Clear all messages
    statusMessage.textContent = "Chat cleared. Ready for new input.";
  });

  function appendMessage(data, type) {
    const messageBubble = document.createElement("div");
    messageBubble.classList.add("response-bubble", `${type}-bubble`);

    const mandarinBlock = document.createElement("div");
    mandarinBlock.classList.add("mandarin-block");

    const pinyinP = document.createElement("p");
    pinyinP.classList.add("pinyin");
    pinyinP.textContent = data.pinyin || "...";

    const hanziP = document.createElement("p");
    hanziP.classList.add("hanzi");
    hanziP.textContent = data.hanzi || "...";

    mandarinBlock.appendChild(pinyinP);
    mandarinBlock.appendChild(hanziP);

    const englishP = document.createElement("p");
    englishP.classList.add("english");
    englishP.textContent = data.english || "...";

    messageBubble.appendChild(mandarinBlock);
    messageBubble.appendChild(englishP);

    chatHistory.appendChild(messageBubble);
    chatHistory.scrollTop = chatHistory.scrollHeight; // Scroll to the bottom
  }

  async function sendAudioToServer(audioBlob) {
    const formData = new FormData();
    formData.append("audio_file", audioBlob, "user_audio.webm");


    statusMessage.textContent = "Transcribing and getting AI response...";

    try {
      const response = await fetch("/interact", {
        method: "POST",
        body: formData,
      });

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
        appendMessage(data.ai_response, "ai");
      }

      if (data.audio_url) {
        aiAudioPlayer.src = data.audio_url + `?t=${new Date().getTime()}`; // Cache buster
        aiAudioPlayer
          .play()
          .catch((e) => console.error("Error playing audio:", e));
        statusMessage.textContent = "AI responded. Playing audio...";
        aiAudioPlayer.onended = () => {
          statusMessage.textContent = "Ready. Click record to speak again.";
        };
      } else {
        statusMessage.textContent =
          "AI responded (no audio). Ready for next input.";
      }
    } catch (error) {
      console.error("Error sending audio or processing response:", error);
      statusMessage.textContent = `Error: ${error.message}. Please try again.`;
    }
  }
});
